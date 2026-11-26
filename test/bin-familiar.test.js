// The CLI's setup, observe and reap commands, and what a SessionEnd teardown loads.
import { emitTransition } from '../src/observe/emission.js';
import {
  applyEvent, readSnapshot, reapRegistry, paths as relayPaths, createProcessOps as relayProcessOps,
} from 'relay';
import { observe } from '../src/observe/run.js';
import { readSessions } from '../src/bus/sessions.js';
import { terminalOwnerPaths } from '../src/render/term/terminal-owner.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { paths } from '../src/bus/paths.js';
import { ledgerPaths } from '../src/render/term/ledger.js';
import { cachePaths } from '../src/render/term/stagecache.js';
import { sessionFilePath } from '../src/render/term/stagesession.js';
import { startTimeOf } from '../src/bus/proc.js';
import { setupDocument } from '../src/install/setup.js';
import { reportCommandError } from '../bin/familiar.js';
import { settleStatusline } from '../bin/familiar-commands.js';
import {
  bin, repoRoot, env, isolatedEnv, traceHook, traceSkip, heavyModule, statusline,
} from './helpers/familiar-cli.js';

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
  const input = JSON.stringify({ schema: 2, type: 'reconcile', subscriber: 'familiar',
    registry: { status: 'unavailable', code: 'NO_SNAPSHOT' }, reaped: [] });
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

const envelopeFor = ({ kind, harness, nativeEvent, cwd, agentId, sessionId }, snapshot) => ({
  schema: 2, type: 'event', subscriber: 'familiar',
  event: { schema: 2, kind, harness, nativeEvent, cwd, identity: { status: 'valid', value: { agentId, sessionId } },
    facts: {}, tool: null, private: {} },
  registry: { status: 'ready', generation: snapshot.generation, revision: snapshot.revision },
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
    schema: 2, type: 'reconcile', subscriber: 'familiar',
    registry: { status: 'ready', generation: snapshot.generation, revision: snapshot.revision }, reaped: [],
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
