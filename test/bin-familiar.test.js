import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { GRAPHICS_MARKERS, MULTIPLEXER_MARKERS } from '../src/render/term/capability.js';
import { CAPS, truncEnd } from '../src/render/term/hud.js';
import { adapterFor } from '../src/adapters/index.js';
import { projectKeyFor, displayProject } from '../src/bus/identity.js';
import { applyHookEvent } from '../src/bus/transaction.js';
import { parseIdentities } from '../src/bus/pins.js';
import { planCodexProjectSync, applyCodexProjectSync } from '../src/install/codex.js';
import { startTimeOf } from '../src/bus/proc.js';
import { PLACEHOLDER } from '../src/render/term/placeholder.js';
import { STATES, loadThemePack, parseThemePack } from 'familiar-theme';
import {
  appendHookTrace, makePrepareSprites, reportCosmeticError, sheetRowCaptions,
} from '../bin/familiar';

const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const ttyBin = fileURLToPath(new URL('fixtures/tty-familiar.mjs', import.meta.url));
const runTty = (args, options) => spawnSync(process.execPath, [ttyBin, ...args], options);
const themeFixture = fileURLToPath(new URL('../test/fixtures/theme-pack', import.meta.url));

// The engine ships no art: FAMILIAR_THEMES_DIR (src/bus/paths.js) redirects
// the SHIPPED themes root away from the repo's own themes/ (absent
// post-split) to this once-built fixture root, where the committed pack is
// installed under the "cats" id — the config default every test here relies
// on unless it says otherwise. Built once and reused; the pack is read-only.
const shippedThemesFixture = mkdtempSync(join(tmpdir(), 'familiar-shipped-themes-'));
cpSync(themeFixture, join(shippedThemesFixture, 'cats'), { recursive: true });

function env(over = {}) {
  return {
    ...process.env,
    FAMILIAR_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'familiar-cfg-')),
    FAMILIAR_STATE_DIR: mkdtempSync(join(tmpdir(), 'familiar-state-')),
    FAMILIAR_THEMES_DIR: shippedThemesFixture,
    ...over,
  };
}

test('hook trace appends lifecycle metadata without prompt or tool contents', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-hook-trace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'codex.jsonl');

  appendHookTrace(path, {
    timestamp: '2026-08-03T12:34:56.000Z',
    agent: 'codex',
    event: 'SessionStart',
    stdin: JSON.stringify({
      session_id: 's1', turn_id: 't1', hook_event_name: 'SessionStart', source: 'compact',
      prompt: 'secret prompt', tool_input: { command: 'secret command' },
    }),
    prev: { state: 'working' },
    next: { state: 'idle' },
  });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    timestamp: '2026-08-03T12:34:56.000Z',
    agent: 'codex',
    event: 'SessionStart',
    hook_event_name: 'SessionStart',
    source: 'compact',
    session_id: 's1',
    turn_id: 't1',
    prev_state: 'working',
    next_state: 'idle',
  });
});

// THE ERROR BOUNDARY. `familiar hook` runs on every tool call of the user's
// coding agent — an uncaught throw there must never surface as a non-zero
// exit or a stack trace, or a cosmetic layer would be able to break the tool
// it decorates. Here the throw is real and unforced: no scheme.json exists in
// the temp config dir, so loadTone() throws from deep inside context() —
// well before the locked transaction — and the top-level try/catch in
// bin/familiar is what has to catch it.
test('a hook invocation that throws internally still exits 0 and prints exactly one line to stderr', () => {
  const result = spawnSync(process.execPath, [bin, 'hook', 'UserPromptSubmit'], {
    input: JSON.stringify({ session_id: 's1', cwd: '/tmp' }),
    encoding: 'utf8',
    env: env(),
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');

  const lines = result.stderr.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, `expected exactly one stderr line, got:\n${result.stderr}`);
  assert.match(lines[0], /^familiar: no scheme at .* — run: familiar scheme set dark\|light$/);
});

test('hook rejects unknown flags before state work but remains cosmetic', () => {
  const e = env();
  const result = spawnSync(process.execPath, [bin, 'hook', 'SessionStart', '--bogus'], {
    encoding: 'utf8', env: e,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown option.*bogus/i);
  assert.doesNotMatch(result.stderr, /place it at the end/i);
  assert.match(result.stderr, /familiar hook --help/);
  assert.deepEqual(readdirSync(e.FAMILIAR_STATE_DIR), []);
});

test('statusline keeps malformed input cosmetic', () => {
  const result = spawnSync(process.execPath, [bin, 'statusline'], {
    input: '{not json', encoding: 'utf8', env: env(),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^familiar: /);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('reap failures are nonzero', () => {
  const result = spawnSync(process.execPath, [bin, 'reap'], {
    encoding: 'utf8', env: env(),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^familiar: no scheme at /);
});

test('an animation asset fault is one concise cosmetic line at the CLI boundary', () => {
  const lines = [];
  reportCosmeticError(
    new Error('animation reference sha256 changed for member "ginger-tabby"'),
    { write: (line) => lines.push(line) },
  );
  assert.deepEqual(lines, [
    'familiar: animation reference sha256 changed for member "ginger-tabby"\n',
  ]);
});

test('the sheet caption takes its colour from the member\'s first slot, and the column aligns', () => {
  const row = (id, slots) => ({ id, member: { slots, label: id } });
  const captions = sheetRowCaptions(
    [row('one', [1]), row('many', [1, 2, 3]), row('three', [3])],
    { mode: 'dark', satScale: 1 },
  );
  // [slots, swatch, label, id] — the caption's columns are 2+ spaces apart.
  const fields = (caption) => caption.trim().split(/\s\s+/);

  assert.equal(fields(captions[1])[0], '1,2,3', 'the column shows every slot the member holds');
  assert.equal(fields(captions[1])[1], fields(captions[0])[1], 'coloured by slots[0]...');
  assert.notEqual(fields(captions[1])[1], fields(captions[2])[1], '...not by its last slot');
  // One width for the whole column: a multi-slot member must not push every
  // other row's swatch and label out of alignment.
  assert.equal(new Set(captions.map((c) => c.indexOf(fields(c)[1]))).size, 1);
});

// Same boundary, a genuinely different throw site: `scheme set` with a bad
// mode throws out of assertTone/writeTone (src/config.js), never touching
// context() or the theme pack at all. Proves the boundary isn't tied to one
// particular call site.
test('scheme set with an invalid mode exits nonzero through the same boundary', () => {
  const result = spawnSync(process.execPath, [bin, 'scheme', 'set', 'neon'], {
    encoding: 'utf8',
    env: env(),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');

  const lines = result.stderr.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, `expected exactly one stderr line, got:\n${result.stderr}`);
  assert.match(lines[0], /^familiar: SchemeTone\.mode must be "dark" or "light", got: neon$/);
});

// The portable escape hatch this seam exists for: a bare machine with no
// scheme.json can still be told its scheme, entirely through the CLI, with
// no compositor and no bar involved.
test('familiar scheme set writes a scheme.json the CLI itself can then read back', () => {
  const runEnv = env();

  const set = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark', '--sat', '0.8'], {
    encoding: 'utf8',
    env: runEnv,
  });
  assert.equal(set.status, 0);
  assert.equal(set.stderr, '');
  assert.match(set.stdout, /^scheme dark · saturation 0\.8$/m);
  const wrote = set.stdout.split('\n').find((line) => line.startsWith('wrote '));
  assert.ok(wrote, `missing wrote line:\n${set.stdout}`);
  const schemePath = wrote.slice('wrote '.length);
  const written = JSON.parse(readFileSync(schemePath, 'utf8'));
  assert.deepEqual(written, { mode: 'dark', satScale: 0.8 });
});

test('statusline with --with and NO intent prints the wrapped output in full — no cat, no truncation', () => {
  // A session that has not hit its first hook, or was evicted, has no cat. The honest answer
  // is the wrapped status line ALONE and IN FULL: there is no cat to fit it against, so
  // nothing is dropped. The old code fitted it to a 4-row cat that did not exist, truncating
  // at line 4.
  const e = env();
  // Without a scheme, context() throws before we reach the no-intent branch — seed it, exactly
  // as the preview tests do.
  const seed = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e });
  assert.equal(seed.status, 0, seed.stderr);

  const withCmd = `printf 'L1\\nL2\\nL3\\nL4\\nL5\\nL6\\n'`;
  const out = spawnSync(process.execPath, [bin, 'statusline', '--with', withCmd], {
    input: JSON.stringify({}),   // no session_id → no record → no intent
    encoding: 'utf8',
    env: e,
  });
  assert.equal(out.stderr, '', 'the status line went through the error boundary');
  for (const line of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
    assert.match(out.stdout, new RegExp(`(^|\\n)${line}(\\n|$)`), `${line} was dropped`);
  }
  assert.doesNotMatch(out.stdout, /more line/, 'it truncated a status line that had no cat to truncate against');
  assert.doesNotMatch(out.stdout, /\u{10EEEE}/u, 'it invented placeholder cells for a cat that does not exist');
});

// A WRAPPED COMMAND IS NOT OBLIGED TO READ THE PAYLOAD. Most status-line scripts print
// and exit; claude-code's JSON is there for the ones that want it. When the command exits
// without draining stdin, the parent's handoff write fails with EPIPE -- and execSync
// reported that as the COMMAND having failed. The user's status line went blank and the
// boundary printed `familiar: spawnSync /bin/sh EPIPE`, for a command that had in fact
// run to completion, exited 0, and printed everything it meant to.
//
// THE PAYLOAD HERE IS DELIBERATELY LARGER THAN A PIPE BUFFER. At the few hundred bytes
// claude-code actually sends, the same defect is a RACE -- the parent usually wins the
// write, which is why this only ever surfaced on loaded CI runners, intermittently, and
// never once locally. A megabyte makes the parent lose the race every time, so this pins
// the contract instead of sampling it.
test('statusline --with renders a wrapped command that never reads its stdin', () => {
  const e = env();
  const seed = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e });
  assert.equal(seed.status, 0, seed.stderr);

  const out = spawnSync(process.execPath, [bin, 'statusline', '--with', `printf 'L1\nL2\n'`], {
    input: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
    encoding: 'utf8',
    env: e,
  });

  assert.equal(out.stderr, '', 'an undrained stdin was reported as the wrapped command failing');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /(^|\n)L1(\n|$)/);
  assert.match(out.stdout, /(^|\n)L2(\n|$)/);
});

// The other half of that boundary, and the reason the fix cannot simply swallow the error:
// a wrapped command that genuinely FAILS must still be reported as failed -- and it must be,
// even with the same undrained-stdin EPIPE riding along beside its exit status. `statusline`
// is a COSMETIC command, so the report is one stderr line and an exit-zero protocol kept
// intact; what must not happen is the failure passing silently, or being named EPIPE.
test('statusline --with reports a failing wrapped command, not its undrained stdin', () => {
  const e = env();
  const seed = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e });
  assert.equal(seed.status, 0, seed.stderr);

  // Two lines, so a raw interpolation of the command would break the boundary's
  // one-line promise -- the failing command is a shell string and may span lines.
  const failing = 'echo partial\nexit 3';
  const out = spawnSync(process.execPath, [bin, 'statusline', '--with', failing], {
    input: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
    encoding: 'utf8',
    env: e,
  });

  assert.equal(out.status, 0, 'a cosmetic command must not fail the tool it decorates');
  assert.equal(out.stdout, '', 'it printed a status line built from a failed command');
  const lines = out.stderr.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, `expected exactly one stderr line, got:\n${out.stderr}`);
  assert.equal(lines[0], `familiar: --with command exited 3: ${JSON.stringify(failing)}`);
  assert.doesNotMatch(out.stderr, /EPIPE/, 'the stdin handoff was reported instead of the real failure');
});

test('off statusline renders the HUD without familiar cells and gives wrapped text the full surface', () => {
  const e = env();
  mkdirSync(e.FAMILIAR_CONFIG_DIR, { recursive: true });
  mkdirSync(e.FAMILIAR_STATE_DIR, { recursive: true });
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: off\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'identities: []\n');
  writeFileSync(join(e.FAMILIAR_STATE_DIR, 'agents.json'), JSON.stringify({
    s1: {
      sessionId: 's1', projectKey: 'path:/tmp/api', project: 'api', remote: null,
      repoRoot: null, cwd: '/tmp/api', pid: process.pid, starttime: 1,
      state: 'working', updatedAt: 1,
    },
  }));

  const empty = spawnSync(process.execPath, [bin, 'statusline'], {
    input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8', env: e,
  });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stderr, '');
  assert.equal(empty.stdout.split('\n').filter((line) => line.length > 0).length, 4);
  assert.match(empty.stdout, /api/);
  assert.match(empty.stdout, /working/);
  assert.ok(!empty.stdout.includes(PLACEHOLDER), 'off mode emitted familiar placeholder cells');

  const withText = spawnSync(process.execPath, [bin, 'statusline', '--with', "printf 'L1\\nL2\\nL3\\nL4\\nL5\\nL6\\n'"], {
    input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8', env: e,
  });
  assert.equal(withText.status, 0, withText.stderr);
  assert.equal(withText.stderr, '');
  assert.equal(withText.stdout, 'L1\nL2\nL3\nL4\nL5\nL6\n');
  assert.doesNotMatch(withText.stdout, /\u{10EEEE}|\x1b\[/u);
});

// --- preview renders for real -----------------------------------------------
//
// The suite runs with no kitty in sight, so without forcing TERM this would only ever
// exercise the branch that prints nothing — and pass while preview was broken.

test('preview emits a graphics escape per state when the terminal supports it', () => {
  // TERM forces the positive branch; TMUX='' clears any real multiplexer we are
  // running under, which graphicsCapability() rejects before it accepts.
  const e = env({ TERM: 'xterm-kitty', TMUX: '' });

  // Without this, context() throws on the missing scheme.json, the error boundary
  // catches it, preview prints NOTHING, and a naive escape-count assertion passes
  // for precisely the wrong reason.
  const seed = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e });
  assert.equal(seed.status, 0, seed.stderr);

  // maxBuffer, and it is NOT a nicety. Six RGBA masters are ~810 KB on disk and
  // base64-encode to ~1.08 MB on the wire — past spawnSync's 1 MiB default, which
  // TRUNCATES stdout and sets status to null. The test then fails for a reason that
  // has nothing to do with preview.
  const out = runTty(['theme', 'preview', 'pip'], {
    encoding: 'utf8', env: e, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '', 'preview went through the error boundary instead of rendering');

  // COUNT FIRST CHUNKS, not escapes. transmit() splits a large PNG across many
  // \x1b_G sequences, so `>= STATES.length` raw escapes can be satisfied by ONE
  // sufficiently big cat — the assertion would pass while five states never rendered.
  // Only the opening chunk carries `a=T`, so there is exactly one per image.
  const rendered = out.stdout.split('\x1b_Ga=T').length - 1;
  assert.equal(rendered, STATES.length, `${rendered} states rendered, expected ${STATES.length}`);

  // AND AT THE THEME'S HEIGHT — read from the fixture's own theme.yaml, not copied into
  // this test. rows is one number for the theme now (surface-truth), so every state must carry
  // that same scalar. Reading the expected value keeps the acceptance promise honest: if the
  // live surface says the height is wrong and the human retunes the one theme number, this
  // parity check follows without creating a second number that can drift.
  const theme = parse(readFileSync(join(themeFixture, 'theme.yaml'), 'utf8'));
  assert.ok(Number.isInteger(theme.rows), `the fixture theme rows is not a scalar: ${JSON.stringify(theme.rows)}`);
  const heights = [...out.stdout.matchAll(/\x1b_Ga=T,f=100,q=2,r=(\d+),/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    Object.fromEntries(STATES.map((s, i) => [s, heights[i]])),
    Object.fromEntries(STATES.map((s) => [s, theme.rows])),
  );
});

// The negative half, and it is the one that makes the positive half mean anything: a
// terminal that cannot parse a graphics escape must receive NONE of one — not a
// truncated escape, not a fallback rendering, not a stray `\x1b_G`. The pose text
// still prints, so preview is still useful; only the cat is absent.
//
// KILLS: the `graphicsCapability(process.env)` gate deleted from preview — which every
// other assertion in this file, and the test above, would happily survive.
//
// SCRUB, do not merely override. env() spreads process.env so PATH survives — which
// also inherits KITTY_WINDOW_ID from the developer's real terminal. graphicsCapability()
// accepts on KITTY_WINDOW_ID as well as TERM, so `env({ TERM: 'xterm-256color' })` is
// STILL A KITTY, and this test passed in CI (no KITTY_WINDOW_ID) while failing on a
// kitty desktop — hiding the bug from the only machine that can see it. Overriding one
// of four accept-conditions is not a negative fixture.
//
// AND THE SCRUB LIST IS CAPABILITY.JS'S OWN. It used to be a hand-copied array here, with a
// comment claiming "a marker added to graphicsCapability() cannot be forgotten in exactly
// one place" -- which nothing made true. It was a mirror with nothing enforcing the
// mirror: adding, say, WEZTERM_PANE to graphicsCapability() and not to this list would
// silently restore the exact non-hermeticity described above, on precisely the machines
// that set the new variable. Now graphicsCapability() and this fixture read THE SAME
// ARRAY, so there is nowhere left to forget it.
//
// MULTIPLEXER_MARKERS goes too: a TMUX inherited from a real tmux session would make
// graphicsCapability() return none for the WRONG REASON -- rejected as a multiplexer,
// rather than because no accept condition matched -- and the test would pass while
// proving nothing about the accept path.
const noGraphics = () => {
  const e = env();
  for (const { name } of GRAPHICS_MARKERS) delete e[name];
  for (const name of MULTIPLEXER_MARKERS) delete e[name];
  e.TERM = 'xterm-256color';   // AFTER the scrub: TERM is itself a marker name
  return e;
};

test('preview on a terminal WITHOUT graphics prints the poses and no escape at all', () => {
  const e = noGraphics();
  const seed = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e });
  assert.equal(seed.status, 0, seed.stderr);

  const out = runTty(['theme', 'preview', 'pip'], {
    encoding: 'utf8', env: e, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '');
  assert.ok(!out.stdout.includes('\x1b_G'), 'no graphics escape may reach a terminal that cannot parse it');
  for (const state of STATES) {
    assert.ok(out.stdout.includes(`  ${state}: `), `the pose text for "${state}" still prints`);
  }
});

test('an incoming malformed animation reports its member fault and writes neither bus file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-malformed-animation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const poses = STATES.map((state) => `      ${state}: ${state} pose`).join('\n');
  const pack = parseThemePack(`
spec-version: 1
id: cats
label: Cats
members:
  - id: broken-cat
    asset-root: sprites/broken-cat
    label: Broken Cat
    slots: [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]
    persona: Broken.
    animation: { kind: clips }
    poses:
${poses}
`, dir);
  const memberDir = join(dir, 'sprites', 'broken-cat');
  mkdirSync(memberDir, { recursive: true });
  for (const state of STATES) {
    writeFileSync(join(memberDir, `${state}.png`), 'root');
  }
  pack.members.get('broken-cat').assetDirProof = 'filesystem';

  const paths = {
    agentsPath: join(dir, 'state', 'agents.json'),
    intentPath: join(dir, 'state', 'intent.json'),
    lockPath: join(dir, 'state', 'agents.lock'),
  };
  const namedFault = 'animation: member "broken-cat" manifest has unknown role "wobble"';
  let preflights = 0;
  const prepareSprites = makePrepareSprites({
    pack,
    catalog: parseIdentities('identities: []'),
    tone: { mode: 'dark', satScale: 1 },
  }, {
    loadAnimationMember: async () => { throw new Error(namedFault); },
    preflightKittyPrograms: () => { preflights++; },
  });

  await assert.rejects(
    applyHookEvent({
      event: 'UserPromptSubmit',
      stdin: JSON.stringify({ session_id: 'bad', cwd: '/repos/api' }),
      deps: {
        paths,
        tone: { mode: 'dark', satScale: 1 },
        motionPolicy: 'full',
        prepareSprites,
        adapter: adapterFor('claude-code'),
        gitContext: async () => ({ remote: 'github.com/me/api', repoRoot: '/repos/api' }),
        resolveAgentPid: () => 4242,
        startTimeOf: () => 123,
        isAlive: () => true,
        now: () => 1_000,
      },
    }),
    new RegExp(namedFault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(preflights, 0, 'preflight ran after validation failed');
  assert.equal(existsSync(paths.agentsPath), false);
  assert.equal(existsSync(paths.intentPath), false);
});

test('install pets --help documents the full, reduced, and off policies without loading config', () => {
  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--help'], {
    encoding: 'utf8',
    env: env(),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^  familiar install pets \[--out DIR\] \[--sync-projects\]$/m);
  assert.match(result.stdout, /--sync-projects.*identities\.yaml/);
  assert.match(result.stdout, /full.*canonical animation clips/);
  assert.match(result.stdout, /reduced.*static state roots/);
  assert.match(result.stdout, /off.*refuses installation/);
  assert.match(result.stdout, /Without --sync-projects.*does not change.*\[tui\] pet/);
});

test('pets refuses --sync-projects with --out before loading config or writing output', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-codex-out-'));
  const out = join(root, 'pets');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [bin, 'install', 'pets', '--sync-projects', '--out', out],
    { encoding: 'utf8', env: env() },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--sync-projects cannot be combined with --out/);
  assert.match(result.stderr, /familiar install pets --help/);
  assert.equal(existsSync(out), false);
});

function codexProjectSyncFixture(t) {
  const runEnv = env();
  const root = mkdtempSync(join(tmpdir(), 'familiar-codex-sync-'));
  const project = join(root, 'project');
  const codexHome = join(root, 'codex-home');
  mkdirSync(project);
  mkdirSync(codexHome);
  const initialized = spawnSync('git', ['init', '-q'], { cwd: project, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);

  runEnv.CODEX_HOME = codexHome;
  mkdirSync(runEnv.FAMILIAR_CONFIG_DIR, { recursive: true });
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: full\n');
  writeFileSync(
    join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'),
    `identities:\n  - path: ${project}\n    slot: 0\n`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { runEnv, project, codexHome };
}

test('pets --sync-projects creates a managed project config and excludes it locally', (t) => {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    readFileSync(join(project, '.codex', 'config.toml'), 'utf8'),
    '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.\n'
      + '[tui]\npet = "custom:familiar-pip"\n',
  );
  assert.match(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.codex\/config\.toml$/m);
  assert.equal(
    result.stdout,
    `wrote 1 pets to ${join(codexHome, 'pets')}\nsynced 1 project pet config\n`,
  );
});

test('pets --sync-projects migrates an untracked empty .codex marker', (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  writeFileSync(join(project, '.codex'), '');

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(project, '.codex', 'config.toml'), 'utf8'),
    /pet = "custom:familiar-pip"/,
  );
});

test('pets --sync-projects replaces only its managed config and does not duplicate the exclusion', (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const first = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(
    join(project, '.codex', 'config.toml'),
    '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.\n'
      + '[tui]\npet = "custom:familiar-old"\n',
  );

  const second = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(readFileSync(join(project, '.codex', 'config.toml'), 'utf8'), /custom:familiar-pip/);
  const exclusions = readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')
    .split('\n').filter((line) => line === '.codex/config.toml');
  assert.equal(exclusions.length, 1);
});

test('pets --sync-projects leaves a tracked project config untouched and prints the required setting', (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const configDir = join(project, '.codex');
  const configPath = join(configDir, 'config.toml');
  const original = '[features]\njs_repl = true\n';
  mkdirSync(configDir);
  writeFileSync(configPath, original);
  const added = spawnSync('git', ['add', '-f', '.codex/config.toml'], { cwd: project, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(configPath, 'utf8'), original);
  assert.match(result.stdout, new RegExp(`tracked project config left unchanged: ${configPath}`));
  assert.match(result.stdout, /add manually:\n\[tui\]\npet = "custom:familiar-pip"/);
  assert.doesNotMatch(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.codex\/config\.toml$/m);
});

test('pets --sync-projects leaves a tracked config symlink untouched as project convention', (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const configDir = join(project, '.codex');
  const configPath = join(configDir, 'config.toml');
  const target = join(project, 'tracked-codex.toml');
  const original = '[features]\njs_repl = true\n';
  mkdirSync(configDir);
  writeFileSync(target, original);
  symlinkSync('../tracked-codex.toml', configPath);
  const added = spawnSync('git', ['add', '-f', '.codex/config.toml'], { cwd: project, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(target, 'utf8'), original);
  assert.match(result.stdout, new RegExp(`tracked project config left unchanged: ${configPath}`));
  assert.doesNotMatch(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.codex\/config\.toml$/m);
});

test('pets --sync-projects refuses an unmanaged untracked config before writing pets', (t) => {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  const configDir = join(project, '.codex');
  const configPath = join(configDir, 'config.toml');
  const original = '[tui]\npet = "custom:mine"\n';
  mkdirSync(configDir);
  writeFileSync(configPath, original);
  const excludePath = join(project, '.git', 'info', 'exclude');
  const originalExclude = readFileSync(excludePath, 'utf8');

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`refusing unmanaged project config ${configPath}`));
  assert.equal(readFileSync(configPath, 'utf8'), original);
  assert.equal(readFileSync(excludePath, 'utf8'), originalExclude);
  assert.equal(existsSync(join(codexHome, 'pets')), false);
});

test('pets --sync-projects reports and skips an identity path that is not present', (t) => {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  const missing = join(project, 'not-cloned');
  writeFileSync(
    join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'),
    `identities:\n  - path: ${missing}\n    slot: 0\n`,
  );

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`skipped missing identity path: ${missing}`));
  assert.equal(existsSync(join(missing, '.codex', 'config.toml')), false);
  assert.equal(existsSync(join(codexHome, 'pets', 'familiar-pip', 'pet.json')), true);
});

test('pets --sync-projects refuses a symlinked .codex directory before writing outside the project', (t) => {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  const outside = join(project, '..', 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(project, '.codex'), 'dir');

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing symlinked Codex config directory/);
  assert.equal(existsSync(join(outside, 'config.toml')), false);
  assert.equal(existsSync(join(codexHome, 'pets')), false);
});

test('project sync refuses a config created after preflight before changing any project metadata', async (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const catalog = parseIdentities(readFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'utf8'));
  const pack = await loadThemePack(join(shippedThemesFixture, 'cats'));
  const plan = await planCodexProjectSync({ catalog, pack });
  const configDir = join(project, '.codex');
  const configPath = join(configDir, 'config.toml');
  const excludePath = join(project, '.git', 'info', 'exclude');
  const originalExclude = readFileSync(excludePath, 'utf8');
  mkdirSync(configDir);
  writeFileSync(configPath, '[tui]\npet = "custom:concurrent"\n');

  assert.throws(() => applyCodexProjectSync(plan), /project config changed after preflight/);
  assert.equal(readFileSync(configPath, 'utf8'), '[tui]\npet = "custom:concurrent"\n');
  assert.equal(readFileSync(excludePath, 'utf8'), originalExclude);
});

test('project sync refuses an empty marker tracked after preflight', async (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const marker = join(project, '.codex');
  const excludePath = join(project, '.git', 'info', 'exclude');
  writeFileSync(marker, '');
  const catalog = parseIdentities(readFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'utf8'));
  const pack = await loadThemePack(join(shippedThemesFixture, 'cats'));
  const plan = await planCodexProjectSync({ catalog, pack });
  const originalExclude = readFileSync(excludePath, 'utf8');
  const added = spawnSync('git', ['add', '-f', '.codex'], { cwd: project, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);

  assert.throws(() => applyCodexProjectSync(plan), /project config changed after preflight/);
  assert.equal(readFileSync(marker, 'utf8'), '');
  assert.equal(readFileSync(excludePath, 'utf8'), originalExclude);
});

test('project sync preserves an exclusion edited after preflight', async (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const catalog = parseIdentities(readFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'utf8'));
  const pack = await loadThemePack(join(shippedThemesFixture, 'cats'));
  const plan = await planCodexProjectSync({ catalog, pack });
  const excludePath = join(project, '.git', 'info', 'exclude');
  writeFileSync(excludePath, `${readFileSync(excludePath, 'utf8')}# concurrent edit\n`);

  applyCodexProjectSync(plan);
  const exclude = readFileSync(excludePath, 'utf8');
  assert.match(exclude, /^# concurrent edit$/m);
  assert.equal(exclude.split('\n').filter((line) => line === '.codex/config.toml').length, 1);
});

test('pets with motion off writes no install output and mutates neither pets nor config', () => {
  const runEnv = env();
  const codexHome = mkdtempSync(join(tmpdir(), 'familiar-codex-home-'));
  runEnv.CODEX_HOME = codexHome;
  mkdirSync(runEnv.FAMILIAR_CONFIG_DIR, { recursive: true });
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: off\n');
  const config = '# user-owned\n[tui]\npet = "custom:mine"\n';
  writeFileSync(join(codexHome, 'config.toml'), config);
  const out = join(codexHome, 'pets');

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--out', out], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'familiar: pets are disabled while motion is off; set motion to full or reduced to install Codex pets\n');
  assert.equal(existsSync(out), false);
  assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), config);
});

test('pets gates motion off before loading unrelated install inputs', () => {
  const runEnv = env();
  mkdirSync(runEnv.FAMILIAR_CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(runEnv.FAMILIAR_CONFIG_DIR, 'config.yaml'),
    'theme: missing-theme\nmotion: off\n',
  );
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'scheme.json'), '{invalid json');
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'identities: [unterminated');
  const out = join(mkdtempSync(join(tmpdir(), 'familiar-pets-off-')), 'pets');

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--out', out], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'familiar: pets are disabled while motion is off; set motion to full or reduced to install Codex pets\n');
  assert.equal(existsSync(out), false);
});

test('pets writes explicit Codex tracks without changing either Codex selection', (t) => {
  const runEnv = env();
  const codexHome = mkdtempSync(join(tmpdir(), 'familiar-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'familiar-codex-project-'));
  const projectCodex = join(project, '.codex');
  mkdirSync(projectCodex, { recursive: true });
  const projectConfig = '[tui]\npet = "custom:project-choice"\n';
  writeFileSync(join(projectCodex, 'config.toml'), projectConfig);
  t.after(() => {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  const out = join(codexHome, 'generated');
  runEnv.CODEX_HOME = codexHome;
  mkdirSync(runEnv.FAMILIAR_CONFIG_DIR, { recursive: true });
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: full\n');
  const config = '# no pet selected by familiar\n';
  writeFileSync(join(codexHome, 'config.toml'), config);

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--out', out], {
    encoding: 'utf8', env: runEnv, cwd: project, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^wrote 1 pets /);
  assert.match(result.stdout, /\[tui\] pet = "custom:familiar-<member>"/);
  assert.match(result.stdout, /user-wide: .*config\.toml/);
  assert.match(result.stdout, /project \(trusted\): <project>\/\.codex\/config\.toml/);
  assert.equal(readFileSync(join(projectCodex, 'config.toml'), 'utf8'), projectConfig);
  const manifest = JSON.parse(readFileSync(join(out, 'familiar-pip', 'pet.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.animations).sort(), [
    'failed', 'failed-root-hold', 'idle', 'review', 'review-root-hold', 'running', 'waiting',
  ]);
  assert.equal(existsSync(join(out, 'familiar-pip', 'assets', 'sheet.png')), true);
  assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), config);
});

// --- the native HUD --------------------------------------------------------

// ONE env for both commands. env() mints a fresh temp config dir per call, so calling it
// twice would write the scheme into a directory the status line never reads.
function statuslineEnv() {
  const e = env();
  const seeded = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], {
    encoding: 'utf8', env: e,
  });
  assert.equal(seeded.status, 0, `scheme set failed: ${seeded.stderr}`);
  return e;
}

const statusline = (e, args, payload) => spawnSync(process.execPath, [bin, 'statusline', ...args], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  encoding: 'utf8',
  env: e,
});

// SEED agents.json DIRECTLY. Firing a real `familiar hook` cannot work here and is unsafe:
//
//   1. transaction.js:124 calls resolveAgentPid(), which requires an ancestor with
//      comm === 'claude' AND a controlling tty. `node --test` has none, so the hook throws.
//   2. bin/familiar's error boundary converts that throw to EXIT 0 plus one stderr line --
//      so a status-only assertion would accept total failure and the test would seed nothing.
//   3. Worse, when the suite IS run under a real Claude session, resolveAgentPid SUCCEEDS and
//      emit() writes graphics escapes to /proc/<claude>/fd/1 -- the developer's live terminal.
//      A test that scribbles on the terminal running it is not a test.
//
// The record shape is transaction.js:163-174. pid/starttime are this process's, so nothing
// downstream can mistake the record for a dead session's.
function seedBus(e, sessionId, { state = 'working', cwd = process.cwd() } = {}) {
  const record = {
    sessionId,
    projectKey: projectKeyFor({ remote: null, repoRoot: cwd, cwd }),
    project: displayProject({ repoRoot: cwd, cwd }),
    remote: null,
    repoRoot: cwd,
    cwd,
    pid: process.pid,
    starttime: startTimeOf(process.pid),
    state,
    updatedAt: Date.now(),
  };
  writeFileSync(join(e.FAMILIAR_STATE_DIR, 'agents.json'), JSON.stringify({ [sessionId]: record }));
  return record;
}

// The trap this guards: bin/familiar's no-intent branch printed `rawOutput ?? ''`. With
// --with gone that is null, so a naive edit prints a BLANK STATUS LINE for every session that
// is not yet on the bus -- which is every session, until its first hook fires.
test('statusline with no --with prints the HUD for a session not on the bus', () => {
  const result = statusline(statuslineEnv(), [], {
    session_id: 'not-on-the-bus',
    cwd: process.cwd(),
    model: { display_name: 'Opus 4.8 (1M context)' },
    context_window: { used_percentage: 22 },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 4, `expected four HUD rows, got:\n${result.stdout}`);
  const expectedProject = truncEnd(
    displayProject({ repoRoot: process.cwd(), cwd: process.cwd() }),
    CAPS.project,
  );
  assert.ok(result.stdout.includes(expectedProject));
  assert.match(result.stdout, /Opus 4\.8/);
  assert.match(result.stdout, /22%/);
  assert.ok(!result.stdout.includes('\x1b['), 'no identity means no hue');
});

// THE ONE THAT PROVES THE COMPOSED PATH. The test above deliberately uses an unknown session,
// so it exercises neither intent resolution nor composeForIntent -- on its own it would leave
// the entire composed path unproven while LOOKING like coverage.
test('a session on the bus gets four placeholder-prefixed, coloured HUD rows', () => {
  const e = statuslineEnv();
  seedBus(e, 'on-the-bus');
  const result = statusline(e, [], {
    session_id: 'on-the-bus',
    cwd: process.cwd(),
    model: { display_name: 'Opus 4.8 (1M context)' },
    context_window: { used_percentage: 22 },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 4, `expected four composed rows, got:\n${result.stdout}`);
  for (const line of lines) {
    assert.ok(line.includes(PLACEHOLDER), 'a composed row is missing its placeholder cells');
  }
  assert.ok(result.stdout.includes('\x1b[38;2;'), 'the HUD should be painted from the ramp');
  assert.match(result.stdout, /working/);
});

// DISCRIMINATING, unlike seeding and querying from the same directory -- there
// basename(cwd) and identity.project are the same repo-root label and the test passes either way.
// Here the bus identity is the repo root while the payload points at a subdirectory, so the
// two answers differ and only the correct one passes.
test('the project label is the identity\'s, not the payload directory\'s', () => {
  const e = statuslineEnv();
  const root = process.cwd();
  const seeded = seedBus(e, 'monorepo', { cwd: root });
  assert.notEqual(seeded.project, 'src');

  const result = statusline(e, [], {
    session_id: 'monorepo',
    cwd: join(root, 'src'),
    workspace: { current_dir: join(root, 'src') },
    model: { display_name: 'Opus 4.8 (1M context)' },
    context_window: { used_percentage: 22 },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(truncEnd(seeded.project, CAPS.project)));
  assert.doesNotMatch(result.stdout, /(?<![\w/])src(?![\w/])/);
});

test('statusline still honours --with, unchanged', () => {
  const result = statusline(statuslineEnv(), ['--with', 'printf custom'], { session_id: 'x', cwd: process.cwd() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /custom/);
  assert.doesNotMatch(result.stdout, /Opus/);
});

test('a bus-backed statusline with --with bypasses HUD field collection and git', (t) => {
  const e = statuslineEnv();
  const probe = mkdtempSync(join(tmpdir(), 'familiar-statusline-no-git-'));
  const fakeBin = join(probe, 'bin');
  const marker = join(probe, 'git-was-called');
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, 'git'),
    '#!/bin/sh\n: > "$FAMILIAR_GIT_MARKER"\nexit 99\n',
    { mode: 0o755 },
  );
  e.PATH = `${fakeBin}:${e.PATH}`;
  e.FAMILIAR_GIT_MARKER = marker;
  t.after(() => {
    rmSync(e.FAMILIAR_CONFIG_DIR, { recursive: true, force: true });
    rmSync(e.FAMILIAR_STATE_DIR, { recursive: true, force: true });
    rmSync(probe, { recursive: true, force: true });
  });

  seedBus(e, 'wrapped-no-fields');
  const result = statusline(e, ['--with', 'printf custom'], {
    session_id: 'wrapped-no-fields',
    cwd: process.cwd(),
    model: { display_name: 'must not be read' },
    context_window: { used_percentage: 99 },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /custom/);
  assert.equal(existsSync(marker), false, 'the wrapped path invoked git while collecting unused HUD fields');
});

// --- decay -----------------------------------------------------------------
//
// bin/familiar took `.current`, which discards expiresAt. That was survivable while the status
// line ran about once a turn. POLLING MAKES IT PERMANENT: done carries an 8s TTL and error a
// 30s one, so a polled HUD reading .current shows the transient state every two seconds,
// forever.

for (const state of ['done', 'error']) {
  test(`an expired ${state} decays to idle rather than showing ${state} forever`, () => {
    const e = statuslineEnv();
    const sessionId = `decays-${state}`;
    seedBus(e, sessionId, { state });
    const result = statusline({ ...e, FAMILIAR_NOW_MS: String(Date.now() + 60_000) }, [], {
      session_id: sessionId, cwd: process.cwd(),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /idle/);
    assert.doesNotMatch(result.stdout, new RegExp(state));
  });
}

// WHAT THIS GUARDS, and why it stopped being a stopwatch:
//
// The status line is polled on a 2s refreshInterval, and an update arriving mid-run CANCELS
// the in-flight script. The regression that would actually break that is the status line
// growing an expensive git call -- `git status` on a large tree, a `log` walk, a fetch.
//
// This used to assert `ms < 500` on a SPAWNED SUBPROCESS, which measures the machine, not
// the code. It failed at 627ms and 848ms under a parallel suite, and at 1505ms on a tree
// with none of the desktop-moments work on it, while passing at ~400ms run alone -- so a
// red run said "this laptop was busy", never "someone slowed the status line down". A test
// that fails on load and passes on quiet is not evidence either way.
//
// So assert the thing the comment always MEANT: exactly one git call, and a cheap one.
// `symbolic-ref --short HEAD` reads one ref file. It cannot become `status` or `log`
// without this failing, deterministically, on any machine at any load.
test('a status line invocation makes exactly one cheap git call', (t) => {
  const e = statuslineEnv();
  const probe = mkdtempSync(join(tmpdir(), 'familiar-statusline-git-calls-'));
  const fakeBin = join(probe, 'bin');
  const log = join(probe, 'git-calls');
  mkdirSync(fakeBin);
  // Records the argv, then re-execs the REAL git with fakeBin dropped from PATH. Delegating
  // rather than stubbing keeps the status line's actual output honest -- a stub that faked a
  // branch name would let a broken git call pass as long as it was still a single call.
  writeFileSync(
    join(fakeBin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAMILIAR_GIT_CALL_LOG"\nPATH="$FAMILIAR_REAL_PATH" exec git "$@"\n`,
    { mode: 0o755 },
  );
  e.FAMILIAR_REAL_PATH = e.PATH;
  e.PATH = `${fakeBin}:${e.PATH}`;
  e.FAMILIAR_GIT_CALL_LOG = log;
  t.after(() => {
    rmSync(e.FAMILIAR_CONFIG_DIR, { recursive: true, force: true });
    rmSync(e.FAMILIAR_STATE_DIR, { recursive: true, force: true });
    rmSync(probe, { recursive: true, force: true });
  });

  seedBus(e, 'timed');
  const payload = { session_id: 'timed', cwd: process.cwd() };
  const warm = statusline(e, [], payload);
  assert.equal(warm.status, 0, warm.stderr);          // ASSERT SUCCESS BEFORE COUNTING:
  assert.ok(warm.stdout.length > 0);                  // the cheapest possible run is the crash

  writeFileSync(log, '');                             // discard the warm run's calls
  const result = statusline(e, [], payload);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').filter((l) => l.length > 0).length === 4);

  const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.length > 0);
  assert.equal(calls.length, 1, `expected one git call, got ${calls.length}:\n${calls.join('\n')}`);
  assert.match(calls[0], /symbolic-ref --short HEAD$/, `unexpected git call: ${calls[0]}`);
});
