// The status line: --with wrapping, the native HUD, and the task stage and agents it shows.
import { readSessions, writeSessions } from '../src/bus/sessions.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, openSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strip } from '../src/render/term/sgr.js';
import { CAPS, truncEnd } from '../src/render/term/hud.js';
import { displayProject } from '../src/bus/identity.js';
import { paths } from '../src/bus/paths.js';
import { ledgerPaths } from '../src/render/term/ledger.js';
import { cachePaths } from '../src/render/term/stagecache.js';
import { sessionFilePath } from '../src/render/term/stagesession.js';
import { RENDER_TTL_MS, renderCachePath } from '../src/render/term/render-cache.js';
import { PLACEHOLDER, imageIdFor } from '../src/render/term/placeholder.js';
import { writeTheme } from './helpers/themes.js';
import { TINY_PNG } from './helpers/fixture.js';
import { git } from './fixtures/git-worktree.mjs';
import {
  bin, isolatedEnv, statuslineEnv, statusline, seedBus, STAGE_ID, stageFixture, SENTINEL,
  plantSentinel, atClock,
} from './helpers/familiar-cli.js';

// Waits (at most 5 s) until every refresher a render started is done: each expected cache is
// written and no refresher lock remains. A test that lets one run calls this before teardown.
async function awaitRefreshers(stateDir, tasks) {
  const files = tasks.map(([id, worktree]) => cachePaths(stateDir, id, worktree).file);
  const locksDir = join(stateDir, 'statusline', 'tasks');
  const done = () => files.every((file) => existsSync(file))
    && !(existsSync(locksDir) && readdirSync(locksDir).some((name) => name.endsWith('.lock')));
  for (let waited = 0; !done() && waited < 5000; waited += 50) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(done(), `a refresher is still running under ${stateDir}`);
}

test('statusline with --with and NO intent prints the wrapped output in full — no cat, no truncation', () => {
  // A session that has not hit its first hook, or was evicted, has no cat. The honest answer
  // is the wrapped status line ALONE and IN FULL: there is no cat to fit it against, so
  // nothing is dropped. The old code fitted it to a 4-row cat that did not exist, truncating
  // at line 4.
  const e = isolatedEnv();
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
  const e = isolatedEnv();
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
  const e = isolatedEnv();
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

test('off statusline renders the HUD without familiar cells and gives wrapped text the full surface', async () => {
  const e = isolatedEnv();
  mkdirSync(e.FAMILIAR_CONFIG_DIR, { recursive: true });
  mkdirSync(e.FAMILIAR_STATE_DIR, { recursive: true });
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: off\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'identities: []\n');
  await seedBus(e, 's1', { cwd: '/tmp/api', repository: false });

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

// --- the native HUD --------------------------------------------------------

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

for (const wrapped of [false, true]) {
  test(`statusline keeps ${wrapped ? '--with output unchanged' : 'the HUD'} when its session's visuals fault`, async () => {
    const e = statuslineEnv();
    await seedBus(e, 'faulted');
    writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'),
      `identities:\n  - path: ${JSON.stringify(process.cwd())}\n    slot: 0\n    members: { cats: missing-cat }\n`);
    const args = wrapped ? ['--with', "printf 'custom\\n\\nlast'"] : [];
    const payload = { session_id: 'faulted', cwd: process.cwd(), model: { display_name: 'Opus 4.8' } };
    const ledger = ledgerPaths(paths(e).transmitDir, 'faulted').entryPath;
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, '{not json');
    const result = statusline(e, args, payload);
    assert.equal(result.status, 0);
    if (wrapped) assert.equal(result.stdout, 'custom\n\nlast');
    else {
      assert.match(result.stdout, /Opus 4\.8/);
      assert.equal(result.stdout.trimEnd().split('\n').length, 4);
    }
    assert.doesNotMatch(result.stdout, /\x1b\[|\u{10EEEE}/u);
    assert.match(result.stderr, /^familiar: statusline: session faulted: .*missing-cat.*\n$/);
    assert.equal(result.stderr.trimEnd().split('\n').length, 1);
    assert.equal(readFileSync(ledger, 'utf8'), '{not json', 'faulted visuals must skip settling');
    const combined = join(e.FAMILIAR_STATE_DIR, 'output-order');
    const fd = openSync(combined, 'w');
    try {
      const ordered = spawnSync(process.execPath, [bin, 'statusline', ...args], {
        input: JSON.stringify(payload), env: e, stdio: ['pipe', fd, fd],
      });
      assert.equal(ordered.status, 0);
    } finally { closeSync(fd); }
    assert.equal(readFileSync(combined, 'utf8'), result.stdout + result.stderr,
      'the diagnostic must follow the complete rendered output');
  });
}

// A theme whose world fails proof is the same visual fault as a missing sprite: the record
// is not drawn, the HUD (or --with output) still reaches stdout, and the world fault reaches
// stderr. The proof runs inside resolveAll, so a throw there must not escape to the command
// error handler (empty stdout, non-zero exit).
for (const wrapped of [false, true]) {
  test(`statusline keeps ${wrapped ? '--with output unchanged' : 'the HUD'} when its theme's world fails proof`, async () => {
    const shipped = mkdtempSync(join(tmpdir(), 'familiar-world-themes-'));
    const dir = writeTheme(shipped, 'cats');
    writeFileSync(join(dir, 'theme.yaml'), readFileSync(join(dir, 'theme.yaml'), 'utf8').replace('members:', [
      'world:', '  asset-root: world', '  size: [1, 1]', '  locales:',
      '    home: { image: home.png, places: [[0, 0]] }', 'members:',
    ].join('\n')));
    mkdirSync(join(dir, 'world'));
    writeFileSync(join(dir, 'world', 'home.png'), TINY_PNG());
    const e = { ...statuslineEnv(), FAMILIAR_THEMES_DIR: shipped };
    await seedBus(e, 'worldless');
    rmSync(join(dir, 'world', 'home.png'));
    const args = wrapped ? ['--with', "printf 'custom\\n\\nlast'"] : [];
    const result = statusline(e, args, { session_id: 'worldless', cwd: process.cwd(), model: { display_name: 'Opus 4.8' } });
    assert.equal(result.status, 0, result.stderr);
    if (wrapped) assert.equal(result.stdout, 'custom\n\nlast');
    else {
      assert.match(result.stdout, /Opus 4\.8/);
      assert.equal(result.stdout.trimEnd().split('\n').length, 4);
    }
    assert.doesNotMatch(result.stdout, /\x1b\[|\u{10EEEE}/u);
    assert.match(result.stderr, /^familiar: statusline: session worldless: .*world: locale "home".*\n$/);
    assert.equal(result.stderr.trimEnd().split('\n').length, 1);
  });
}

// A world fault is a fault like any other to the render cache: never cached, so it is said on
// every poll. A world image is not in the key, so a line cached while it was whole serves
// until the TTL; past it the fault shows, and the next poll says it again.
test('a world that fails proof is said on every poll and never cached', async () => {
  const shipped = mkdtempSync(join(tmpdir(), 'familiar-world-themes-'));
  const dir = writeTheme(shipped, 'cats');
  writeFileSync(join(dir, 'theme.yaml'), readFileSync(join(dir, 'theme.yaml'), 'utf8').replace('members:', [
    'world:', '  asset-root: world', '  size: [1, 1]', '  locales:',
    '    home: { image: home.png, places: [[0, 0]] }', 'members:',
  ].join('\n')));
  mkdirSync(join(dir, 'world'));
  writeFileSync(join(dir, 'world', 'home.png'), TINY_PNG());
  const e = { ...statuslineEnv(), FAMILIAR_THEMES_DIR: shipped };
  await seedBus(e, 'worldly');
  const payload = { session_id: 'worldly', cwd: process.cwd() };
  const at = Date.now();
  const good = statusline(atClock(e, at), [], payload);
  assert.equal(good.stderr, '');
  const cachePath = renderCachePath(paths(e).stateDir, 'worldly');
  assert.ok(existsSync(cachePath), 'a whole world\'s line is cached');
  rmSync(join(dir, 'world', 'home.png'));
  const expired = at + RENDER_TTL_MS;
  for (const poll of [0, 1]) {
    const faulted = statusline(atClock(e, expired + poll), [], payload);
    assert.equal(faulted.status, 0, faulted.stderr);
    assert.match(faulted.stderr, /world: locale "home"/, `poll ${poll} says the world fault`);
    assert.ok(!faulted.stdout.includes(PLACEHOLDER), 'a faulted line draws no cells');
  }
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).renderedAt, at, 'no faulted poll rewrote the entry');
});

// THE ONE THAT PROVES THE COMPOSED PATH. The test above deliberately uses an unknown session,
// so it exercises neither intent resolution nor composeForIntent -- on its own it would leave
// the entire composed path unproven while LOOKING like coverage.
test('a session on the bus gets four placeholder-prefixed, coloured HUD rows', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'on-the-bus');
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
test('the project label is the identity\'s, not the payload directory\'s', async () => {
  const e = statuslineEnv();
  const root = process.cwd();
  const seeded = await seedBus(e, 'monorepo', { cwd: root });
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

// The claim lookup on both branches: a session the bus has not seen yet, and one it has.
test('statusline names the task its session has claimed, on and off the bus', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'claimed');
  e.FAKE_TASKS_CLAIMS = JSON.stringify({ claims: [
    { id: 'fam-ff5351', session: 'claimed', started: '2026-10-26T00:38:48Z', worktree: '/w', live: true },
    { id: 'fam-aaaaaa', session: 'claimed', started: '2026-10-25T00:00:00Z', worktree: '/w', live: true },
    { id: 'fam-bbbbbb', session: 'not-on-the-bus', started: '2026-10-25T00:00:00Z', worktree: '/w', live: true },
    { id: 'fam-cccccc', session: 'claimed', started: '2026-10-27T00:00:00Z', live: false },
  ] });
  const render = (sessionId) => {
    const result = statusline(e, [], { session_id: sessionId, cwd: process.cwd() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return strip(result.stdout);
  };
  assert.match(render('claimed'), /\(fam-ff5351 \+1\)/);
  assert.match(render('not-on-the-bus'), /\(fam-bbbbbb\)/);
  assert.doesNotMatch(render('nobody'), /\(fam-/);
  await awaitRefreshers(e.FAMILIAR_STATE_DIR, [['fam-ff5351', '/w'], ['fam-bbbbbb', '/w']]);
});

// agy 1.4.12's status line, as recorded by fam-93c939: Claude Code's shape, with the
// conversation UUID in both session_id and conversation_id once a conversation exists, and
// both empty before. Relay publishes that conversation as `agy:<uuid>`, so the bus keys it by
// the bare UUID, and the hook transmits under imageIdFor(<uuid>).
const agyStdin = (overrides = {}) => {
  const recorded = readFileSync(new URL('fixtures/agy/statusline-stdin.json', import.meta.url), 'utf8');
  return { ...JSON.parse(recorded.replaceAll('<cwd>', JSON.stringify(process.cwd()).slice(1, -1))), ...overrides };
};

test('agy\'s recorded status-line stdin prints the cells of the image its hook transmits', async () => {
  const e = statuslineEnv();
  const payload = agyStdin();
  const seeded = await seedBus(e, payload.conversation_id, { harness: 'agy', state: 'idle' });
  assert.equal(seeded.harness, 'agy');
  const result = statusline(e, [], payload);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 4, `expected four composed rows, got:\n${result.stdout}`);
  const id = imageIdFor(seeded.sessionId);
  const idSgr = `\x1b[38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m${PLACEHOLDER}`;
  for (const line of lines) {
    assert.ok(line.startsWith(idSgr), `a row does not open with the hook's image id:\n${JSON.stringify(line)}`);
  }
  assert.match(strip(result.stdout), /Gemini 4 Argon/);
});

test('agy\'s status line before a conversation exists prints the HUD without cells, and does not fail', async () => {
  const e = statuslineEnv();
  await seedBus(e, agyStdin().conversation_id, { harness: 'agy', state: 'idle' });
  const result = statusline(e, [], agyStdin({ session_id: '', conversation_id: '', agent_state: 'authenticating' }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /\u{10EEEE}/u);
  assert.equal(result.stdout.trimEnd().split('\n').length, 4);
});

// tasks records an agy session's claim under relay's agent id, `agy:<uuid>`, while agy's
// status line passes the bare UUID; a Claude Code claim is the bare session_id.
test('agy\'s status line names the task its conversation has claimed', async () => {
  const e = statuslineEnv();
  const payload = agyStdin();
  e.FAKE_TASKS_CLAIMS = JSON.stringify({ claims: [
    { id: 'fam-de2ffc', session: `agy:${payload.session_id}`, started: '2026-11-01T00:00:00Z', worktree: '/w', live: true },
    { id: 'fam-aaaaaa', session: payload.session_id, started: '2026-11-01T00:00:00Z', worktree: '/w', live: true },
  ] });
  const render = (input) => {
    const result = statusline(e, [], input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return strip(result.stdout);
  };
  assert.match(render(payload), /\(fam-de2ffc\)/);
  // The same UUID from Claude Code (no product) is a different session's claim.
  assert.match(render({ session_id: payload.session_id, cwd: process.cwd() }), /\(fam-aaaaaa\)/);
  assert.doesNotMatch(render(agyStdin({ session_id: '', conversation_id: '' })), /\(fam-/);
  await awaitRefreshers(e.FAMILIAR_STATE_DIR, [['fam-de2ffc', '/w'], ['fam-aaaaaa', '/w']]);
});

test('statusline still honours --with, unchanged', () => {
  const result = statusline(statuslineEnv(), ['--with', 'printf custom'], { session_id: 'x', cwd: process.cwd() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /custom/);
  assert.doesNotMatch(result.stdout, /Opus/);
});

test('a bus-backed statusline with --with bypasses HUD field collection and git', async (t) => {
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

  await seedBus(e, 'wrapped-no-fields');
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

// --- the task stage and reported agents --------------------------------------

// Each render runs twice: a miss (no line cached yet) and then a hit (the render cache's
// SENTINEL, planted under the same key, is what prints). The stage and the refresher are read
// in the front door, before the render cache is looked up, so both paths obey the same rules.
test('statusline shows the cached stage and runs nothing but tasks claims, on a render-cache miss and hit', async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'staged');
  f.claim('staged');
  f.writeFreshCache('designed');
  for (const sid of ['staged', 'not-on-the-bus']) {
    if (sid === 'not-on-the-bus') f.claim(sid);
    for (const path of ['miss', 'hit']) {
      if (path === 'hit') plantSentinel(f.e, sid);
      rmSync(join(f.root, 'tasks.log'), { force: true });
      const { stateRow, stdout, stderr } = f.render(sid);
      assert.equal(stderr, '');
      if (path === 'miss') {
        assert.match(stdout, new RegExp(`\\(${STAGE_ID}\\)`));
        assert.ok(stateRow.endsWith(' · designed'), JSON.stringify(stateRow));
      } else {
        assert.equal(stdout, SENTINEL, `${sid}: the second poll is a hit`);
      }
      assert.deepEqual(f.log(), ['claims --json'], `${sid} ${path}: a fresh cache starts no refresher`);
    }
  }
});

// Review C1: a stage that changes between two polls, with every other input unchanged, is a
// changed key and so a changed line, never the cached one.
test('a stage change between two polls changes the line on what would be a render-cache hit', async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'changing');
  f.claim('changing');
  f.writeFreshCache('designed');
  assert.ok(f.render('changing').stateRow.endsWith(' · designed'));
  plantSentinel(f.e, 'changing');
  assert.equal(f.render('changing').stdout, SENTINEL, 'an unchanged poll is a hit');
  f.writeFreshCache('reviewed');
  const { stateRow, stdout, stderr } = f.render('changing');
  assert.equal(stderr, '');
  assert.notEqual(stdout, SENTINEL);
  assert.ok(stateRow.endsWith(' · reviewed'), JSON.stringify(stateRow));
  assert.deepEqual(f.log(), ['claims --json', 'claims --json', 'claims --json'], 'no refresher on any poll');
});

// Spec goal 3, end to end through the front door: a task the session showed stays on the line
// once its claim is released, from the session file, with its stage from a fresh cache. The
// live line counts a second, older claim (+1); the released line names only the recorded task.
test('a released claim stays on the line with its cached stage, on a render-cache miss and hit', async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'released');
  writeFileSync(join(f.root, 'claims.json'), JSON.stringify({ claims: [
    { id: STAGE_ID, session: 'released', started: '2026-11-01T00:00:00Z', worktree: f.dirs.worktree, live: true },
    { id: 'fam-000001', session: 'released', started: '2026-10-31T00:00:00Z', worktree: f.dirs.worktree, live: true },
  ] }));
  f.writeFreshCache('designed');
  const live = f.render('released');
  assert.equal(live.stderr, '');
  assert.match(live.stdout, new RegExp(`\\(${STAGE_ID} \\+1\\)`));
  assert.ok(existsSync(sessionFilePath(f.dirs.state, 'released')), 'the live claim was recorded');

  writeFileSync(join(f.root, 'claims.json'), JSON.stringify({ claims: [] }));
  f.writeFreshCache('closed');
  rmSync(join(f.root, 'tasks.log'), { force: true });
  const released = f.render('released');
  assert.equal(released.stderr, '');
  assert.match(released.stdout, new RegExp(`\\(${STAGE_ID}\\)`));
  assert.doesNotMatch(released.stdout, new RegExp(`${STAGE_ID} \\+`), 'a recorded task counts no other claims');
  assert.ok(released.stateRow.endsWith(' · closed'), JSON.stringify(released.stateRow));

  plantSentinel(f.e, 'released');
  assert.equal(f.render('released').stdout, SENTINEL, 'an unchanged released line is a hit');
  assert.deepEqual(f.log(), ['claims --json', 'claims --json'], 'a fresh cache starts no refresher');
});

test('statusline with no claim, no cache and no agents is unchanged', async (t) => {
  const f = stageFixture(t);
  assert.equal(f.render('not-on-the-bus').stateRow, '▎ —');
  await seedBus(f.e, 'plain');
  const { stateRow, stderr } = f.render('plain');
  assert.equal(stderr, '');
  assert.match(stateRow, /⚡ working$/);
  assert.doesNotMatch(stateRow, /·/);
  assert.equal(existsSync(join(f.dirs.state, 'statusline')), false, 'no task, no session file');
});

test('a seeded session\'s reported agents reach the line', async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'busy');
  const { sessionsPath } = paths(f.e);
  const value = await readSessions(sessionsPath);
  value.sessions.busy.agents = 2;
  await writeSessions(sessionsPath, value);
  const { stateRow, stderr } = f.render('busy');
  assert.equal(stderr, '');
  assert.ok(stateRow.endsWith('⚡ working · 2 agents'), JSON.stringify(stateRow));
  // The count rides on the bus record, which the render key holds raw: a new count is a miss.
  plantSentinel(f.e, 'busy');
  assert.equal(f.render('busy').stdout, SENTINEL, 'an unchanged poll is a hit');
  value.sessions.busy.agents = 3;
  await writeSessions(sessionsPath, value);
  const changed = f.render('busy');
  assert.equal(changed.stderr, '');
  assert.ok(changed.stateRow.endsWith('⚡ working · 3 agents'), JSON.stringify(changed.stateRow));
});

// The refresher a stale stage cache starts, on a render-cache miss and on a hit. On the hit the
// stage cache already exists, so this waits for the refresher to rewrite it (a new refreshedAt)
// and release its lock.
async function awaitRewrite(f, before) {
  const locksDir = dirname(f.cache.lock);
  const done = () => JSON.parse(readFileSync(f.cache.file, 'utf8')).refreshedAt !== before
    && !readdirSync(locksDir).some((name) => name.endsWith('.lock'));
  for (let waited = 0; !done() && waited < 5000; waited += 50) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(done(), 'the refresher did not rewrite the stage cache');
}

test('a stale cache is refreshed in the background, on a render-cache miss and hit', async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'refreshing');
  f.claim('refreshing');
  const first = f.render('refreshing');
  assert.equal(first.stderr, '');
  assert.ok(first.stateRow.endsWith(' · —'), JSON.stringify(first.stateRow));
  await awaitRefreshers(f.dirs.state, [[STAGE_ID, f.dirs.worktree]]);
  const second = f.render('refreshing');
  assert.equal(second.stderr, '');
  assert.ok(second.stateRow.endsWith(' · doing'), JSON.stringify(second.stateRow));
  assert.ok(f.log().includes(`flow-state ${STAGE_ID} --json --no-git`), 'the refresher found flow-state under HOME');

  // The hit: a record write moves the tasks dir's stamp, the stage the cache holds is unchanged,
  // so the render key is too. The cached line prints, and the refresher still starts.
  plantSentinel(f.e, 'refreshing');
  const before = JSON.parse(readFileSync(f.cache.file, 'utf8')).refreshedAt;
  writeFileSync(join(f.dirs.tasksDir, 'fam-000000.md'), '');
  rmSync(join(f.root, 'tasks.log'), { force: true });
  const third = f.render('refreshing');
  assert.equal(third.stderr, '');
  assert.equal(third.stdout, SENTINEL, 'an unchanged stage is a render-cache hit');
  await awaitRewrite(f, before);
  assert.deepEqual(f.log(), ['claims --json', 'where --json', `show ${STAGE_ID} --json`, 'list --parked --json',
    `flow-state ${STAGE_ID} --json --no-git`]);
});

// Review M1, end to end: a cache whose fault is not a string paints the line with — and one
// warning, never a blank line.
test('a stage cache with a non-string fault still paints the claim and warns', async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'odd-fault');
  f.claim('odd-fault');
  f.writeFreshCache('designed');
  writeFileSync(f.cache.file, JSON.stringify({ ...JSON.parse(readFileSync(f.cache.file, 'utf8')), fault: { code: 1 } }));
  const before = readFileSync(f.cache.file, 'utf8');
  // A refresher lock this test holds keeps the render from starting one.
  const held = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  writeFileSync(f.cache.lock, held);
  const { stdout, stateRow, stderr } = f.render('odd-fault');
  assert.match(stdout, new RegExp(`\\(${STAGE_ID}\\)`));
  assert.ok(stateRow.endsWith(' · —'), JSON.stringify(stateRow));
  assert.match(stderr, /^familiar: statusline: stage cache .*: not the cache shape\n$/);
  assert.equal(readFileSync(f.cache.file, 'utf8'), before);
  assert.equal(readFileSync(f.cache.lock, 'utf8'), held, 'no refresher took the lock');
});

// Review Focus 2, end to end: the session file cannot be written, the line still paints.
// A refresher lock this test process holds keeps the render from starting one, so nothing
// can still be running when the fixture is torn down.
test('an unwritable state dir still paints the claim and warns', async (t) => {
  const f = stageFixture(t);
  f.claim('read-only');
  mkdirSync(dirname(f.cache.lock), { recursive: true });
  const held = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  writeFileSync(f.cache.lock, held);
  chmodSync(join(f.dirs.state, 'statusline'), 0o555);
  chmodSync(f.dirs.state, 0o555);
  const { stdout, stateRow, stderr } = f.render('read-only');
  assert.equal(readFileSync(f.cache.lock, 'utf8'), held, 'no refresher took the lock');
  assert.equal(existsSync(f.cache.file), false);
  assert.match(stdout, new RegExp(`\\(${STAGE_ID}\\)`));
  assert.equal(stateRow, '▎ — · —');
  assert.match(stderr, /^familiar: statusline: session file .*EACCES/m);
  // The one other line is the render cache's own write, after the line was printed, which the
  // CLI boundary reports as a cosmetic fault.
  const others = stderr.trimEnd().split('\n').filter((line) => !line.startsWith('familiar: statusline: '));
  assert.deepEqual(others.map((line) => /^familiar: EACCES: .*statusline-render/.test(line)), [true], stderr);
});

test('a claim whose id is not a task id still paints, with a warning and no refresher', async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'odd-claim');
  for (const sid of ['odd-claim', 'not-on-the-bus']) {
    f.claim(sid, 'BAD_ID');
    rmSync(join(f.root, 'tasks.log'), { force: true });
    const { stdout, stateRow, stderr } = f.render(sid);
    assert.match(stdout, /\(BAD_ID\)/);
    assert.ok(stateRow.endsWith(' · —'), JSON.stringify(stateRow));
    assert.equal(stderr, 'familiar: statusline: stage cache: not a task id: "BAD_ID"\n');
    assert.deepEqual(f.log(), ['claims --json']);
  }
  assert.equal(existsSync(join(f.dirs.state, 'statusline')), false, 'nothing recorded, nothing cached');
});
