// The CLI's theme, scheme, preview and install pets commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { GRAPHICS_MARKERS, MULTIPLEXER_MARKERS } from '../src/render/term/capability.js';
import { parseIdentities } from '../src/bus/pins.js';
import { planCodexProjectSync, applyCodexProjectSync } from '../src/install/codex.js';
import { STATES, loadThemePack, parseThemePack } from 'familiar-theme';
import { preloadedThemes, writeTheme } from './helpers/themes.js';
import { git, initRepo } from './fixtures/git-worktree.mjs';
import { reportCosmeticError } from '../bin/familiar.js';
import { makePrepareSprites, sheetRowCaptions } from '../bin/familiar-commands.js';
import {
  bin, shippedThemesFixture, env, isolatedEnv, resolvedAs,
} from './helpers/familiar-cli.js';

const ttyBin = fileURLToPath(new URL('fixtures/tty-familiar.mjs', import.meta.url));
const runTty = (args, options) => spawnSync(process.execPath, [ttyBin, ...args], options);
const themeFixture = fileURLToPath(new URL('../test/fixtures/theme-pack', import.meta.url));
const fakeTmuxDir = fileURLToPath(new URL('fixtures/fake-tmux', import.meta.url));
const tmuxEnv = (line, over = {}) => env({
  TERM: 'tmux-256color', TMUX: '/tmp/fake,1,0', TMUX_PANE: '%0',
  PATH: `${fakeTmuxDir}:${process.env.PATH}`, FAKE_TMUX_LINE: line, ...over,
});
const KITTY_LINE = 'all\txterm-kitty\tkitty(0.48.2)\t/dev/pts/16\t9001\t1758200000';
const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;


test('a missing configured theme reports invalid receipt recovery on one CLI line', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-missing-theme-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const e = isolatedEnv({ root });
  e.FAMILIAR_THEMES_DIR = join(root, 'absent-themes');
  mkdirSync(e.FAMILIAR_THEMES_DIR);
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\n');
  const receipts = join(e.FAMILIAR_CONFIG_DIR, 'theme-receipts');
  mkdirSync(receipts);
  writeFileSync(join(receipts, 'cats.json'), '{\ninvalid\n}');
  const result = spawnSync(process.execPath, [bin, '--pretty', 'theme', 'sheet'], {
    encoding: 'utf8', env: e,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trimEnd().split(/\r\n|\r|\n/).length, 1);
  assert.match(result.stderr, /theme "cats".*not installed.*invalid receipt/);
  assert.match(result.stderr, /familiar theme add SOURCE/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
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

test('the sheet caption names each member\'s roles, default first, and the column aligns', () => {
  const row = (id, roles) => ({ id, member: { roles, label: id } });
  const captions = sheetRowCaptions([row('one', ['reviewer', 'default']), row('many', []), row('three', ['planner'])]);
  // [label, id, roles] — the caption's columns are 2+ spaces apart.
  const fields = (caption) => caption.trim().split(/\s\s+/);

  assert.deepEqual(captions.map(fields), [
    ['one', 'one', 'default, reviewer'],
    ['many', 'many', '(pin only)'],
    ['three', 'three', 'planner'],
  ]);
  // One width for the id column: a long id must not push every other row's roles
  // out of alignment.
  assert.equal(new Set(captions.map((c) => c.indexOf(fields(c)[2]))).size, 1);
});

// Same boundary, a genuinely different throw site: `scheme set` with a bad
// mode throws out of assertTone/writeTone (src/config.js), never touching
// context() or the theme pack at all. Proves the boundary isn't tied to one
// particular call site.
test('scheme set with an invalid mode is a usage error, not a runtime one', () => {
  // Validated against the declared enum before writeTone ever runs -- an unknown
  // value is an argv-shape problem (exit 2), not a failure of the write (exit 1).
  const result = spawnSync(process.execPath, [bin, 'scheme', 'set', 'neon'], {
    encoding: 'utf8',
    env: env(),
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');

  const lines = result.stderr.split('\n').filter((line) => line !== '');
  assert.ok(lines.length <= 2, `expected at most two stderr lines, got:\n${result.stderr}`);
  assert.match(lines[0], /scheme must be one of dark, light, got "neon"/);
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

test('preview inside a passthrough-all tmux pane emits only WRAPPED graphics, never bare APC', () => {
  const e = tmuxEnv(KITTY_LINE);
  assert.equal(spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e }).status, 0);
  const result = runTty(['theme', 'preview', 'pip', '--state', 'idle'], { encoding: 'latin1', env: e });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(bareApcs(result.stdout), 0, 'no bare APC');
  assert.ok(result.stdout.includes('\x1bPtmux;\x1b\x1b_Ga=T'), 'the transmission is framed');
  assert.match(result.stdout, /\x1b\\\n/, 'layout newlines follow the closed DCS');
});

test('theme show inside tmux with allow-passthrough=on prints the setting and no art', () => {
  const e = tmuxEnv(KITTY_LINE.replace(/^all/, 'on'));
  assert.equal(spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e }).status, 0);
  const result = runTty(['theme', 'show'], { encoding: 'utf8', env: e });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /no graphics capability \(none\) — tmux allow-passthrough=on, needs all/);
  assert.doesNotMatch(result.stdout, /_G/);
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

test('an incoming malformed animation reports its member fault before preflight', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-malformed-animation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const poses = STATES.map((state) => `      ${state}: ${state} pose`).join('\n');
  const pack = parseThemePack(`
spec-version: 2
id: cats
label: Cats
members:
  - id: broken-cat
    asset-root: sprites/broken-cat
    label: Broken Cat
    roles: [default]
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

  const namedFault = 'animation: member "broken-cat" manifest has unknown role "wobble"';
  let preflights = 0;
  const prepareSprites = makePrepareSprites({
    themes: preloadedThemes({ cats: pack }),
    catalog: parseIdentities('identities: []'),
    tone: { mode: 'dark', satScale: 1 },
  }, {
    loadAnimationMember: async () => { throw new Error(namedFault); },
    preflightKittyPrograms: () => { preflights++; },
  });

  const result = await prepareSprites({ bad: {
    sessionId: 'bad', projectKey: 'github.com/me/api', project: 'api',
    remote: 'github.com/me/api', repoRoot: '/repos/api', repositoryRoot: '/repos/api', projectColor: null,
    family: null, role: null,
  } });
  assert.equal(result.faults.get('bad'), namedFault);
  assert.equal(preflights, 0, 'preflight ran after validation failed');
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
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--sync-projects cannot be combined with --out/);
  assert.match(result.stderr, /familiar install pets --help/);
  assert.equal(existsSync(out), false);
});

function codexProjectSyncFixture(t) {
  const runEnv = isolatedEnv();
  const root = mkdtempSync(join(tmpdir(), 'familiar-codex-sync-'));
  const project = join(root, 'project');
  const codexHome = join(root, 'codex-home');
  mkdirSync(project);
  mkdirSync(codexHome);
  initRepo(project);

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

// The fresh-machine shape: pets installed, a theme chosen, and no identities.yaml at all,
// which is what `theme add` leaves behind. This is the case that made --sync-projects a no-op.
function unpinnedSyncFixture(t) {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  rmSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'), { force: true });
  return { runEnv, project, codexHome };
}

test('pets --sync-projects selects a pet in the current repository with no identity pins', (t) => {
  const { runEnv, project, codexHome } = unpinnedSyncFixture(t);
  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(
    readFileSync(join(project, '.codex', 'config.toml'), 'utf8'),
    /^\[tui\]\npet = "custom:familiar-cats--pip"$/m,
  );
  assert.match(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.codex\/config\.toml$/m);
  assert.equal(
    result.stdout,
    `wrote 1 pets to ${join(codexHome, 'pets')}\nsynced 1 project pet config\n`,
  );
});

test('pets --sync-projects writes each tasks warning once in text and JSON modes', (t) => {
  const { runEnv, project } = unpinnedSyncFixture(t);
  runEnv.FAKE_TASKS_OUTPUT = resolvedAs(null, ['w2', 'w1', 'w2']);
  for (const flags of [[], ['--json']]) {
    const r = spawnSync(process.execPath, [bin, ...flags, 'install', 'pets', '--sync-projects'], {
      cwd: project, encoding: 'utf8', env: runEnv,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, 'familiar: tasks: w2\nfamiliar: tasks: w1\n');
    if (flags.length) assert.equal(JSON.parse(r.stdout).sync.configs, 1);
    else assert.match(r.stdout, /synced 1 project pet config/);
  }
});

test('pets --sync-projects counts a pinned project once when it is also the current directory', (t) => {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `wrote 1 pets to ${join(codexHome, 'pets')}\nsynced 1 project pet config\n`,
  );
  assert.equal(
    readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')
      .split('\n').filter((line) => line === '.codex/config.toml').length,
    1,
  );
});

test('pets --sync-projects writes nothing outside a repository and says which directory it skipped', (t) => {
  const { runEnv, codexHome } = unpinnedSyncFixture(t);
  const loose = mkdtempSync(join(tmpdir(), 'familiar-codex-loose-'));
  t.after(() => rmSync(loose, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: loose, encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(loose, '.codex')), false);
  assert.equal(
    result.stdout,
    `wrote 1 pets to ${join(codexHome, 'pets')}\nsynced 0 project pet configs\n`
      + `did not sync the current directory (${loose}): not a Git repository\n`,
  );
});

// A home directory under version control is a real setup, and there `<root>/.codex/config.toml`
// IS the user-wide Codex config. Rewriting it as a managed file would take the user's own
// selection with it.
test('pets --sync-projects refuses to manage the user-wide config when the Codex home is the repository', (t) => {
  const { runEnv, codexHome } = unpinnedSyncFixture(t);
  const home = dirname(codexHome);
  initRepo(home);
  runEnv.CODEX_HOME = join(home, '.codex');
  const userConfig = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(userConfig, '[tui]\npet = "custom:mine"\n');

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: home, encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(userConfig, 'utf8'), '[tui]\npet = "custom:mine"\n');
  assert.match(result.stdout, /its Codex config is the user-wide one/);
});

test('pets --sync-projects creates a managed project config and excludes it locally', (t) => {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    readFileSync(join(project, '.codex', 'config.toml'), 'utf8'),
    '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.\n'
      + '[tui]\npet = "custom:familiar-cats--pip"\n',
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
    cwd: project, encoding: 'utf8', env: runEnv,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(project, '.codex', 'config.toml'), 'utf8'),
    /pet = "custom:familiar-cats--pip"/,
  );
});

test('pets --sync-projects replaces only its managed config and does not duplicate the exclusion', (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const first = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
  });
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(
    join(project, '.codex', 'config.toml'),
    '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.\n'
      + '[tui]\npet = "custom:familiar-cats--old"\n',
  );

  const second = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(readFileSync(join(project, '.codex', 'config.toml'), 'utf8'), /custom:familiar-cats--pip/);
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
  git(project, ['add', '-f', '.codex/config.toml']);

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(configPath, 'utf8'), original);
  assert.match(result.stdout, new RegExp(`tracked project config left unchanged: ${configPath}`));
  assert.match(result.stdout, /add manually:\n\[tui\]\npet = "custom:familiar-cats--pip"/);
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
  git(project, ['add', '-f', '.codex/config.toml']);

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
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
    cwd: project, encoding: 'utf8', env: runEnv,
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
    cwd: project, encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`skipped missing identity path: ${missing}`));
  assert.equal(existsSync(join(missing, '.codex', 'config.toml')), false);
  assert.equal(existsSync(join(codexHome, 'pets', 'familiar-cats--pip', 'pet.json')), true);
});

test('pets --sync-projects refuses a symlinked .codex directory before writing outside the project', (t) => {
  const { runEnv, project, codexHome } = codexProjectSyncFixture(t);
  const outside = join(project, '..', 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(project, '.codex'), 'dir');

  const result = spawnSync(process.execPath, [bin, 'install', 'pets', '--sync-projects'], {
    cwd: project, encoding: 'utf8', env: runEnv,
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
  const plan = await planCodexProjectSync({ catalog, themes: preloadedThemes({ cats: pack }) });
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
  const plan = await planCodexProjectSync({ catalog, themes: preloadedThemes({ cats: pack }) });
  const originalExclude = readFileSync(excludePath, 'utf8');
  git(project, ['add', '-f', '.codex']);

  assert.throws(() => applyCodexProjectSync(plan), /project config changed after preflight/);
  assert.equal(readFileSync(marker, 'utf8'), '');
  assert.equal(readFileSync(excludePath, 'utf8'), originalExclude);
});

test('project sync preserves an exclusion edited after preflight', async (t) => {
  const { runEnv, project } = codexProjectSyncFixture(t);
  const catalog = parseIdentities(readFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'utf8'));
  const pack = await loadThemePack(join(shippedThemesFixture, 'cats'));
  const plan = await planCodexProjectSync({ catalog, themes: preloadedThemes({ cats: pack }) });
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
  assert.match(result.stdout, /\[tui\] pet = "custom:familiar-<theme>--<member>"/);
  assert.match(result.stdout, /user-wide: .*config\.toml/);
  assert.match(result.stdout, /project \(trusted\): <project>\/\.codex\/config\.toml/);
  assert.equal(readFileSync(join(projectCodex, 'config.toml'), 'utf8'), projectConfig);
  const manifest = JSON.parse(readFileSync(join(out, 'familiar-cats--pip', 'pet.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.animations).sort(), [
    'failed', 'failed-root-hold', 'idle', 'review', 'review-root-hold', 'running', 'waiting',
  ]);
  assert.equal(existsSync(join(out, 'familiar-cats--pip', 'assets', 'sheet.png')), true);
  assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), config);
});

// `install pets` compiles every theme the config makes live: `theme:` and each
// `families:` entry. The env is built key by key: the CLI reads nothing else here.
function petsEnv(t, configYaml) {
  const root = mkdtempSync(join(tmpdir(), 'familiar-pets-themes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const codexHome = join(root, 'codex-home');
  for (const dir of [configDir, stateDir, codexHome, join(root, 'home')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(configDir, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(configDir, 'config.yaml'), configYaml);
  const runEnv = {
    PATH: process.env.PATH, HOME: join(root, 'home'), USER: 'familiar-test',
    FAMILIAR_CONFIG_DIR: configDir, FAMILIAR_STATE_DIR: stateDir,
    RELAY_STATE_DIR: join(stateDir, 'relay'), FAMILIAR_THEMES_DIR: shippedThemesFixture,
    CODEX_HOME: codexHome,
  };
  return { runEnv, configDir, out: join(codexHome, 'pets') };
}

// Review Focus 5: two themes share the member id `pip`, and each keeps its own pet.
test('install pets writes one pet per member of every configured theme, keyed on the pair', (t) => {
  const { runEnv, configDir, out } = petsEnv(t, 'theme: cats\nfamilies:\n  guild: forest\nmotion: full\n');
  writeTheme(join(configDir, 'themes'), 'forest');
  const result = spawnSync(process.execPath, [bin, 'install', 'pets'], {
    encoding: 'utf8', env: runEnv, cwd: runEnv.HOME, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^wrote 2 pets /);
  assert.deepEqual(readdirSync(out).sort(), ['familiar-cats--pip', 'familiar-forest--pip']);
  for (const theme of ['cats', 'forest']) {
    const dir = join(out, `familiar-${theme}--pip`);
    assert.equal(JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8')).id, `familiar-${theme}--pip`);
    const stamp = JSON.parse(readFileSync(join(dir, 'familiar-stamp.json'), 'utf8'));
    assert.deepEqual([stamp.themeId, stamp.memberId], [theme, 'pip']);
  }
});

test('install pets fails by name on a configured theme that is not installed, and writes no pet', (t) => {
  const { runEnv, out } = petsEnv(t, 'theme: cats\nfamilies:\n  garden: plant-nooks\nmotion: full\n');
  const result = spawnSync(process.execPath, [bin, 'install', 'pets'], {
    encoding: 'utf8', env: runEnv, cwd: runEnv.HOME,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^familiar: theme "plant-nooks" is not installed.*familiar theme add SOURCE.*familiar theme list\n$/);
  assert.equal(existsSync(out), false);
});

test('install pets fails by name on a configured theme whose pack does not load', (t) => {
  const { runEnv, configDir, out } = petsEnv(t, 'theme: cats\nfamilies:\n  guild: forest\nmotion: full\n');
  writeTheme(join(configDir, 'themes'), 'forest', { packId: 'woods' });
  const result = spawnSync(process.execPath, [bin, 'install', 'pets'], {
    encoding: 'utf8', env: runEnv, cwd: runEnv.HOME,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'familiar: theme "forest": pack id "woods" does not match its directory\n');
  assert.equal(existsSync(out), false);
});
