import { emitTransition } from '../src/observe/emission.js';
import { applyEvent, readSnapshot, reapRegistry, paths as relayPaths, createProcessOps as relayProcessOps } from 'relay';
import { observe } from '../src/observe/run.js';
import { loadContext } from '../src/observe/context.js';
import { readSessions, writeSessions } from '../src/bus/sessions.js';
import { terminalOwnerPaths } from '../src/render/term/terminal-owner.js';
import { test } from 'node:test';
import * as nodeModule from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  openSync, renameSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { GRAPHICS_MARKERS, MULTIPLEXER_MARKERS } from '../src/render/term/capability.js';
import { fg, strip } from '../src/render/term/sgr.js';
import { CAPS, truncEnd } from '../src/render/term/hud.js';
import { displayProject } from '../src/bus/identity.js';
import { paths } from '../src/bus/paths.js';
import { ledgerPaths } from '../src/render/term/ledger.js';
import { parkStorePath } from '../src/render/term/stagerefresh.js';
import { cachePaths, mtimeStamp } from '../src/render/term/stagecache.js';
import { sessionFilePath } from '../src/render/term/stagesession.js';
import { RENDER_TTL_MS, renderCacheDir, renderCachePath } from '../src/render/term/render-cache.js';
import { parseIdentities } from '../src/bus/pins.js';
import { planCodexProjectSync, applyCodexProjectSync } from '../src/install/codex.js';
import { startTimeOf } from '../src/bus/proc.js';
import { PLACEHOLDER, imageIdFor } from '../src/render/term/placeholder.js';
import { setupDocument } from '../src/install/setup.js';
import { STATES, loadThemePack, parseThemePack } from 'familiar-theme';
import { preloadedThemes, writeTheme } from './helpers/themes.js';
import { TINY_PNG } from './helpers/fixture.js';
import { addWorktree, git, initRepo, seedRepo } from './fixtures/git-worktree.mjs';
import { reportCommandError, reportCosmeticError } from '../bin/familiar.js';
import { makePrepareSprites, settleStatusline, sheetRowCaptions } from '../bin/familiar-commands.js';

const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
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

// The engine ships no art: FAMILIAR_THEMES_DIR (src/bus/paths.js) redirects
// the SHIPPED themes root away from the repo's own themes/ (absent
// post-split) to this once-built fixture root, where the committed pack is
// installed under the "cats" id — the config default every test here relies
// on unless it says otherwise. Built once and reused; the pack is read-only.
const shippedThemesFixture = mkdtempSync(join(tmpdir(), 'familiar-shipped-themes-'));
writeTheme(shippedThemesFixture, 'cats');

function env(over = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'familiar-state-'));
  return {
    ...process.env,
    FAMILIAR_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'familiar-cfg-')),
    FAMILIAR_STATE_DIR: stateDir,
    RELAY_STATE_DIR: join(stateDir, 'relay'),
    FAMILIAR_THEMES_DIR: shippedThemesFixture,
    ...over,
  };
}

// A status line render can start the detached stage refresher, which runs `tasks` and
// flow-state (under HOME) with the render's own environment. So every statusline test runs
// with an env built key by key, never a copy of process.env: HOME and XDG_STATE_HOME are
// test-owned, git is kept off the host's config, and `tasks` is a fake (the suite's own,
// unless a test brings its own bin dir). Node's directory is on PATH for that fake's shebang.
const suiteFakeTasks = fileURLToPath(new URL('fixtures/fake-tasks', import.meta.url));
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

function isolatedEnv({ root = mkdtempSync(join(tmpdir(), 'familiar-isolated-')), bin: fakeBin = suiteFakeTasks } = {}) {
  const dirs = { home: join(root, 'home'), xdgState: join(root, 'xdg-state'), config: join(root, 'config'), state: join(root, 'state') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return {
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dirs.home, XDG_STATE_HOME: dirs.xdgState,
    FAMILIAR_CONFIG_DIR: dirs.config, FAMILIAR_STATE_DIR: dirs.state, RELAY_STATE_DIR: join(dirs.state, 'relay'),
    FAMILIAR_THEMES_DIR: shippedThemesFixture, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
}

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

test('setup claude-code prints exact JSON without reading configuration', () => {
  const runEnv = env();
  const result = spawnSync(process.execPath, [bin, 'setup', 'claude-code'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(setupDocument('claude-code', realpathSync(bin)), null, 2)}\n`);
  assert.deepEqual(readdirSync(runEnv.FAMILIAR_STATE_DIR), []);
});

test('setup relay prints exact JSON without reading configuration', () => {
  const runEnv = env();
  const result = spawnSync(process.execPath, [bin, 'setup', 'relay'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(setupDocument('relay', realpathSync(bin)), null, 2)}\n`);
  assert.deepEqual(readdirSync(runEnv.FAMILIAR_STATE_DIR), []);
});

test('setup rejects extra arguments and unknown flags before work', () => {
  for (const args of [
    ['setup', 'claude-code', 'extra'],
    ['setup', 'claude-code', '--write'],
    ['setup', 'relay', 'extra'],
    ['setup', 'relay', '--write'],
  ]) {
    const runEnv = env();
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8', env: runEnv,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unexpected argument|unknown option/i);
    assert.deepEqual(readdirSync(runEnv.FAMILIAR_STATE_DIR), []);
  }
});

test('setup resolves an npm-style link to a checkout path containing spaces', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-setup-link-'));
  const checkout = join(root, 'Familiar Build');
  const prefix = join(root, 'prefix', 'bin');
  mkdirSync(join(checkout, 'bin'), { recursive: true });
  mkdirSync(prefix, { recursive: true });
  cpSync(bin, join(checkout, 'bin', 'familiar'));
  for (const name of ['familiar.js', 'familiar-commands.js']) {
    cpSync(join(repoRoot, 'bin', name), join(checkout, 'bin', name));
  }
  for (const name of ['src', 'integrations', 'node_modules']) {
    symlinkSync(join(repoRoot, name), join(checkout, name), 'dir');
  }
  const linked = join(prefix, 'familiar');
  symlinkSync(join(checkout, 'bin', 'familiar'), linked);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [linked, 'setup', 'claude-code'], {
    encoding: 'utf8', env: env(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).statusLine.command,
    `'${join(checkout, 'bin', 'familiar')}' statusline`);
});

test('observe reconciles through the CLI and reports malformed envelopes as faults', () => {
  const runEnv = env();
  writeFileSync(join(runEnv.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  const input = JSON.stringify({ schema: 1, type: 'reconcile', subscriber: 'familiar', event: null, registry: { generation: null, revision: null }, changed: false, reaped: [] });
  const result = spawnSync(process.execPath, [bin, 'observe'], { input, encoding: 'utf8', env: runEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(readFileSync(join(runEnv.FAMILIAR_STATE_DIR, 'sessions.json'))).sessions, {});
  const bad = spawnSync(process.execPath, [bin, 'observe'], { input: '{', encoding: 'utf8', env: runEnv });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /familiar: observe:/);
});

test('an observer transition with no Darwin tty reports a fault', async () => {
  let targetError;
  await assert.rejects(emitTransition({
    prev: null,
    next: { sessionId: 's1', projectColor: null, pid: 42 },
    seq: 1,
    paths: paths(env()),
    intent: {},
    harness: 'claude-code',
    renderProcess: {
      recordOf: () => ({ pid: 42, tty: null }),
      ownerAlive: () => true,
      startTimeOf: () => 1,
    },
    platform: 'darwin',
    hookEnv: {},
    probe: () => null,
  }), (error) => {
    targetError = error;
    return /agent pid 42 has no validated Darwin tty/.test(error.message);
  });

  const lines = [];
  const status = reportCommandError(targetError, { command: 'observe' }, {
    write: (line) => lines.push(line),
  });

  assert.equal(status, 1);
  assert.deepEqual(lines, [
    'familiar: terminal target: agent pid 42 has no validated Darwin tty\n',
  ]);
});

// The owner-dead gate keeps every terminal unopened while the real emission
// section writes ordering evidence, including SessionEnd's tombstone.
test('emitTransition writes a stamped ledger entry under transmit/ and a tombstone on SessionEnd', async () => {
  const p = paths(env());
  const sessionId = 'ledger/../session';
  const agent = { sessionId, state: 'working', pid: process.pid, starttime: 1, project: 'api' };
  const processOps = {
    recordOf: () => ({ pid: process.pid, tty: 'ttys999' }),
    ownerAlive: () => false,
    startTimeOf: () => 1,
  };
  const intent = { [sessionId]: { current: {
    sessionId, pid: process.pid, identity: { project: 'api' }, state: 'working', motionPolicy: 'full',
    animation: { kind: 'static' }, color: { backdrop: '#000000', base: '#ffffff' }, sprite: { terminal: '/nonexistent.png', rows: 4 },
  } } };
  const first = await emitTransition({
    prev: null, next: agent, intent: intent[sessionId].current, seq: 1, harness: 'claude-code',
    paths: p, renderProcess: processOps, platform: 'darwin', hookEnv: { TERM: 'xterm-256color' }, probe: () => null,
  });
  assert.equal(first.kind, 'suppressed');
  assert.equal(first.reason, 'owner-dead');
  const { entryPath } = ledgerPaths(p.transmitDir, sessionId);
  assert.equal(dirname(entryPath), p.transmitDir, 'the session id is a name, not a path');
  assert.ok(!existsSync(join(p.stateDir, 'session.json')) && !existsSync(join(p.stateDir, 'agents.json')), 'no traversal out of transmit/');
  const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
  assert.deepEqual(entry, { seq: 1, pid: process.pid, starttime: 1, held: null, presented: null, ended: false });

  const end = await emitTransition({
    prev: agent, next: null, intent: null, seq: 2, harness: 'claude-code',
    paths: p, renderProcess: processOps, platform: 'darwin', hookEnv: { TERM: 'xterm-256color' }, probe: () => null,
  });
  assert.equal(end.kind, 'suppressed');
  assert.equal(end.reason, 'owner-dead');
  const tomb = JSON.parse(readFileSync(entryPath, 'utf8'));
  assert.deepEqual([tomb.seq, tomb.ended, tomb.held], [2, true, null], 'the tombstone is ordering evidence and is written for a dead owner too');
});

// A provisional (SessionStart) section publishes no held evidence even where the previous
// entry had some, so the first event after the agent's UI is up creates the image again.
test('emitTransition passes provisional through: the ledger keeps no held evidence', async () => {
  const p = paths(env());
  const sessionId = 's-provisional';
  const agent = { sessionId, state: 'idle', pid: process.pid, starttime: 1, project: 'api' };
  const { entryPath } = ledgerPaths(p.transmitDir, sessionId);
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, JSON.stringify({
    seq: 1, pid: process.pid, starttime: 1, presented: 'idle', ended: false,
    held: { transport: 'direct', capability: 'kitty-animation', id: 1, intent: { state: 'idle' } },
  }));
  const intent = { [sessionId]: { current: {
    sessionId, pid: process.pid, identity: { project: 'api' }, state: 'idle', motionPolicy: 'full',
    animation: { kind: 'static' }, color: { backdrop: '#000000', base: '#ffffff' }, sprite: { terminal: '/nonexistent.png', rows: 4 },
  } } };
  const result = await emitTransition({
    prev: agent, next: agent, intent: intent[sessionId].current, seq: 2, harness: 'claude-code', provisional: true,
    paths: p,
    renderProcess: { recordOf: () => ({ pid: process.pid, tty: 'ttys999' }), ownerAlive: () => false, startTimeOf: () => 1 },
    platform: 'darwin', hookEnv: { TERM: 'xterm-kitty' }, probe: () => null,
  });
  assert.equal(result.kind, 'suppressed');
  assert.equal(JSON.parse(readFileSync(entryPath, 'utf8')).held, null);
});

test('settleStatusline probes the terminal only for provisional evidence', async () => {
  const p = paths(env());
  const sessionId = 's-settle';
  const record = { sessionId, pid: process.pid, starttime: 1 };
  const { entryPath } = ledgerPaths(p.transmitDir, sessionId);
  mkdirSync(dirname(entryPath), { recursive: true });
  const held = { transport: 'direct', capability: 'kitty-animation', id: 1, intent: { state: 'idle' } };
  let probed = 0;
  const owner = terminalOwnerPaths(p.transmitDir, record);
  mkdirSync(dirname(owner.entryPath), { recursive: true });
  writeFileSync(owner.entryPath, JSON.stringify({ sessionId, seq: 1 }));
  const run = () => settleStatusline({
    record, intent: {}, paths: p,
    processOps: { recordOf: () => { probed += 1; return { pid: process.pid, tty: 'ttys999' }; }, ownerAlive: () => false, startTimeOf: () => 1 },
    platform: 'darwin', hookEnv: { TERM: 'xterm-kitty' }, probe: () => null,
  });

  writeFileSync(entryPath, JSON.stringify({ seq: 1, pid: process.pid, starttime: 1, presented: 'idle', ended: false, held }));
  assert.equal((await run()).kind, 'noop');
  assert.equal(probed, 0, 'ordinary evidence costs one file read and nothing else');

  writeFileSync(entryPath, JSON.stringify({ seq: 1, pid: process.pid, starttime: 1, presented: 'idle', ended: false, held: { ...held, provisional: true } }));
  assert.equal((await run()).kind, 'noop', 'a dead owner is left alone');
  assert.equal(probed, 1, 'provisional evidence reaches the terminal target and the lock');
});

test('statusline settles only for the recorded terminal owner', async () => {
  const p = paths(env());
  const record = { sessionId: 'old', pid: process.pid, starttime: 1 };
  const { entryPath, lockPath } = ledgerPaths(p.transmitDir, 'old');
  const owner = terminalOwnerPaths(p.transmitDir, record);
  mkdirSync(dirname(entryPath), { recursive: true });
  mkdirSync(dirname(owner.entryPath), { recursive: true });
  writeFileSync(entryPath, JSON.stringify({ seq: 1, pid: process.pid, starttime: 1,
    ended: false, held: { provisional: true }, presented: 'idle' }));
  writeFileSync(owner.entryPath, JSON.stringify({ sessionId: 'new', seq: 2 }));
  const locks = [];
  const { withLock } = await import('../src/bus/lock.js');
  // Linux, explicitly: its terminal target accepts a process record with no tty, where
  // Darwin requires a validated one. Ownership, not the platform's tty rule, is under test.
  const args = { record, intent: {}, paths: p, platform: 'linux',
    processOps: { recordOf: () => { throw new Error('superseded session probed the terminal'); },
      ownerAlive: () => false, startTimeOf: () => 1 },
    lockWith: (path, fn, options) => { locks.push(path); return withLock(path, fn, options); },
  };
  const before = readFileSync(entryPath, 'utf8');
  assert.deepEqual(await settleStatusline(args), { kind: 'superseded', reason: 'terminal' });
  assert.deepEqual(locks, [owner.lockPath]);
  assert.equal(readFileSync(entryPath, 'utf8'), before);
  writeFileSync(owner.entryPath, JSON.stringify({ sessionId: 'old', seq: 2 }));
  locks.length = 0;
  assert.deepEqual(await settleStatusline({ ...args,
    processOps: { ...args.processOps, recordOf: () => null },
  }), { kind: 'noop' });
  assert.deepEqual(locks, [owner.lockPath, lockPath]);
  assert.deepEqual(JSON.parse(readFileSync(owner.entryPath, 'utf8')), { sessionId: 'old', seq: 2 });
});

test('removed hook and setup codex commands are usage errors before state work', () => {
  for (const args of [['hook', 'SessionStart'], ['setup', 'codex']]) {
    const e = env();
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: e });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown/i);
    assert.deepEqual(readdirSync(e.FAMILIAR_STATE_DIR), []);
  }
});

test('statusline keeps malformed input cosmetic', () => {
  const result = spawnSync(process.execPath, [bin, 'statusline'], {
    input: '{not json', encoding: 'utf8', env: isolatedEnv(),
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
  assert.match(result.stderr, /^familiar: reap: no scheme at /);
});

test('reap prunes a dead transmission owner absent from the bus and reports only removals', () => {
  const e = env();
  const p = paths(e);
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  mkdirSync(p.transmitDir, { recursive: true });
  const { entryPath } = ledgerPaths(p.transmitDir, 'ended-session');
  // A live pid with a different birth stamp is a dead owner, without guessing an unused pid.
  writeFileSync(entryPath, JSON.stringify({ seq: 1, pid: process.pid, starttime: -1, held: null, ended: true }));

  const first = spawnSync(process.execPath, [bin, 'reap'], { encoding: 'utf8', env: e });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, 'pruned 1 transmission ledger(s)\n');
  assert.equal(existsSync(entryPath), false);

  const second = spawnSync(process.execPath, [bin, 'reap'], { encoding: 'utf8', env: e });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  assert.equal(second.stdout, '');
});

test('reap sweeps an orphaned atomic-write temp from the state dir and reports it', () => {
  const e = env();
  const p = paths(e);
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  mkdirSync(p.stateDir, { recursive: true });
  // Our own pid is alive, so only the age bound can call this one an orphan.
  const temp = `${p.presentationLockPath}.tmp.${process.pid}.0b6f6c1e-8a3e-4d2a-9a51-3c1f0e2b7d44`;
  writeFileSync(temp, '');
  const old = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(temp, old, old);

  const result = spawnSync(process.execPath, [bin, 'reap'], { encoding: 'utf8', env: e });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'swept 1 orphaned temp file(s)\n');
  assert.equal(existsSync(temp), false);
});

// Real relay publication and observer admission; only process/terminal discovery is controlled.
function reapFixture(t) {
  const e = env();
  const p = paths(e);
  const registryPaths = relayPaths(e);
  t.after(() => {
    rmSync(e.FAMILIAR_CONFIG_DIR, { recursive: true, force: true });
    rmSync(e.FAMILIAR_STATE_DIR, { recursive: true, force: true });
  });
  writeFileSync(p.schemePath, JSON.stringify({ mode: 'dark', satScale: 1 }));
  const processOps = relayProcessOps();
  const handle = processOps.handleOf(process.pid);
  const emitted = [];
  const deps = {
    paths: p,
    relay: {
      readSnapshot: () => readSnapshot({ paths: registryPaths }),
      reapRegistry: () => reapRegistry({ paths: registryPaths }),
    },
    relayProcess: processOps,
    renderProcess: {
      startTimeOf: () => 20, ownerAlive: () => true,
      lockHolderAlive: () => true, pidExists: () => true,
    },
    adapterFor: () => ({ resolveSessionPid: () => process.pid, resolveTerminalPid: () => 84 }),
    gitContext: async () => ({ remote: null, repoRoot: null, repositoryRoot: null }),
    emitTransition: async (args) => { emitted.push(args); return { kind: 'unchanged' }; },
    env: {},
  };
  const event = (kind = 'session-start', sid = 'reap-session') => ({
    schema: 1, kind, harness: 'claude-code',
    nativeEvent: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'session-end': 'SessionEnd' }[kind],
    sessionId: sid, agentId: `claude-code:${sid}`, cwd: '/repo', tool: null,
  });
  const publish = (ev, processHandle = handle) => applyEvent(ev, {
    paths: registryPaths,
    processOps: { ...processOps, handleOf: () => processHandle, probe: () => ({ status: 'alive' }) },
    resolveSessionPid: () => process.pid, gitContext: deps.gitContext,
  });
  const admit = async (sid) => {
    const ev = event('session-start', sid);
    const { snapshot } = await publish(ev);
    const result = await observe({ text: JSON.stringify({
      schema: 1, type: 'event', subscriber: 'familiar', event: ev,
      registry: { generation: snapshot.generation, revision: snapshot.revision }, changed: true, reaped: [],
    }), deps });
    assert.deepEqual(result, { exitCode: 0, lines: [] });
  };
  const run = async () => {
    const { reap } = await import('../bin/familiar-commands.js');
    assert.equal(typeof reap, 'function', 'reap exposes the env-free presentation transaction');
    return reap({ deps });
  };
  return { e, p, deps, handle, emitted, event, publish, admit, run };
}

test('reap prunes a dead relay agent and reconciles even when nothing was pruned', async (t) => {
  const f = reapFixture(t);
  await f.admit();
  await f.publish(f.event('prompt'));
  assert.equal(JSON.parse(readFileSync(f.p.intentPath))['reap-session'].current.state, 'idle');
  assert.deepEqual(await f.run(), { reaped: [], awaiting: [], ended: [], pruned: 0, renders: 0, swept: 0, statusline: 0, lines: [] });
  assert.equal(JSON.parse(readFileSync(f.p.intentPath))['reap-session'].current.state, 'working');
  await f.publish(f.event('prompt'), { ...f.handle, start: String(BigInt(f.handle.start) + 1n) });
  const result = await f.run();
  assert.deepEqual(result.reaped, ['claude-code:reap-session']);
  assert.deepEqual(JSON.parse(readFileSync(f.p.intentPath)), {});
  assert.deepEqual(Object.keys((await readSessions(f.p.sessionsPath)).ended), ['reap-session']);
});

test('reap lists registry agents awaiting their first event in JSON and pretty output', async (t) => {
  const f = reapFixture(t);
  await f.publish(f.event());
  for (const args of [['--json', 'reap'], ['reap']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: f.e });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (args[0] === '--json') assert.deepEqual(JSON.parse(result.stdout), {
      reaped: [], awaiting: ['reap-session'], ended: [], pruned: 0, renders: 0, swept: 0, statusline: 0,
    });
    else assert.equal(result.stdout, 'awaiting reap-session\n');
  }
  assert.deepEqual((await readSessions(f.p.sessionsPath)).sessions, {});
});

test('reap drops ended evidence only for a dead terminal owner under the presentation lock', async (t) => {
  const f = reapFixture(t);
  await f.admit();
  await f.publish(f.event('session-end'));
  assert.deepEqual((await f.run()).ended, [], 'a live owner keeps its cleanup evidence');
  const { entryPath } = terminalOwnerPaths(f.p.transmitDir, { pid: 84, starttime: 20 });
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, JSON.stringify({ sessionId: 'reap-session', seq: 1 }));
  let probes = 0;
  f.deps.renderProcess.ownerAlive = (pid, stamp) => {
    if (probes++ === 0) assert.equal(existsSync(f.p.presentationLockPath), true);
    assert.deepEqual([pid, stamp], [84, { starttime: 20 }]);
    return false;
  };
  const result = await f.run();
  assert.deepEqual(result.ended, ['reap-session']);
  assert.deepEqual((await readSessions(f.p.sessionsPath)).ended, {});
  assert.equal(existsSync(entryPath), false, 'terminal ownership evidence is pruned too');
});

test('reap reports removed ended evidence in pretty output', async (t) => {
  const f = reapFixture(t);
  f.deps.adapterFor = () => ({ resolveSessionPid: () => process.pid, resolveTerminalPid: () => process.pid });
  f.deps.renderProcess.startTimeOf = () => startTimeOf(process.pid) + 1;
  await f.admit();
  await f.publish(f.event('session-end'));
  const result = spawnSync(process.execPath, [bin, 'reap'], { encoding: 'utf8', env: f.e });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'ended reap-session\n');
  assert.deepEqual((await readSessions(f.p.sessionsPath)).ended, {});
});

test('reap removes statusline files of sessions that are gone', async (t) => {
  const f = reapFixture(t);
  await f.admit();
  const stateDir = f.p.stateDir;
  const old = (Date.now() - 2 * 600_000) / 1000;
  const writeJson = (path, value, mtime) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    if (mtime !== undefined) utimesSync(path, mtime, mtime);
  };
  const sessionFile = (sid, taskId, worktree) => {
    const path = sessionFilePath(stateDir, sid);
    writeJson(path, { taskId, worktree, seenAt: '2026-11-01T00:00:00Z' });
    return path;
  };
  const cacheFile = (taskId, worktree, mtime) => {
    const paths = cachePaths(stateDir, taskId, worktree);
    writeJson(paths.file, { taskId, worktree, stage: 'done' }, mtime);
    return paths;
  };
  const live = sessionFile('reap-session', 'fam-aaaaaa', '/w/live');
  const gone = sessionFile('gone-session', 'fam-bbbbbb', '/w/gone');
  const named = cacheFile('fam-aaaaaa', '/w/live', old);            // old, but a live session names it
  const unnamed = cacheFile('fam-bbbbbb', '/w/gone', old);          // old and named by no remaining file
  writeJson(unnamed.lock, { pid: 1, at: new Date(Date.now() - 3_600_000).toISOString() });
  const young = cacheFile('fam-cccccc', '/w/young');                // within the ceiling
  const held = cacheFile('fam-dddddd', '/w/held', old);             // a live refresher holds its lock
  writeJson(held.lock, { pid: process.pid, at: new Date().toISOString() });

  const result = await f.run();
  assert.equal(result.statusline, 3);
  assert.equal(existsSync(gone), false);
  assert.equal(existsSync(unnamed.file), false);
  assert.equal(existsSync(unnamed.lock), false);
  for (const kept of [live, named.file, young.file, held.file, held.lock]) assert.equal(existsSync(kept), true, kept);

  assert.equal((await f.run()).statusline, 0, 'nothing left to prune');

  // The pretty output names the removals, like the ledgers and temps beside it.
  sessionFile('another-gone', 'fam-eeeeee', '/w/another');
  const home = mkdtempSync(join(tmpdir(), 'familiar-reap-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = spawnSync(process.execPath, [bin, 'reap'], { encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin', HOME: home, FAMILIAR_CONFIG_DIR: f.e.FAMILIAR_CONFIG_DIR,
    FAMILIAR_STATE_DIR: f.e.FAMILIAR_STATE_DIR, RELAY_STATE_DIR: f.e.RELAY_STATE_DIR,
    FAMILIAR_THEMES_DIR: f.e.FAMILIAR_THEMES_DIR,
  } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^pruned 1 status line file\(s\)$/m);
});

test('reap sweeps a dead writer\'s temps from the status line\'s session and cache dirs', async (t) => {
  const f = reapFixture(t);
  const dead = 999_999_999;
  f.deps.renderProcess.pidExists = (pid) => pid !== dead;
  const uuid = '0b6f6c1e-8a3e-4d2a-9a51-3c1f0e2b7d44';
  const session = `${sessionFilePath(f.p.stateDir, 'some-session')}.tmp.${dead}.${uuid}`;
  const cache = `${cachePaths(f.p.stateDir, 'fam-aaaaaa', '/w').file}.tmp.${dead}.${uuid}`;
  const live = `${cachePaths(f.p.stateDir, 'fam-bbbbbb', '/w').file}.tmp.${process.pid}.${uuid}`;
  for (const path of [session, cache, live]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  const result = await f.run();
  assert.equal(result.swept, 2);
  assert.equal(result.statusline, 0, 'a temp is not a session file or a cache');
  assert.equal(existsSync(session), false);
  assert.equal(existsSync(cache), false);
  assert.equal(existsSync(live), true, 'a live writer\'s fresh temp stays');
});

// A SessionEnd observer runs under relay's tightest teardown budget (codex: 267 ms at the
// default outer timeout), and most of a cold `familiar observe` was module loading. A
// teardown drops presentation state and resets the terminal: it never resolves a theme,
// reads config or draws, so it must not load the theme contract, the YAML or TOML parsers,
// or the CLI's other commands. module.registerHooks arrived in Node 22.15, and the admitted
// session's terminal owner is this test process, which only Linux can target without a tty.
const traceHook = fileURLToPath(new URL('fixtures/trace-imports.mjs', import.meta.url));
const traceSkip = typeof nodeModule.registerHooks !== 'function' ? 'module.registerHooks needs Node 22.15 or later'
  : process.platform !== 'linux' ? 'the traced teardown targets a /proc terminal owner' : false;
const heavyModule = (url) => /\/node_modules\/(familiar-theme|yaml|smol-toml)\//.test(url)
  || url.endsWith('/bin/familiar-commands.js');

function tracedObserve(t, e, envelope) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, 'trace.txt');
  writeFileSync(trace, '');
  const result = spawnSync(process.execPath, ['--import', traceHook, bin, 'observe'], {
    input: JSON.stringify(envelope),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FAMILIAR_CONFIG_DIR: e.FAMILIAR_CONFIG_DIR,
      FAMILIAR_STATE_DIR: e.FAMILIAR_STATE_DIR,
      FAMILIAR_THEMES_DIR: e.FAMILIAR_THEMES_DIR,
      RELAY_STATE_DIR: e.RELAY_STATE_DIR,
      FAMILIAR_TRACE_IMPORTS: trace,
    },
  });
  return { result, loaded: readFileSync(trace, 'utf8').split('\n').filter(Boolean) };
}

const envelopeFor = (event, snapshot) => ({
  schema: 1, type: 'event', subscriber: 'familiar', event,
  registry: { generation: snapshot.generation, revision: snapshot.revision }, changed: true, reaped: [],
});

test('a SessionEnd ends an admitted session without loading the theme contract, YAML, TOML or the other commands', { skip: traceSkip }, async (t) => {
  const f = reapFixture(t);
  // The owner is this process with a starttime it never had: dead on every host.
  f.deps.adapterFor = () => ({ resolveSessionPid: () => process.pid, resolveTerminalPid: () => process.pid });
  f.deps.renderProcess.startTimeOf = () => startTimeOf(process.pid) + 1;
  await f.admit();
  const end = f.event('session-end');
  const { snapshot } = await f.publish(end);
  const { result, loaded } = tracedObserve(t, f.e, envelopeFor(end, snapshot));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  // The emission section ran: the drop leaves ended evidence that only an emission's
  // outcome acknowledges (owner-dead here; the fake admission wrote no ledger, so nothing
  // supersedes it), and the cleanup after it prunes the dead owner's ledger.
  const after = await readSessions(f.p.sessionsPath);
  assert.equal(Object.hasOwn(after.sessions, 'reap-session'), false);
  assert.deepEqual(after.ended, {});
  assert.ok(loaded.some((url) => url.endsWith('/src/render/term/emit.js')), 'the trace saw the emission section');
  assert.deepEqual(loaded.filter(heavyModule), []);
});

// The control for the teardown trace: an envelope that resolves visuals loads both. A
// reconcile, not a hook event, because a hook event's enrichment proves process ownership
// first, and a refusal there (this test process is not the session's harness) returns
// before visuals load. The prompt event this used passed only while enrichment's
// identity module happened to import the theme contract for its slot count.
test('the import trace sees the theme contract and YAML on an envelope that resolves visuals', { skip: traceSkip }, async (t) => {
  const f = reapFixture(t);
  await f.admit();
  const snapshot = await readSnapshot({ paths: relayPaths(f.e) });
  const { result, loaded } = tracedObserve(t, f.e, {
    schema: 1, type: 'reconcile', subscriber: 'familiar', event: null,
    registry: { generation: snapshot.generation, revision: snapshot.revision }, changed: false, reaped: [],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(loaded.some((url) => url.endsWith('/src/observe/context.js')), 'the reconcile resolved visuals');
  const heavy = loaded.filter(heavyModule).map((url) => url.replace(/^.*\/node_modules\/([^/]+)\/.*$/, '$1'));
  assert.ok(heavy.includes('familiar-theme') && heavy.includes('yaml'), `loaded: ${[...new Set(heavy)].join(', ')}`);
});

test('reap never emits and never touches familiar old agents or lock files', async (t) => {
  const f = reapFixture(t);
  await f.admit();
  f.emitted.length = 0;
  writeFileSync(join(f.p.stateDir, 'agents.json'), 'old familiar agents');
  writeFileSync(join(f.p.stateDir, 'agents.lock'), 'old familiar lock');
  await f.publish(f.event('prompt'));
  await f.run();
  assert.deepEqual(f.emitted, []);
  assert.equal(readFileSync(join(f.p.stateDir, 'agents.json'), 'utf8'), 'old familiar agents');
  assert.equal(readFileSync(join(f.p.stateDir, 'agents.lock'), 'utf8'), 'old familiar lock');
});

test('reap rejects an existing relay directory at 0755 before changing sessions', async (t) => {
  const f = reapFixture(t);
  await f.admit();
  const before = readFileSync(f.p.sessionsPath, 'utf8');
  chmodSync(f.e.RELAY_STATE_DIR, 0o755);
  for (const args of [['reap'], ['--json', 'reap']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: f.e });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^familiar: reap: IO_ERROR: [^\n]+\n$/);
    assert.equal(readFileSync(f.p.sessionsPath, 'utf8'), before);
  }
});

test('reap accepts an absent relay directory and reconciles to no sessions', async (t) => {
  const f = reapFixture(t);
  const result = spawnSync(process.execPath, [bin, '--json', 'reap'], { encoding: 'utf8', env: f.e });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { reaped: [], awaiting: [], ended: [], pruned: 0, renders: 0, swept: 0, statusline: 0 });
  assert.deepEqual((await readSessions(f.p.sessionsPath)).sessions, {});
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

// --- the native HUD --------------------------------------------------------

// ONE env for both commands. env() mints a fresh temp config dir per call, so calling it
// twice would write the scheme into a directory the status line never reads.
function statuslineEnv() {
  const e = isolatedEnv();
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

// Publish through relay and admit through the observer without touching the live terminal.
async function seedBus(e, sessionId, {
  state = 'working', cwd = process.cwd(), projectColor = null, repository = true,
  harness = 'claude-code',
} = {}) {
  const p = paths(e);
  const registryPaths = relayPaths(e);
  const processOps = relayProcessOps();
  const gitContext = async () => ({ remote: null, repoRoot: repository ? cwd : null,
    repositoryRoot: repository ? cwd : null });
  const kind = { working: 'prompt', idle: 'session-start', done: 'turn-end', error: 'turn-error' }[state];
  const nativeEvent = { working: 'UserPromptSubmit', idle: 'SessionStart', done: 'Stop', error: 'StopFailure' }[state];
  const event = { schema: 1, kind, harness, nativeEvent,
    sessionId, agentId: `${harness}:${sessionId}`, cwd, tool: null };
  const { snapshot } = await applyEvent(event, { paths: registryPaths, processOps,
    resolveSessionPid: () => process.pid, gitContext });
  const result = await observe({ text: JSON.stringify({
    schema: 1, type: 'event', subscriber: 'familiar', event,
    registry: { generation: snapshot.generation, revision: snapshot.revision }, changed: true, reaped: [],
  }), deps: {
    paths: p, relay: { readSnapshot: () => readSnapshot({ paths: registryPaths }) },
    relayProcess: processOps,
    adapterFor: () => ({ resolveSessionPid: () => process.pid, resolveTerminalPid: () => process.pid }),
    gitContext, lookupProjectColor: async () => ({ color: projectColor, root: null, warnings: [] }),
    loadContext: () => loadContext({ paths: p }),
    emitTransition: async () => ({ kind: 'unchanged' }), env: e,
  } });
  assert.deepEqual(result, { exitCode: 0, lines: [] });
  return (await readSessions(p.sessionsPath)).sessions[sessionId];
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
//
// Every subprocess here (the status line, the refresher it spawns, the fake `tasks` and
// flow-state) runs with an env built key by key: no inherited variable, HOME and the park
// store's XDG_STATE_HOME under a test-owned root, and git kept off the host's config.

const STAGE_ID = 'fam-8f0f2b';
const stageFakeTasks = (root) => `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/tasks.log'
case "$*" in
  "claims --json") cat '${root}/claims.json' ;;
  "where --json") printf '%s' '{"project":{"prefix":"fam","records":"${root}/records"}}' ;;
  "show ${STAGE_ID} --json") printf '%s' '{"task":{"id":"${STAGE_ID}","status":"doing"}}' ;;
  "list --parked --json") printf '%s' '{"tasks":[]}' ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
`;
const stageFakeFlow = (root) => `#!/bin/sh
printf '%s\\n' "flow-state $*" >> '${root}/tasks.log'
printf '%s' '{"state":"outside"}'
`;

function stageFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-stage-cli-')));
  const dirs = {
    bin: join(root, 'bin'), home: join(root, 'home'), xdgState: join(root, 'xdg-state'),
    tasksDir: join(root, 'records', 'tasks'), worktree: join(root, 'worktree'),
    config: join(root, 'config'), state: join(root, 'state'),
  };
  const flowDir = join(dirs.home, '.agents', 'bin');
  for (const dir of [...Object.values(dirs), flowDir]) mkdirSync(dir, { recursive: true });
  t.after(() => {
    for (const dir of [dirs.state, join(dirs.state, 'statusline')]) if (existsSync(dir)) chmodSync(dir, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(dirs.bin, 'tasks'), stageFakeTasks(root), { mode: 0o755 });
  writeFileSync(join(flowDir, 'flow-state'), stageFakeFlow(root), { mode: 0o755 });
  writeFileSync(join(root, 'claims.json'), JSON.stringify({ claims: [] }));
  const e = isolatedEnv({ root, bin: dirs.bin });
  const seeded = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e });
  assert.equal(seeded.status, 0, `scheme set failed: ${seeded.stderr}`);
  const claim = (session, id = STAGE_ID) => writeFileSync(join(root, 'claims.json'), JSON.stringify({ claims: [
    { id, session, started: '2026-11-01T00:00:00Z', worktree: dirs.worktree, live: true },
  ] }));
  const cache = cachePaths(dirs.state, STAGE_ID, dirs.worktree);
  const writeFreshCache = (stage) => {
    const parkStore = parkStorePath('fam', e);
    mkdirSync(dirname(cache.file), { recursive: true });
    writeFileSync(cache.file, JSON.stringify({
      taskId: STAGE_ID, worktree: dirs.worktree,
      tasksDir: dirs.tasksDir, tasksDirMtimeNs: mtimeStamp(dirs.tasksDir),
      parkStore, parkStoreMtimeNs: mtimeStamp(parkStore),
      stage, fault: null, refreshedAt: new Date().toISOString(),
    }));
  };
  const log = () => (existsSync(join(root, 'tasks.log'))
    ? readFileSync(join(root, 'tasks.log'), 'utf8').trim().split('\n') : []);
  // The payload's cwd is the claim's worktree, which is no repository: no branch, no git write.
  const render = (sessionId) => {
    const result = statusline(e, [], { session_id: sessionId, cwd: dirs.worktree });
    assert.equal(result.status, 0, result.stderr);
    return { stateRow: strip(result.stdout).trimEnd().split('\n').at(-1), stdout: strip(result.stdout), stderr: result.stderr };
  };
  return { root, dirs, e, claim, cache, writeFreshCache, log, render };
}

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

// The spec's cold cost gate, as what a render-cache hit loads. A session with no live claim
// and no session file loads stagesession.js and none of the stage reader's modules; one with
// a task loads the stage reader, and never the refresher's graph or the HUD's.
function tracedStatusline(t, e, payload) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, 'trace.txt');
  writeFileSync(trace, '');
  const result = spawnSync(process.execPath, ['--import', traceHook, bin, 'statusline'], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...e, FAMILIAR_TRACE_IMPORTS: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  return { result, loaded: readFileSync(trace, 'utf8').split('\n').filter(Boolean) };
}
const termModule = (name) => (url) => url.endsWith(`/src/render/term/${name}`);

test('a render-cache hit with no task loads only the session-file check', { skip: traceSkip }, async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'taskless');
  f.render('taskless');
  plantSentinel(f.e, 'taskless');
  const { result, loaded } = tracedStatusline(t, f.e, { session_id: 'taskless', cwd: f.dirs.worktree });
  assert.equal(result.stdout, SENTINEL);
  assert.equal(result.stderr, '');
  const stage = ['stagecache.js', 'stagerefresh.js', 'stage.js', 'absent.js', 'hud.js'];
  assert.deepEqual(loaded.filter((url) => stage.some((name) => termModule(name)(url))), []);
  assert.ok(loaded.some(termModule('stagesession.js')), 'the trace saw the session-file check');
  assert.equal(existsSync(join(f.dirs.state, 'statusline')), false, 'no task, no session file');
});

test('a render-cache hit with a task loads the stage reader, not the refresher or the HUD', { skip: traceSkip }, async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'tasked');
  f.claim('tasked');
  f.writeFreshCache('designed');
  f.render('tasked');
  plantSentinel(f.e, 'tasked');
  rmSync(join(f.root, 'tasks.log'), { force: true });
  const { result, loaded } = tracedStatusline(t, f.e, { session_id: 'tasked', cwd: f.dirs.worktree });
  assert.equal(result.stdout, SENTINEL);
  assert.equal(result.stderr, '');
  const heavy = ['stagerefresh.js', 'stage.js', 'hud.js'];
  assert.deepEqual(loaded.filter((url) => heavy.some((name) => termModule(name)(url))), []);
  assert.ok(loaded.some(termModule('stagecache.js')), 'the trace saw the stage read');
  assert.deepEqual(f.log(), ['claims --json'], 'a fresh cache starts no refresher');
});

// --- decay -----------------------------------------------------------------
//
// bin/familiar took `.current`, which discards expiresAt. That was survivable while the status
// line ran about once a turn. POLLING MAKES IT PERMANENT: done carries an 8s TTL and error a
// 30s one, so a polled HUD reading .current shows the transient state every two seconds,
// forever.

for (const state of ['done', 'error']) {
  test(`an expired ${state} decays to idle rather than showing ${state} forever`, async () => {
    const e = statuslineEnv();
    const sessionId = `decays-${state}`;
    await seedBus(e, sessionId, { state });
    const result = statusline({ ...e, FAMILIAR_NOW_MS: String(Date.now() + 60_000) }, [], {
      session_id: sessionId, cwd: process.cwd(),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /idle/);
    assert.doesNotMatch(result.stdout, new RegExp(state));
  });
}

// --- the render cache --------------------------------------------------------
//
// A poll whose inputs have not changed prints the cached line without loading the renderer.
// The SENTINEL proves a hit: it is written over the cached output under the same key, and only
// a hit can print it.

const SENTINEL = 'served from the render cache\n';
function plantSentinel(e, sessionId) {
  const path = renderCachePath(paths(e).stateDir, sessionId);
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...entry, output: SENTINEL }));
}
const atClock = (e, ms) => ({ ...e, FAMILIAR_NOW_MS: String(ms) });

test('an unchanged poll is served from the render cache, and a changed input renders afresh', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'cached');
  const payload = { session_id: 'cached', cwd: process.cwd(), context_window: { used_percentage: 22 } };
  const first = statusline(e, [], payload);
  assert.equal(first.status, 0, first.stderr);
  assert.match(strip(first.stdout), /22%/);

  plantSentinel(e, 'cached');
  assert.equal(statusline(e, [], payload).stdout, SENTINEL);

  const moved = statusline(e, [], { ...payload, context_window: { used_percentage: 23 } });
  assert.match(strip(moved.stdout), /23%/, 'a payload field the HUD shows is part of the key');

  plantSentinel(e, 'cached');
  await seedBus(e, 'cached', { state: 'idle' });
  const record = statusline(e, [], { ...payload, context_window: { used_percentage: 23 } });
  assert.match(strip(record.stdout), /idle/, 'this session\'s bus record is part of the key');

  plantSentinel(e, 'cached');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'motion: off\n');
  const config = statusline(e, [], { ...payload, context_window: { used_percentage: 23 } });
  assert.notEqual(config.stdout, SENTINEL, 'config.yaml is part of the key');
  assert.ok(!config.stdout.includes(PLACEHOLDER), 'motion off drops the cells');
});

// Which pack a session draws from is keyed already: its family and role are on its record,
// and `families:` is in config.yaml. The pack itself is keyed by each installed theme's
// descriptor, so `theme add` (with or without --replace, which renames a new pack into place),
// `theme remove` and an edit to a theme.yaml (its roles, rows or world) are each a miss, in the
// user's themes and the shipped ones alike, without the hit path reading any YAML.
test('a family, a role, a families: entry and a theme pack added, edited, replaced or removed are each a miss', async () => {
  const shipped = mkdtempSync(join(tmpdir(), 'familiar-keyed-themes-'));
  writeTheme(shipped, 'cats');
  const e = { ...statuslineEnv(), FAMILIAR_THEMES_DIR: shipped };
  const userThemes = join(e.FAMILIAR_CONFIG_DIR, 'themes');
  writeTheme(userThemes, 'forest');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\n');
  await seedBus(e, 'keyed');
  const payload = { session_id: 'keyed', cwd: process.cwd() };
  const miss = (label) => {
    const result = statusline(e, [], payload);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout, SENTINEL, label);
  };
  miss('first render');
  plantSentinel(e, 'keyed');
  assert.equal(statusline(e, [], payload).stdout, SENTINEL, 'an unchanged poll hits');

  const setRecord = async (fields) => {
    const store = await readSessions(paths(e).sessionsPath);
    Object.assign(store.sessions.keyed, fields);
    await writeSessions(paths(e).sessionsPath, store);
  };
  await setRecord({ family: 'guild' });
  miss('the record\'s family is part of the key');
  plantSentinel(e, 'keyed');
  await setRecord({ role: 'reviewer' });
  miss('the record\'s role is part of the key');
  plantSentinel(e, 'keyed');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nfamilies:\n  guild: forest\n');
  miss('families: is part of the key');

  plantSentinel(e, 'keyed');
  const descriptor = join(userThemes, 'forest', 'theme.yaml');
  writeFileSync(descriptor, readFileSync(descriptor, 'utf8').replace('rows: 4', 'rows: 3'));
  miss('an edit to the family theme\'s theme.yaml is part of the key');

  plantSentinel(e, 'keyed');
  renameSync(join(userThemes, 'forest'), join(userThemes, '.forest-backup'));
  writeTheme(userThemes, 'forest');
  miss('a pack renamed into place (theme add --replace) is part of the key');

  plantSentinel(e, 'keyed');
  writeTheme(userThemes, 'plants');
  miss('a newly added theme is part of the key');

  plantSentinel(e, 'keyed');
  rmSync(join(userThemes, 'plants'), { recursive: true });
  miss('a removed theme is part of the key');

  plantSentinel(e, 'keyed');
  const shippedDescriptor = join(shipped, 'cats', 'theme.yaml');
  writeFileSync(shippedDescriptor, readFileSync(shippedDescriptor, 'utf8').replace('label: Fixture', 'label: Edited'));
  miss('an edit to a shipped theme.yaml is part of the key');
});

test('a cached line outlives neither the TTL nor its intent\'s decay', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'decaying', { state: 'done' });
  const payload = { session_id: 'decaying', cwd: process.cwd() };
  const at = Date.now();
  assert.match(strip(statusline(atClock(e, at), [], payload).stdout), /done/);
  plantSentinel(e, 'decaying');
  assert.equal(statusline(atClock(e, at + 1000), [], payload).stdout, SENTINEL);
  const decayed = statusline(atClock(e, at + 9000), [], payload);
  assert.match(strip(decayed.stdout), /idle/, 'done decays at 8 s, cache or no cache');

  const later = at + 9000;
  plantSentinel(e, 'decaying');
  assert.equal(statusline(atClock(e, later + RENDER_TTL_MS - 1), [], payload).stdout, SENTINEL);
  assert.notEqual(statusline(atClock(e, later + RENDER_TTL_MS), [], payload).stdout, SENTINEL,
    'past the TTL the line renders again, for inputs the key does not cover');
});

test('--with output, a faulted line and a session-less payload are never cached', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'uncached');
  const cacheDir = renderCacheDir(paths(e).stateDir);
  assert.equal(statusline(e, ['--with', 'printf custom'], { session_id: 'uncached', cwd: process.cwd() }).status, 0);
  assert.equal(statusline(e, [], { session_id: '', cwd: process.cwd() }).status, 0);
  assert.equal(existsSync(cacheDir), false);

  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'),
    `identities:\n  - path: ${JSON.stringify(process.cwd())}\n    slot: 0\n    members: { cats: missing-cat }\n`);
  for (let i = 0; i < 2; i++) {
    const faulted = statusline(e, [], { session_id: 'uncached', cwd: process.cwd() });
    assert.match(faulted.stderr, /missing-cat/, 'the fault is said on every poll');
  }
  assert.equal(existsSync(cacheDir), false);
});

// settle() answers noop for provisional evidence it cannot settle yet (another tmux client, tmux
// gone): the next poll must try again, as it did before the cache.
test('a line whose image is still provisional is rendered again on every poll', async () => {
  const e = statuslineEnv();
  const record = await seedBus(e, 'provisional');
  const { entryPath } = ledgerPaths(paths(e).transmitDir, 'provisional');
  mkdirSync(dirname(entryPath), { recursive: true });
  const ledger = JSON.stringify({ seq: 1, pid: record.pid, starttime: record.starttime, ended: false,
    presented: 'working', held: { provisional: true, transport: 'tmux:not-this-terminal' } });
  writeFileSync(entryPath, ledger);
  // Another session owns the terminal, so settling stops before any platform's tty probe.
  // The provisional ledger must still prevent caching even when settling is superseded.
  const owner = terminalOwnerPaths(paths(e).transmitDir, record);
  mkdirSync(dirname(owner.entryPath), { recursive: true });
  writeFileSync(owner.entryPath, JSON.stringify({ sessionId: 'another-session', seq: 2 }));
  const payload = { session_id: 'provisional', cwd: process.cwd() };
  for (let i = 0; i < 2; i++) {
    const result = statusline(e, [], payload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
  assert.equal(readFileSync(entryPath, 'utf8'), ledger, 'the settle was a noop');
  assert.equal(existsSync(renderCachePath(paths(e).stateDir, 'provisional')), false);
});

// THE POINT OF THE CACHE: a hit prints without the renderer, the theme contract or YAML.
test('a cache hit loads neither the renderer nor the theme contract nor YAML', { skip: traceSkip }, async (t) => {
  const e = statuslineEnv();
  await seedBus(e, 'light');
  const payload = { session_id: 'light', cwd: process.cwd() };
  assert.equal(statusline(e, [], payload).status, 0);
  plantSentinel(e, 'light');
  const dir = mkdtempSync(join(tmpdir(), 'familiar-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, 'trace.txt');
  writeFileSync(trace, '');
  const result = spawnSync(process.execPath, ['--import', traceHook, bin, 'statusline'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FAMILIAR_CONFIG_DIR: e.FAMILIAR_CONFIG_DIR,
      FAMILIAR_STATE_DIR: e.FAMILIAR_STATE_DIR,
      FAMILIAR_THEMES_DIR: e.FAMILIAR_THEMES_DIR,
      RELAY_STATE_DIR: e.RELAY_STATE_DIR,
      FAMILIAR_TRACE_IMPORTS: trace,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, SENTINEL);
  const loaded = readFileSync(trace, 'utf8').split('\n').filter(Boolean);
  assert.ok(loaded.some((url) => url.endsWith('/src/render/term/render-cache.js')), 'the trace saw the hit path');
  assert.deepEqual(loaded.filter((url) => heavyModule(url)
    || url.endsWith('/src/render/term/statusline.js') || /\/node_modules\/relay\//.test(url)), []);
});

// A session that joins the bus after a HUD-only line was cached gets its cat on the next poll.
test('a session that joins the bus after its line was cached gets its cells next poll', async () => {
  const e = statuslineEnv();
  const payload = { session_id: 'joins', cwd: process.cwd() };
  assert.ok(!statusline(e, [], payload).stdout.includes(PLACEHOLDER));
  plantSentinel(e, 'joins');
  assert.equal(statusline(e, [], payload).stdout, SENTINEL, 'the HUD-only line was cached');
  await seedBus(e, 'joins');
  assert.ok(statusline(e, [], payload).stdout.includes(PLACEHOLDER));
});

test('reap prunes the cached line of a session no longer on the bus', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'kept');
  for (const sid of ['kept', 'gone']) {
    assert.equal(statusline(e, [], { session_id: sid, cwd: process.cwd() }).status, 0);
  }
  const result = spawnSync(process.execPath, [bin, 'reap'], { encoding: 'utf8', env: e });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^pruned 1 cached status line\(s\)$/m);
  assert.ok(existsSync(renderCachePath(paths(e).stateDir, 'kept')));
  assert.equal(existsSync(renderCachePath(paths(e).stateDir, 'gone')), false);
});

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
test('a status line invocation makes exactly one cheap git call', async (t) => {
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

  // A COLD EXEC IS NOT A SECOND GIT CALL. `gitBranch` gives `symbolic-ref` a 250ms budget
  // (BRANCH_TIMEOUT_MS); on macOS the first executions of a just-written unsigned shim script
  // cost about that much on their own, so the cheap call is SIGKILLed, the `rev-parse` fallback
  // fires, and this test counts two calls for a reason that has nothing to do with familiar --
  // measured at 252ms cold and 28ms warm on an M4 during the 2026-08-23 handoff, failing 6 of 6
  // runs. One warm statusline run below was not enough, because it pays the cost at most twice.
  // Exercise the shim directly until it is warm; a genuine extra git call still fails the count.
  for (let i = 0; i < 5; i++) spawnSync(join(fakeBin, 'git'), ['--version'], { env: e });

  await seedBus(e, 'timed');
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

// --- Worktrees: every surface resolves a worktree through its repository ----
//
// One main checkout, an internal and an external worktree, and a symlink to the external one.
// whoami, projects and a real hook (through the benchmark's wrapper, which stands the test
// process in for the agent) must agree on the slot and member, while each keeps its own label.

function worktreeLayout(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-cli-worktrees-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const main = seedRepo(join(temp, 'api'));
  const internal = addWorktree(main, join(main, '.worktrees', 'fix-api'));
  const external = addWorktree(main, join(temp, 'store', 'fix-ext'));
  const link = join(temp, 'link');
  symlinkSync(external, link);
  return { temp, main, internal, external, link };
}

function pinned(identities) {
  const e = isolatedEnv();
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: off\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'), identities);
  return e;
}

function whoami(e, dir) {
  const r = spawnSync(process.execPath, [bin, '--json', 'whoami', dir], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function projectsJson(e, dirs) {
  const r = spawnSync(process.execPath, [bin, '--json', 'projects', ...dirs], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).projects;
}

const observeFixture = fileURLToPath(new URL('fixtures/observe-event.mjs', import.meta.url));
function observerIdentity(e, dir) {
  const r = spawnSync(process.execPath, [observeFixture], {
    cwd: dir, encoding: 'utf8', env: e,
    input: JSON.stringify({ session_id: `cli-parity-${basenameOf(dir)}`, cwd: dir }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const intent = JSON.parse(readFileSync(join(e.FAMILIAR_STATE_DIR, 'intent.json'), 'utf8'));
  return intent[`cli-parity-${basenameOf(dir)}`].current.identity;
}
const basenameOf = (dir) => dir.split('/').at(-1);

const resolvedAs = (color, warnings = []) => JSON.stringify({
  results: [{ input: 'x', kind: 'path', status: 'resolved', prefix: 'api', root: '/reg/api', ...(color ? { color } : {}) }],
  warnings,
});

test('a registered colour reaches whoami, projects and the observer on every worktree', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'), FAKE_TASKS_OUTPUT: resolvedAs('#317d01') };
  for (const dir of [main, internal, external]) {
    const w = whoami(e, dir);
    assert.deepEqual([w.slot, w.color, w.source], [3, '#317d01', 'colour']);
  }
  assert.deepEqual(projectsJson(e, [main, internal]).map((p) => [p.slot, p.color, p.source]),
    [[3, '#317d01', 'colour'], [3, '#317d01', 'colour']]);
  const hooked = observerIdentity(e, internal);
  assert.deepEqual([hooked.slot, hooked.projectColor, hooked.source], [3, '#317d01', 'colour']);
});

test('whoami refuses a pin that disagrees with the colour', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`),
    FAKE_TASKS_OUTPUT: resolvedAs('#317d01') };
  const r = spawnSync(process.execPath, [bin, 'whoami', main], { encoding: 'utf8', env: e });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /pin declares slot 7, but project colour #317d01 \(from tasks\) maps to slot 3/);
});

test('without tasks on PATH whoami behaves as before', (t) => {
  const { temp, main } = worktreeLayout(t);
  const onlyGit = join(temp, 'bin');
  mkdirSync(onlyGit);
  const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(gitPath.status, 0, gitPath.stderr);
  symlinkSync(gitPath.stdout.trim(), join(onlyGit, 'git'));
  const r = spawnSync(process.execPath, [bin, '--json', 'whoami', main], {
    encoding: 'utf8', env: { ...pinned('identities: []\n'), PATH: onlyGit },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const w = JSON.parse(r.stdout);
  assert.deepEqual([w.color, w.source], [null, 'auto']);
});

test('a tasks failure is one error line naming the command', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...isolatedEnv(), FAKE_TASKS_EXIT: '2', FAKE_TASKS_OUTPUT: '',
    FAKE_TASKS_STDERR: "error: unrecognized subcommand 'resolve'\nusage: tasks resolve\r\ntry --help" };
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), '{"mode":"dark","satScale":1}');
  const r = spawnSync(process.execPath, [bin, 'whoami', main], { encoding: 'utf8', env: e });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /tasks resolve .*: exited 2: error: unrecognized subcommand 'resolve'/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.ok(r.stderr.includes('\\nusage: tasks resolve\\r\\ntry --help'));
});

test('projects writes each tasks warning once', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'), FAKE_TASKS_OUTPUT: JSON.stringify({
    results: [{ input: 'x', kind: 'path', status: 'unregistered' }], warnings: ['w1', 'w2', 'w1'],
  }) };
  const r = spawnSync(process.execPath, [bin, '--json', 'projects', main, internal, external], {
    encoding: 'utf8', env: e,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'familiar: tasks: w1\nfamiliar: tasks: w2\n');
  assert.deepEqual(JSON.parse(r.stdout).projects.map((p) => [p.color, p.source]),
    [[null, 'auto'], [null, 'auto'], [null, 'auto']]);
});

test('whoami writes distinct tasks warnings in first-seen order', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'), FAKE_TASKS_OUTPUT: resolvedAs(null, ['w2', 'w1', 'w2']) };
  const r = spawnSync(process.execPath, [bin, '--json', 'whoami', main], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'familiar: tasks: w2\nfamiliar: tasks: w1\n');
  assert.equal(JSON.parse(r.stdout).color, null);
});

test('unpinned remote-less worktrees share the repository slot and keep their labels', (t) => {
  const { main, internal, external, link } = worktreeLayout(t);
  const e = pinned('identities: []\n');
  const seen = [main, internal, external, link].map((dir) => whoami(e, dir));
  assert.deepEqual(seen.map((s) => s.project), ['api', 'fix-api', 'fix-ext', 'fix-ext']);
  assert.equal(new Set(seen.map((s) => s.slot)).size, 1);
  assert.equal(observerIdentity(e, external).slot, seen[0].slot);
});

test('a main path pin reaches every worktree on every surface', (t) => {
  const { main, internal, external, link } = worktreeLayout(t);
  const e = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`);
  for (const dir of [main, internal, external, link]) assert.equal(whoami(e, dir).slot, 7);
  const listed = projectsJson(e, [main, internal, external, link]);
  assert.deepEqual(listed.map((p) => [p.project, p.slot, p.source]), [
    ['api', 7, 'pin'], ['fix-api', 7, 'pin'], ['fix-ext', 7, 'pin'], ['fix-ext', 7, 'pin'],
  ]);
  const hooked = observerIdentity(e, internal);
  assert.deepEqual([hooked.slot, hooked.member, hooked.project], [7, whoami(e, internal).member.id, 'fix-api']);
});

test('worktree path and name pins override inherited ones in their own tiers', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  const paths = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`
    + `  - path: ${JSON.stringify(internal)}\n    slot: 3\n  - project: fix-ext\n    slot: 5\n`);
  assert.equal(whoami(paths, internal).slot, 3);
  assert.equal(whoami(paths, external).slot, 7, 'a name pin never beats the inherited path');
  assert.equal(whoami(paths, main).slot, 7);

  const names = pinned('identities:\n  - project: api\n    slot: 2\n  - project: fix-ext\n    slot: 5\n');
  assert.equal(whoami(names, main).slot, 2);
  assert.equal(whoami(names, internal).slot, 2, 'the repository name is inherited');
  assert.equal(whoami(names, external).slot, 5, 'the exact checkout name wins');
});

test('a matching remote pin dominates every path pin', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  git(main, ['config', 'remote.origin.url', 'git@github.com:example/api.git']);
  const e = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`
    + `  - path: ${JSON.stringify(internal)}\n    slot: 3\n  - remote: github.com/example/api\n    slot: 6\n`);
  for (const dir of [main, internal, external]) assert.equal(whoami(e, dir).slot, 6);
  assert.equal(observerIdentity(e, internal).slot, 6);
});

test('projects with no directories lists path pins only, never their worktrees', (t) => {
  const { main } = worktreeLayout(t);
  const e = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`);
  assert.deepEqual(projectsJson(e, []).map((p) => p.project), ['api']);
});

test('the observer writes tasks warnings to stderr and still records the session', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'),
    FAKE_TASKS_OUTPUT: JSON.stringify({ results: [{ input: main, kind: 'path', status: 'unregistered' }],
      warnings: ['nexc: its checkout is not matched and its color is not reported (bad)'] }) };
  const r = spawnSync(process.execPath, [observeFixture], {
    cwd: main, encoding: 'utf8', env: e, input: JSON.stringify({ session_id: 'warn', cwd: main }) });
  assert.equal(r.status, 0);
  assert.equal(r.stderr,
    'familiar: observe: nexc: its checkout is not matched and its color is not reported (bad)\n');
  const agents = JSON.parse(readFileSync(join(e.FAMILIAR_STATE_DIR, 'sessions.json'), 'utf8')).sessions;
  assert.equal(agents.warn.projectColor, null);
});

test('the status line paints the label in the colour its record carries', async () => {
  const e = isolatedEnv();
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: off\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'identities: []\n');
  e.FAKE_TASKS_LOG = join(e.FAMILIAR_STATE_DIR, 'tasks.log');
  await seedBus(e, 's1', { cwd: '/tmp/api', projectColor: '#317d01' });
  const r = spawnSync(process.execPath, [bin, 'statusline'], {
    input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8', env: e,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.includes(fg('#317d01') + 'api'));
  // The colour comes from the record, never from a `tasks resolve` per render. The one call
  // this path does make is the claim lookup.
  assert.equal(readFileSync(e.FAKE_TASKS_LOG, 'utf8'), 'claims --json\n');
});

// --- Family, theme and role on whoami and projects -------------------------------------

// A `tasks` that registers each checkout at a root of its own, by the path asked for, so
// two checkouts can belong to two families.
function tasksByPath(t, roots) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-tasks-by-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'tasks');
  writeFileSync(script, `#!/usr/bin/env node
const roots = ${JSON.stringify(roots)};
const input = process.argv.at(-1);
console.log(JSON.stringify({ results: [{ input, kind: 'path', status: 'resolved', prefix: 'x', root: roots[input] }], warnings: [] }));
`);
  chmodSync(script, 0o755);
  return dir;
}

function familyLayout(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-cli-families-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const a = seedRepo(join(temp, 'alpha'));
  const b = seedRepo(join(temp, 'beta'));
  mkdirSync(join(a, 'tools'));
  writeFileSync(join(a, 'tools', 'family.toml'), 'name = "guild"\n');
  mkdirSync(join(b, 'tools'));
  writeFileSync(join(b, 'tools', 'family.toml'), 'name = "grove"\n');
  const e = pinned('identities: []\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'),
    'theme: cats\nmotion: off\nfamilies:\n  guild: guild-theme\n  grove: grove-theme\n');
  mkdirSync(join(e.FAMILIAR_CONFIG_DIR, 'themes'));
  writeTheme(join(e.FAMILIAR_CONFIG_DIR, 'themes'), 'guild-theme');
  writeTheme(join(e.FAMILIAR_CONFIG_DIR, 'themes'), 'grove-theme');
  e.PATH = `${tasksByPath(t, { [a]: a, [b]: b })}:${e.PATH}`;
  return { a, b, e };
}

test('whoami reports the family, its theme and the role from FAMILIAR_ROLE', (t) => {
  const { a, e } = familyLayout(t);
  const w = whoami({ ...e, FAMILIAR_ROLE: 'reviewer' }, a);
  assert.deepEqual(
    [w.family, w.theme, w.themeSource, w.role, w.memberSource],
    ['guild', 'guild-theme', 'family', 'reviewer', 'unmapped'],
  );
  assert.equal(typeof w.anchor, 'string');
  const text = spawnSync(process.execPath, [bin, 'whoami', a], {
    encoding: 'utf8', env: { ...e, FAMILIAR_ROLE: 'reviewer' },
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^  family  guild · theme guild-theme \(family\)$/m);
  assert.match(text.stdout, /^  role    reviewer · member .+ \(unmapped\)$/m);
  const bare = whoami(e, a);
  assert.deepEqual([bare.role, bare.memberSource], [null, 'default']);
});

test('whoami refuses a reserved or malformed FAMILIAR_ROLE', (t) => {
  const { a, e } = familyLayout(t);
  for (const role of ['default', 'Reviewer']) {
    const r = spawnSync(process.execPath, [bin, 'whoami', a], { encoding: 'utf8', env: { ...e, FAMILIAR_ROLE: role } });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /FAMILIAR_ROLE/);
  }
});

test('projects lists checkouts with no role even when FAMILIAR_ROLE is set', (t) => {
  const { a, b, e } = familyLayout(t);
  const rows = projectsJson({ ...e, FAMILIAR_ROLE: 'reviewer' }, [a, b]);
  assert.deepEqual(rows.map((p) => [p.project, p.family, p.theme, p.themeSource, p.memberSource]), [
    ['alpha', 'guild', 'guild-theme', 'family', 'default'],
    ['beta', 'grove', 'grove-theme', 'family', 'default'],
  ]);
  assert.equal(Object.hasOwn(rows[0], 'role'), false);
});

test('projects lists two families under two theme headers', (t) => {
  const { a, b, e } = familyLayout(t);
  const r = spawnSync(process.execPath, [bin, '--color', 'never', 'projects', a, b], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  const headers = r.stdout.match(/^  \S+ — .+$/gm);
  assert.equal(headers.length, 2, r.stdout);
  assert.match(headers[0], /^  guild-theme — /);
  assert.match(headers[1], /^  grove-theme — /);
  assert.match(r.stdout, /^      .+ · default · auto$/m);
});
