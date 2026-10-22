import { prepareEnrichment } from '../src/observe/enrich.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvent, readSnapshot } from 'relay';
import { loadThemePack } from 'familiar-theme';
import { observe, reconcile, acknowledgeEnded } from '../src/observe/run.js';
import { paths as familiarPaths } from '../src/bus/paths.js';
import { readSessions } from '../src/bus/sessions.js';
import { readJson } from '../src/bus/store.js';
import { withLock } from '../src/bus/lock.js';

const handle = { platform: 'linux', host: 'test', bootId: '11111111-1111-4111-8111-111111111111', pid: 42, start: '10' };
const git = { remote: null, repoRoot: null, repositoryRoot: null };
const pack = await loadThemePack(new URL('./fixtures/theme-pack', import.meta.url).pathname);
const event = (kind = 'session-start', sid = 's') => ({ schema: 1, kind, harness: 'claude-code', nativeEvent: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'session-end': 'SessionEnd' }[kind], sessionId: sid, agentId: `claude-code:${sid}`, cwd: '/repo', tool: null });
const text = (ev, snapshot) => JSON.stringify({ schema: 1, type: ev ? 'event' : 'reconcile', subscriber: 'familiar', event: ev, registry: { generation: snapshot?.generation ?? null, revision: snapshot?.revision ?? null }, changed: true, reaped: [] });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-observe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const relayDir = join(dir, 'relay');
  const relayPaths = { stateDir: relayDir, agentsPath: join(relayDir, 'agents.json'), lockPath: join(relayDir, 'agents.lock') };
  const paths = familiarPaths({ FAMILIAR_STATE_DIR: join(dir, 'familiar'), FAMILIAR_CONFIG_DIR: join(dir, 'config') });
  const emitted = [];
  const relayProcess = { handleOf: () => handle, probe: () => ({ status: 'alive' }), ancestors: () => [], executableOf: () => null, argvOf: () => [] };
  const deps = {
    paths, relay: { readSnapshot: () => readSnapshot({ paths: relayPaths }) }, relayProcess,
    renderProcess: { startTimeOf: () => 20, ownerAlive: () => true, lockHolderAlive: () => true, pidExists: () => true },
    adapterFor: () => ({ resolveSessionPid: () => 42, resolveTerminalPid: () => 84 }),
    gitContext: async () => git, lookupProjectColor: async () => ({ color: null, warnings: [] }),
    loadContext: async () => ({ paths, pack, catalog: { identities: [] }, tone: { mode: 'dark', satScale: 1 }, motionPolicy: 'full' }),
    emitTransition: async (args) => { emitted.push(args); return { kind: args.next ? 'unchanged' : 'ended' }; },
    lockWith: withLock, now: () => 1000, env: { RELAY_STATE_DIR: relayDir },
  };
  const publish = async (ev) => (await applyEvent(ev, { paths: relayPaths, processOps: relayProcess, gitContext: async () => git, resolveSessionPid: () => 42, now: () => 1000 })).snapshot;
  const run = async (ev = event(), snapshot) => observe({ text: text(ev, snapshot ?? await deps.relay.readSnapshot()), deps });
  return { dir, relayDir, relayPaths, paths, deps, emitted, publish, run };
}

test('admit then transition writes intent and keeps old agents byte-identical', async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.stateDir); await writeFile(join(f.paths.stateDir, 'agents.json'), 'old state untouched');
  await f.publish(event());
  assert.deepEqual(await f.run(), { exitCode: 0, lines: [] });
  assert.equal(f.emitted[0].prev, null); assert.equal(f.emitted[0].provisional, true);
  assert.equal(f.emitted[0].next.pid, 84); assert.equal(f.emitted[0].renderProcess, f.deps.renderProcess);
  await f.publish(event('prompt')); assert.equal((await f.run(event('prompt'))).exitCode, 0);
  assert.equal(f.emitted[1].prev.state, 'idle');
  assert.equal((await readJson(f.paths.intentPath)).s.current.state, 'working');
  assert.equal(await readFile(join(f.paths.stateDir, 'agents.json'), 'utf8'), 'old state untouched');
});

for (const alreadyDropped of [false, true]) test(`teardown resets stored evidence after ${alreadyDropped ? 'another projection' : 'own drop'}`, async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run(); await f.publish(event('session-end'));
  if (alreadyDropped) await reconcile({ deps: f.deps });
  f.deps.adapterFor = () => { throw new Error('teardown must not enrich'); };
  f.deps.loadContext = () => { throw new Error('teardown must not load visuals'); };
  assert.equal((await f.run(event('session-end'))).exitCode, 0);
  assert.equal(f.emitted.at(-1).prev.pid, 84); assert.equal(f.emitted.at(-1).next, null);
  assert.deepEqual((await readSessions(f.paths.sessionsPath)).ended, {});
});

test('ended survives capture, exceptions and unsuccessful reset; only matching acknowledgement consumes it', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run(); await f.publish(event('session-end'));
  f.deps.emitTransition = async () => {
    assert.ok((await readSessions(f.paths.sessionsPath)).ended.s);
    throw new Error('write failed');
  };
  assert.equal((await f.run(event('session-end'))).exitCode, 1);
  const ended = (await readSessions(f.paths.sessionsPath)).ended.s;
  assert.equal(await acknowledgeEnded({ paths: f.paths, sessionId: 's', seq: ended.seq + 1, lockWith: withLock }), false);
  for (const reason of ['open', 'not-a-tty']) {
    f.deps.emitTransition = async () => ({ kind: 'suppressed', reason });
    assert.equal((await f.run(event('session-end'))).exitCode, 0);
    assert.deepEqual((await readSessions(f.paths.sessionsPath)).ended.s, ended);
  }
  f.deps.emitTransition = async () => ({ kind: 'ended' });
  await f.run(event('session-end')); assert.deepEqual((await readSessions(f.paths.sessionsPath)).ended, {});
});

test('locked snapshot ordering: delayed X cannot overwrite Y with its pre-lock snapshot', async (t) => {
  const f = await fixture(t); let snapshot = await f.publish(event());
  f.deps.relay.readSnapshot = async () => structuredClone(snapshot);
  let entered, release; const waiting = new Promise((r) => { entered = r; }); const gate = new Promise((r) => { release = r; });
  const xDeps = { ...f.deps, lockWith: async (path, fn, opts) => { entered(); await gate; return withLock(path, fn, opts); } };
  const x = observe({ text: text(event(), snapshot), deps: xDeps }); await waiting;
  snapshot = await f.publish(event('prompt'));
  assert.equal((await f.run(event('prompt'))).exitCode, 0); release(); assert.equal((await x).exitCode, 0);
  assert.equal((await readSessions(f.paths.sessionsPath)).registry.revision, 2);
  assert.equal((await readJson(f.paths.intentPath)).s.current.state, 'working');
});

test('stale enrichment emits nothing and exits zero', async (t) => {
  const f = await fixture(t); await f.publish(event());
  f.deps.lockWith = async (path, fn, opts) => {
    const snapshot = await readSnapshot({ paths: f.relayPaths });
    snapshot.agents['claude-code:s'].cwd = '/moved';
    await writeFile(f.relayPaths.agentsPath, JSON.stringify(snapshot));
    return withLock(path, fn, opts);
  };
  const result = await f.run(); assert.equal(result.exitCode, 0); assert.match(result.lines[0], /stale/); assert.equal(f.emitted.length, 0);
});

test('vanished non-end event reconciles disappearance without emission', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run(); await f.publish(event('session-end'));
  assert.equal((await f.run(event('prompt'))).exitCode, 0);
  assert.ok((await readSessions(f.paths.sessionsPath)).ended.s); assert.equal(f.emitted.length, 1);
});

test('absent relay projects empty; unsafe relay faults before any presentation write', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).exitCode, 0); assert.deepEqual((await readSessions(f.paths.sessionsPath)).sessions, {});
  await rm(f.paths.stateDir, { recursive: true }); await mkdir(f.relayDir); await chmod(f.relayDir, 0o755);
  const result = await observe({ text: text(event(), null), deps: f.deps });
  assert.equal(result.exitCode, 1); assert.equal(result.lines.length, 1); assert.match(result.lines[0], /IO_ERROR/);
  await assert.rejects(readFile(f.paths.sessionsPath), { code: 'ENOENT' });
});

test('visual faults withdraw incoming visuals and return one error', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  const load = f.deps.loadContext;
  f.deps.loadContext = async () => ({ ...await load(), pack: { ...pack, members: [] } });
  const result = await f.run(event('prompt')); assert.equal(result.exitCode, 1); assert.equal(result.lines.length, 1);
  assert.deepEqual(await readJson(f.paths.intentPath), {}); assert.equal(f.emitted.at(-1).intent, null);
  assert.ok((await readSessions(f.paths.sessionsPath)).sessions.s);
});

test('other events heal admitted sessions but do not admit a missed first observer', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run(); await f.publish(event('prompt'));
  await f.publish(event('session-start', 'missed'));
  assert.deepEqual((await reconcile({ deps: f.deps })).awaiting, ['missed']);
  await f.publish(event('session-start', 'other')); await f.run(event('session-start', 'other'));
  let sessions = (await readSessions(f.paths.sessionsPath)).sessions;
  assert.equal(sessions.s.state, 'working'); assert.equal(sessions.missed, undefined);
  await f.run(event('prompt', 'missed')); sessions = (await readSessions(f.paths.sessionsPath)).sessions;
  assert.ok(sessions.missed);
});

test('corrupt sessions never overwrite existing intent', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  const before = await readFile(f.paths.intentPath, 'utf8'); f.deps.lockWith = async (path, fn, opts) => {
    await writeFile(f.paths.sessionsPath, '{broken');
    return withLock(path, fn, opts);
  };
  assert.equal((await f.run()).exitCode, 1); assert.equal(await readFile(f.paths.intentPath, 'utf8'), before);
});

for (const input of ['', 'not json']) test(`invalid envelope ${JSON.stringify(input)} does no work`, async (t) => {
  const f = await fixture(t); const result = await observe({ text: input, deps: f.deps });
  assert.equal(result.exitCode, 1); assert.equal(result.lines.length, 1); assert.match(result.lines[0], /^familiar: observe:/);
  await assert.rejects(readFile(f.paths.seqPath), { code: 'ENOENT' });
});

test('session-end drop-only median of twenty runs stays under 100 ms', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run(); await f.publish(event('session-end'));
  const samples = [];
  for (let i = 0; i < 20; i++) { const start = performance.now(); assert.equal((await f.run(event('session-end'))).exitCode, 0); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b); const median = (samples[9] + samples[10]) / 2;
  t.diagnostic(`drop-only median: ${median.toFixed(2)} ms`); assert.ok(median < 100);
});

for (const outcome of [{ kind: 'suppressed', reason: 'owner-dead' }, { kind: 'superseded' }, { kind: 'superseded', reason: 'terminal' }]) {
  test(`ended acknowledgement accepts ${JSON.stringify(outcome)}`, async (t) => {
    const f = await fixture(t); await f.publish(event()); await f.run(); await f.publish(event('session-end'));
    f.deps.emitTransition = async () => outcome;
    assert.equal((await f.run(event('session-end'))).exitCode, 0);
    assert.deepEqual((await readSessions(f.paths.sessionsPath)).ended, {});
  });
}

test('reconcile envelope projects without emission', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run(); await f.publish(event('prompt'));
  assert.deepEqual(await observe({ text: text(null, null), deps: f.deps }), { exitCode: 0, lines: [] });
  assert.equal((await readSessions(f.paths.sessionsPath)).sessions.s.state, 'working');
  assert.equal(f.emitted.length, 1);
});

test('a worker event emits for its root session', async (t) => {
  const f = await fixture(t);
  const snapshot = await f.publish(event());
  const root = { ...snapshot.agents['claude-code:s'], id: 'codex:root', sessionId: 'root', harness: 'codex' };
  const worker = { ...root, id: 'codex:worker', sessionId: 'worker', scope: 'worker', root: root.id, state: 'working', updatedAt: 1001 };
  snapshot.agents = { [root.id]: root, [worker.id]: worker };
  f.deps.relay.readSnapshot = async () => snapshot;
  const workerEvent = { ...event('prompt', 'worker'), harness: 'codex', agentId: worker.id, root: root.id };
  assert.equal((await f.run(workerEvent, snapshot)).exitCode, 0);
  assert.equal(f.emitted[0].next.sessionId, 'root'); assert.equal(f.emitted[0].intent.state, 'working');
});

test('late session-end preserves a re-admitted live session and emits nothing', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  await f.publish(event('session-end')); await f.run(event('session-end'));
  await f.publish(event()); await f.run();
  const before = await readFile(f.paths.intentPath, 'utf8'); const count = f.emitted.length;
  assert.equal((await f.run(event('session-end'))).exitCode, 0);
  assert.equal(f.emitted.length, count); assert.equal(await readFile(f.paths.intentPath, 'utf8'), before);
  assert.ok((await readSessions(f.paths.sessionsPath)).sessions.s);
});

test('emission takes the terminal lock before session lock, withdraws null intent, and rejects older owners', async (t) => {
  const { emitTransition } = await import('../src/observe/emission.js');
  const { terminalOwnerPaths } = await import('../src/render/term/terminal-owner.js');
  const { ledgerPaths } = await import('../src/render/term/ledger.js');
  const f = await fixture(t);
  const record = { sessionId: 's', pid: 84, starttime: 20, project: 'repo', state: 'idle' };
  const locks = [];
  const args = {
    prev: null, next: record, intent: null, seq: 2, harness: 'claude-code', paths: f.paths,
    renderProcess: { recordOf: () => ({ tty: 'ttys999' }), startTimeOf: () => 20, ownerAlive: () => false },
    platform: 'darwin', hookEnv: {}, probe: () => null,
    lockWith: (path, fn, opts) => { locks.push(path); return withLock(path, fn, opts); },
  };
  assert.deepEqual(await emitTransition(args), { kind: 'withdrawn' });
  assert.deepEqual(locks, [terminalOwnerPaths(f.paths.transmitDir, record).lockPath, ledgerPaths(f.paths.transmitDir, 's').lockPath]);
  locks.length = 0;
  assert.deepEqual(await emitTransition({ ...args, seq: 1, prev: { ...record, sessionId: 'old' }, next: null }), { kind: 'superseded', reason: 'terminal' });
  assert.equal(locks.length, 1);
  assert.equal(await readJson(ledgerPaths(f.paths.transmitDir, 'old').entryPath), null);
});

// Colour carry cases formerly exercised through the extracted hook transaction.
test('enrichment carries only an own colour from the same session and checkout', async (t) => {
  const f = await fixture(t);
  const snapshot = await f.publish(event());
  const envelope = JSON.parse(text(event(), snapshot));
  const calls = [];
  const prepare = (old, repoRoot = '/repo') => prepareEnrichment({
    ...f.deps, envelope, snapshot, prior: { sessions: { s: old, other: { repoRoot, projectColor: '#abcdef' } } },
    gitContext: async () => ({ remote: null, repoRoot, repositoryRoot: repoRoot }),
    lookupProjectColor: async (dir) => { calls.push(dir); return { color: '#317d01', warnings: ['looked up'] }; },
  });
  for (const old of [undefined, { repoRoot: '/different', projectColor: '#123456' },
    { repoRoot: '/repo' }, Object.assign(Object.create({ projectColor: '#123456' }), { repoRoot: '/repo' })]) {
    const result = await prepare(old);
    assert.equal(result.context.projectColor, '#317d01');
    assert.deepEqual(result.warnings, ['looked up']);
  }
  assert.deepEqual(calls, ['/repo', '/repo', '/repo', '/repo']);
  calls.length = 0;
  for (const projectColor of [null, '#123456']) {
    const result = await prepare({ repoRoot: '/repo', projectColor });
    assert.equal(result.context.projectColor, projectColor);
    assert.deepEqual(result.warnings, []);
  }
  assert.equal((await prepare({ repoRoot: '/repo', projectColor: '#123456' }, null)).context.projectColor, null);
  assert.deepEqual(calls, []);
  await assert.rejects(prepareEnrichment({ ...f.deps, envelope, snapshot, prior: { sessions: {} },
    gitContext: async () => ({ remote: null, repoRoot: '/repo', repositoryRoot: '/repo' }),
    lookupProjectColor: async () => { throw new Error('tasks lookup failed'); },
  }), /tasks lookup failed/);
  assert.equal(await readJson(f.paths.seqPath), null);
  assert.equal(await readJson(f.paths.sessionsPath), null);
  assert.equal(await readJson(f.paths.intentPath), null);
});

test('enrichment looks again after a checkout move, carries across subdirectories, and emits warnings only when looking', async (t) => {
  const f = await fixture(t);
  const snapshot = await f.publish(event());
  const envelope = JSON.parse(text(event(), snapshot));
  const calls = [];
  let prior = { sessions: {} };
  for (const repoRoot of ['/api', '/api', '/web', '/web']) {
    const result = await prepareEnrichment({ ...f.deps, envelope, snapshot, prior,
      gitContext: async () => ({ remote: null, repoRoot, repositoryRoot: repoRoot }),
      lookupProjectColor: async (dir) => { calls.push(dir); return { color: dir === '/api' ? '#317d01' : '#ff0000', warnings: ['looked up'] }; },
    });
    assert.deepEqual(result.warnings, prior.sessions.s?.repoRoot === repoRoot ? [] : ['looked up']);
    prior = { sessions: { s: result.context } };
  }
  assert.deepEqual(calls, ['/api', '/web']);
  assert.equal(prior.sessions.s.projectColor, '#ff0000');
});
