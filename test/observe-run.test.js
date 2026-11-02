import { prepareEnrichment } from '../src/observe/enrich.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvent, normalizeEvent, readSnapshot } from 'relay';
import { loadThemePack } from 'familiar-theme';
import { observe, reconcile, acknowledgeEnded } from '../src/observe/run.js';
import { paths as familiarPaths } from '../src/bus/paths.js';
import { readSessions } from '../src/bus/sessions.js';
import { readJson } from '../src/bus/store.js';
import { withLock } from '../src/bus/lock.js';
import { readAttention } from '../src/attention/store.js';
import { loadContext, makePrepareSprites, themeSet, visualResolver } from '../src/observe/context.js';
import { loadConfig } from '../src/config.js';
import { preloadedThemes, writeTheme } from './helpers/themes.js';

const handle = { platform: 'linux', host: 'test', bootId: '11111111-1111-4111-8111-111111111111', pid: 42, start: '10' };
const git = { remote: null, repoRoot: null, repositoryRoot: null };
const pack = await loadThemePack(new URL('./fixtures/theme-pack', import.meta.url).pathname);
// The context loadContext returns, over the one preloaded fixture pack as the default theme.
const fakeContext = (paths, fixturePack) => ({
  paths, config: { themeId: 'fixture', families: {}, motionPolicy: 'full' }, motionPolicy: 'full',
  tone: { mode: 'dark', satScale: 1 }, catalog: { identities: [] }, themes: preloadedThemes({ fixture: fixturePack }),
});
const event = (kind = 'session-start', sid = 's') => ({ schema: 1, kind, harness: 'claude-code', nativeEvent: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'session-end': 'SessionEnd', 'needs-approval': 'Notification:permission_prompt' }[kind], sessionId: sid, agentId: `claude-code:${sid}`, cwd: '/repo', tool: null });
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
    loadContext: async () => fakeContext(paths, pack),
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
  // The registry moves between enrichment and the projection's lock; the first
  // acquisition is attention capture, which precedes enrichment.
  let acquisitions = 0;
  f.deps.lockWith = async (path, fn, opts) => {
    if (++acquisitions === 1) return withLock(path, fn, opts);
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
  assert.equal(result.exitCode, 1); assert.equal(result.lines.length, 2);
  assert.match(result.lines[0], /attention: IO_ERROR/); assert.match(result.lines[1], /IO_ERROR/);
  await assert.rejects(readFile(f.paths.sessionsPath), { code: 'ENOENT' });
  await assert.rejects(readFile(f.paths.attentionPath), { code: 'ENOENT' });
});

test('visual faults withdraw incoming visuals and return one error', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  const load = f.deps.loadContext;
  f.deps.loadContext = async () => ({ ...await load(), themes: preloadedThemes({ fixture: { ...pack, members: [] } }) });
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

test('agy start, tool and stop events admit and project its conversation', async (t) => {
  const f = await fixture(t);
  const agy = (native, extra = {}) => normalizeEvent('agy', native, JSON.stringify({ conversationId: 'g', workspacePaths: ['/repo'], ...extra }));
  const tool = agy('PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } });
  for (const ev of [agy('SessionStart'), tool, agy('Stop', { executionNum: 0 })]) {
    await f.publish(ev);
    assert.deepEqual(await f.run(ev), { exitCode: 0, lines: [] }, ev.nativeEvent);
  }
  assert.deepEqual(f.emitted.map(({ next }) => next.state), ['idle', 'working', 'done']);
  const { sessions } = await readSessions(f.paths.sessionsPath);
  assert.equal(sessions.g.agentId, 'agy:g'); assert.equal(sessions.g.harness, 'agy');
  assert.equal(sessions.g.state, 'done');
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
    ...f.deps, envelope, snapshot, prior: { sessions: { s: old, other: { repoRoot, projectColor: '#abcdef', family: null } } },
    gitContext: async () => ({ remote: null, repoRoot, repositoryRoot: repoRoot }),
    lookupProjectColor: async (dir) => { calls.push(dir); return { color: '#317d01', root: null, warnings: ['looked up'] }; },
  });
  for (const old of [undefined, { repoRoot: '/different', projectColor: '#123456', family: null },
    { repoRoot: '/repo', family: null }, { repoRoot: '/repo', projectColor: '#123456' },
    Object.assign(Object.create({ projectColor: '#123456' }), { repoRoot: '/repo', family: null })]) {
    const result = await prepare(old);
    assert.equal(result.context.projectColor, '#317d01');
    assert.deepEqual(result.warnings, ['looked up']);
  }
  assert.deepEqual(calls, ['/repo', '/repo', '/repo', '/repo', '/repo']);
  calls.length = 0;
  for (const projectColor of [null, '#123456']) {
    const result = await prepare({ repoRoot: '/repo', projectColor, family: null });
    assert.equal(result.context.projectColor, projectColor);
    assert.deepEqual(result.warnings, []);
  }
  assert.equal((await prepare({ repoRoot: '/repo', projectColor: '#123456', family: null }, null)).context.projectColor, null);
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
      lookupProjectColor: async (dir) => { calls.push(dir); return { color: dir === '/api' ? '#317d01' : '#ff0000', root: null, warnings: ['looked up'] }; },
    });
    assert.deepEqual(result.warnings, prior.sessions.s?.repoRoot === repoRoot ? [] : ['looked up']);
    prior = { sessions: { s: result.context } };
  }
  assert.deepEqual(calls, ['/api', '/web']);
  assert.equal(prior.sessions.s.projectColor, '#ff0000');
});

// Review Focus 3: a misspelled role must not silently show the default, and must not
// cost the session its record. The hook says why in one line and changes nothing.
for (const value of ['Reviewer', 'reviewer/lead', 'default']) test(`FAMILIAR_ROLE ${JSON.stringify(value)} prints one line, exits 0, and leaves the previous record as it was`, async (t) => {
  const f = await fixture(t);
  await f.publish(event());
  assert.deepEqual(await f.run(), { exitCode: 0, lines: [] });
  const files = [f.paths.sessionsPath, f.paths.intentPath, f.paths.seqPath];
  const before = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  assert.equal(JSON.parse(before[0]).sessions.s.role, null);
  f.emitted.length = 0;
  f.deps.env = { ...f.deps.env, FAMILIAR_ROLE: value };
  await f.publish(event('prompt'));
  const why = value === 'default'
    ? 'FAMILIAR_ROLE "default" is reserved for an agent with no role — unset FAMILIAR_ROLE instead'
    : `FAMILIAR_ROLE ${JSON.stringify(value)} is invalid — ids may only contain lowercase letters, digits, and hyphens (e.g. "reviewer")`;
  assert.deepEqual(await f.run(event('prompt')), { exitCode: 0, lines: [`familiar: observe: ${why}`] });
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, 'utf8'))), before);
  assert.deepEqual(f.emitted, []);
});

test('the hook environment\'s FAMILIAR_ROLE reaches the record, and the record is admitted once', async (t) => {
  const f = await fixture(t);
  f.deps.env = { ...f.deps.env, FAMILIAR_ROLE: 'reviewer' };
  await f.publish(event());
  assert.deepEqual(await f.run(), { exitCode: 0, lines: [] });
  const first = (await readSessions(f.paths.sessionsPath)).sessions.s;
  assert.deepEqual([first.role, first.family, first.admitted], ['reviewer', null, first.seq]);
  await f.publish(event('prompt'));
  assert.equal((await f.run(event('prompt'))).exitCode, 0);
  const second = (await readSessions(f.paths.sessionsPath)).sessions.s;
  assert.ok(second.seq > first.seq);
  assert.equal(second.admitted, first.admitted);
});

// --- Codex: a roled session never rewrites the repository's face ------------------------
//
// The managed `.codex/config.toml` is read by every later launch in the repository, so it
// holds the member the repository resolves with no role. A session that carries a role
// skips convergence with one line and leaves the file exactly as it was.
async function codexFixture(t, env = {}) {
  const f = await fixture(t);
  const repoRoot = join(f.dir, 'repo');
  const codexHome = join(f.dir, 'codex-home');
  await mkdir(join(repoRoot, '.codex'), { recursive: true });
  await mkdir(join(codexHome, 'pets'), { recursive: true });
  const config = join(repoRoot, '.codex', 'config.toml');
  const before = '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.\n'
    + '[tui]\npet = "custom:familiar-fixture--pip"\n';
  await writeFile(config, before);
  f.deps.gitContext = async () => ({ remote: null, repoRoot, repositoryRoot: repoRoot });
  f.deps.lookupProjectColor = async () => ({ color: null, root: null, warnings: [] });
  f.deps.env = { ...f.deps.env, CODEX_HOME: codexHome, ...env };
  const start = { ...event(), harness: 'codex', agentId: 'codex:s' };
  await f.publish(start);
  return { f, start, config, before };
}

test('a roled Codex session-start prints the skip line and leaves .codex/config.toml untouched', async (t) => {
  const { f, start, config, before } = await codexFixture(t, { FAMILIAR_ROLE: 'reviewer' });
  assert.deepEqual(await f.run(start), { exitCode: 0, lines: [
    'familiar: observe: codex: session role "reviewer" set — repository pet selection left unchanged',
  ] });
  assert.equal((await readSessions(f.paths.sessionsPath)).sessions.s.role, 'reviewer');
  assert.equal(await readFile(config, 'utf8'), before);
});

test('an unroled Codex session-start converges, gated on its own (theme, member) pet', async (t) => {
  const { f, start, config, before } = await codexFixture(t);
  assert.deepEqual(await f.run(start), { exitCode: 0, lines: [
    'familiar: observe: pet "familiar-fixture--pip" is not installed — run `familiar install pets`',
  ] });
  assert.equal(await readFile(config, 'utf8'), before);
});

// --- attention capture ------------------------------------------------------------------

async function savedApproval(f) {
  const saved = await readAttention(f.paths);
  const [rootKey] = Object.keys(saved.sources);
  const [approvalId] = Object.keys(saved.episodes);
  return { saved, rootKey, approvalId };
}

for (const [name, breakIt] of [
  ['a thrown theme load', (f) => { f.deps.loadContext = async () => { throw new Error('theme exploded'); }; }],
  ['a missing sprite', (f) => {
    const load = f.deps.loadContext;
    f.deps.loadContext = async () => ({ ...await load(), themes: preloadedThemes({ fixture: { ...pack, members: [] } }) });
  }],
  ['an enrichment failure', (f) => { f.deps.adapterFor = () => { throw new Error('enrichment exploded'); }; }],
  ['a terminal emission failure', (f) => { f.deps.emitTransition = async () => { throw new Error('emission exploded'); }; }],
]) test(`a root request is captured despite ${name}`, async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  await f.publish(event('needs-approval'));
  breakIt(f);
  const result = await f.run(event('needs-approval'));
  assert.equal(result.exitCode, 1);
  const { saved, rootKey, approvalId } = await savedApproval(f);
  assert.equal(saved.episodes[approvalId].kind, 'needs-approval');
  assert.equal(saved.sources[rootKey].state, 'needs-approval');
});

test('capture touches no desktop: the observer leaves attribution and delivery unclassified', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  await f.publish(event('needs-approval')); await f.run(event('needs-approval'));
  const { saved, approvalId } = await savedApproval(f);
  assert.deepEqual(saved.desktop, { instanceId: null, status: 'unknown', dnd: 'unknown', workspaces: [], origins: {}, enrichment: {} });
  assert.deepEqual(saved.episodes[approvalId].delivery, { popup: { status: 'pending' }, toast: { status: 'pending' } });
});

test('a capture failure is a named diagnostic that neither clears attention nor blocks projection', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  await f.publish(event('needs-approval')); await f.run(event('needs-approval'));
  const bytes = await readFile(f.paths.attentionPath, 'utf8');
  await writeFile(f.paths.attentionPath, bytes.slice(0, 20));
  await f.publish(event('prompt'));
  const result = await f.run(event('prompt'));
  assert.equal(result.exitCode, 1);
  assert.equal(result.lines.length, 1);
  assert.match(result.lines[0], /^familiar: observe: attention: corrupt attention state/);
  assert.equal(await readFile(f.paths.attentionPath, 'utf8'), bytes.slice(0, 20));
  assert.equal((await readJson(f.paths.intentPath)).s.current.state, 'working');
});

test('teardown and reconcile capture attention too, idempotently', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  await f.publish(event('needs-approval')); await f.run(event('needs-approval'));
  await reconcile({ deps: f.deps });
  const once = await readFile(f.paths.attentionPath, 'utf8');
  await reconcile({ deps: f.deps });
  assert.equal(await readFile(f.paths.attentionPath, 'utf8'), once);
  await f.publish(event('session-end')); await f.run(event('session-end'));
  const saved = await readAttention(f.paths);
  assert.deepEqual([saved.sources, saved.episodes], [{}, {}]);
});

// Teardown runs under a 200 ms observer budget: dropping the visual comes first, so a
// teardown cut short after one step has still withdrawn the session. Its attention is
// captured next (or by the next reconcile).
test('a teardown drops its session before capturing attention', async (t) => {
  const f = await fixture(t); await f.publish(event()); await f.run();
  await f.publish(event('session-end'));
  let acquisitions = 0;
  f.deps.lockWith = async (path, fn, opts) => {
    if (++acquisitions === 2) throw new Error('observer killed');
    return withLock(path, fn, opts);
  };
  await f.run(event('session-end'));
  assert.equal(Object.hasOwn((await readSessions(f.paths.sessionsPath)).sessions, 's'), false);
  assert.equal(Object.hasOwn((await readJson(f.paths.intentPath)) ?? {}, 's'), false);
});

// --- per-theme context ------------------------------------------------------------------

// A config naming two families' themes beside the default, each installed as its own pack
// whose one member is `ginger`: the member ids collide across themes on purpose.
async function themedContext(t, { families = 'verifiably: forest', extra = () => {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-themes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = familiarPaths({
    FAMILIAR_STATE_DIR: join(dir, 'state'), FAMILIAR_CONFIG_DIR: join(dir, 'config'),
    FAMILIAR_THEMES_DIR: join(dir, 'shipped'),
  });
  await mkdir(paths.userThemesDir, { recursive: true });
  await mkdir(paths.themesDir, { recursive: true });
  await writeFile(paths.configPath, `theme: cats\nfamilies:\n  ${families.replace(/\n/g, '\n  ')}\n`);
  await writeFile(paths.schemePath, JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeTheme(paths.userThemesDir, 'cats', { member: 'ginger' });
  writeTheme(paths.userThemesDir, 'forest', { member: 'ginger' });
  extra(paths);
  return { paths, ctx: await loadContext({ paths }) };
}

const familyRecord = (sessionId, family) => ({
  sessionId, projectKey: `project:${sessionId}`, project: sessionId, remote: null,
  repoRoot: `/repos/${sessionId}`, repositoryRoot: `/repos/${sessionId}`, projectColor: null,
  family, role: null, cwd: `/repos/${sessionId}`, pid: 100, state: 'working', updatedAt: 1_000,
});

test('records in two families load two packs, and assets key on (theme, member)', async (t) => {
  const { paths, ctx } = await themedContext(t);
  assert.deepEqual(Object.keys(ctx).sort(), ['catalog', 'config', 'motionPolicy', 'paths', 'themes', 'tone']);
  const prepared = await makePrepareSprites(ctx)({
    a: familyRecord('a', null), b: familyRecord('b', 'verifiably'), c: familyRecord('c', 'verifiably'),
  });
  assert.deepEqual(prepared.faults, new Map());
  assert.deepEqual(['a', 'b', 'c'].map((sid) => {
    const { theme, themeSource, member } = prepared.identities.get(sid);
    return [theme, themeSource, member];
  }), [['cats', 'default', 'ginger'], ['forest', 'family', 'ginger'], ['forest', 'family', 'ginger']]);
  assert.equal(prepared.spriteFor('cats', 'ginger', 'idle').terminal, join(paths.userThemesDir, 'cats', 'sprites', 'ginger', 'idle.png'));
  assert.equal(prepared.spriteFor('forest', 'ginger', 'idle').terminal, join(paths.userThemesDir, 'forest', 'sprites', 'ginger', 'idle.png'));
  assert.deepEqual(prepared.animationFor('forest', 'ginger'), { kind: 'static' });
  assert.equal(prepared.animationSetFor('forest', 'ginger').kind, 'static');
  assert.throws(() => prepared.spriteFor('plants', 'ginger', 'idle'), /no assets for member "plants\/ginger"/);
  assert.equal(ctx.themes.packFor('forest').id, 'forest');
});

test('the context loads each theme once, and refuses a theme it was never asked for', async (t) => {
  const { paths } = await themedContext(t);
  const config = await loadConfig({ paths });
  const loaded = [];
  const themes = themeSet({ paths, config, loadPack: async (dir) => { loaded.push(dir); return loadThemePack(dir); } });
  await Promise.all([themes.load(['cats', 'forest', 'cats']), themes.load(['forest'])]);
  await themes.load(['cats']);
  assert.deepEqual(loaded.sort(), [join(paths.userThemesDir, 'cats'), join(paths.userThemesDir, 'forest')]);
  assert.throws(() => themes.packFor('plants'), /^Error: theme "plants" was not loaded$/);
});

test('a family whose theme fails to parse faults only its own records, with the parse error', async (t) => {
  const { ctx } = await themedContext(t, {
    families: 'verifiably: forest\nguild: broken',
    extra: (paths) => {
      writeTheme(paths.userThemesDir, 'broken', { member: 'ginger' });
      writeFileSync(join(paths.userThemesDir, 'broken', 'theme.yaml'), 'spec-version: 2\nid: broken\nmembers: [unterminated\n');
    },
  });
  const prepared = await makePrepareSprites(ctx)({
    a: familyRecord('a', 'guild'), b: familyRecord('b', 'verifiably'), c: familyRecord('c', null), d: familyRecord('d', 'guild'),
  });
  assert.deepEqual([...prepared.identities.keys()].sort(), ['b', 'c']);
  assert.deepEqual([...prepared.faults.keys()].sort(), ['a', 'd']);
  for (const sid of ['a', 'd']) assert.match(prepared.faults.get(sid), /^theme "broken": .+/);
  assert.equal(prepared.faults.get('a'), prepared.faults.get('d'));
  assert.throws(() => ctx.themes.packFor('broken'), { message: prepared.faults.get('a') });
});

test('a family not in families: draws from the default theme', async (t) => {
  const { ctx } = await themedContext(t);
  const prepared = await makePrepareSprites(ctx)({ a: familyRecord('a', 'unlisted') });
  const { theme, themeSource } = prepared.identities.get('a');
  assert.deepEqual([theme, themeSource], ['cats', 'default']);
  assert.throws(() => ctx.themes.packFor('forest'), /theme "forest" was not loaded/);
});

test('a pack whose own id differs from its directory faults that theme', async (t) => {
  const { ctx } = await themedContext(t, {
    families: 'verifiably: forest\nguild: odd',
    extra: (paths) => writeTheme(paths.userThemesDir, 'odd', { member: 'ginger', packId: 'other' }),
  });
  const prepared = await makePrepareSprites(ctx)({ a: familyRecord('a', 'guild'), b: familyRecord('b', 'verifiably') });
  assert.equal(prepared.faults.get('a'), 'theme "odd": pack id "other" does not match its directory');
  assert.deepEqual([...prepared.identities.keys()], ['b']);
});

// --- world, anchor and admission on the intent record ------------------------------------

// Gives an installed theme a one-locale world (a 1x1 `home.png`, one place) and returns the
// image path. The fixture member is `ginger`, anchor floor by default.
async function addWorld(paths, id) {
  const dir = join(paths.userThemesDir, id);
  const descriptor = await readFile(join(dir, 'theme.yaml'), 'utf8');
  await writeFile(join(dir, 'theme.yaml'), descriptor.replace('members:', [
    'world:', '  asset-root: world', '  size: [1, 1]', '  locales:',
    '    home: { image: home.png, places: [[0, 0]] }', 'members:',
  ].join('\n')));
  await mkdir(join(dir, 'world'));
  const { TINY_PNG } = await import('./helpers/fixture.js');
  await writeFile(join(dir, 'world', 'home.png'), TINY_PNG());
  return join(dir, 'world', 'home.png');
}

test('the intent identity carries the theme\'s proven home locale and the member anchor; a theme without a world carries null', async (t) => {
  const { paths, ctx } = await themedContext(t, { extra: () => {} });
  const image = await addWorld(paths, 'forest');
  const fresh = await loadContext({ paths });
  const { intent, faults } = await visualResolver(fresh)({
    a: { ...familyRecord('a', null), admitted: 3 }, b: { ...familyRecord('b', 'verifiably'), admitted: 4 },
  });
  assert.deepEqual(faults, new Map());
  assert.equal(intent.a.current.identity.world, null);
  assert.equal(intent.a.current.identity.anchor, 'floor');
  assert.equal(intent.a.current.admitted, 3);
  const world = intent.b.current.identity.world;
  assert.equal(world.locale, 'home');
  assert.equal(world.image, image);
  assert.deepEqual(world.size, { width: 1, height: 1 });
  assert.deepEqual(world.places, [{ x: 0, y: 0 }]);
  assert.equal(intent.b.current.admitted, 4);
  void ctx;
});

test('a deleted home.png faults the record of that theme and no other', async (t) => {
  const { paths } = await themedContext(t);
  const image = await addWorld(paths, 'forest');
  const fresh = await loadContext({ paths });
  await rm(image);
  const { intent, faults } = await visualResolver(fresh)({
    a: { ...familyRecord('a', null), admitted: 3 }, b: { ...familyRecord('b', 'verifiably'), admitted: 4 },
  });
  assert.match(faults.get('b'), /world: locale "home"/);
  assert.equal(Object.hasOwn(intent, 'b'), false);
  assert.equal(Object.hasOwn(intent, 'a'), true);
});

// The proven world is written into intent.json's identity, not only returned in memory.
for (const withWorld of [true, false]) {
  test(`the written intent.json carries identity.world ${withWorld ? 'as the proven home locale' : 'as null for a theme without a world'}`, async (t) => {
    const f = await fixture(t);
    await mkdir(f.paths.userThemesDir, { recursive: true });
    await mkdir(f.paths.configDir ?? join(f.paths.userThemesDir, '..'), { recursive: true });
    await writeFile(f.paths.schemePath, JSON.stringify({ mode: 'dark', satScale: 1 }));
    writeTheme(f.paths.userThemesDir, 'cats', { member: 'ginger' });
    const image = withWorld ? await addWorld(f.paths, 'cats') : null;
    f.deps.loadContext = () => loadContext({ paths: f.paths });
    await f.publish(event());
    assert.deepEqual(await f.run(), { exitCode: 0, lines: [] });
    const written = (await readJson(f.paths.intentPath)).s.current.identity;
    if (withWorld) {
      assert.deepEqual(written.world, { locale: 'home', image, size: { width: 1, height: 1 }, places: [{ x: 0, y: 0 }] });
    } else {
      assert.equal(written.world, null);
    }
  });
}

test('a session whose owner dies without a session-end has its terminal reset through the surviving holder', async (t) => {
  const f = await fixture(t);
  f.deps.relayProcess.ancestors = () => [{ pid: 42, tty: true }, { pid: 84, tty: true }, { pid: 7, tty: true }];
  await f.publish(event()); await f.run();
  assert.deepEqual((await readSessions(f.paths.sessionsPath)).sessions.s.holder, { pid: 7, starttime: 20 });
  f.emitted.length = 0;
  // agy exits: relay reaps the row with no SessionEnd, and the owner (84) is gone.
  await f.publish(event('session-end'));
  f.deps.renderProcess.ownerAlive = (pid) => pid !== 84;
  assert.equal((await f.run(null)).exitCode, 0);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0].next, null);
  assert.equal(f.emitted[0].prev.pid, 7, 'the reset goes through the holder, not the dead owner');
  assert.deepEqual((await readSessions(f.paths.sessionsPath)).ended, {});
});

test('an ended session whose holder is also gone, or still serves a live session, is not reset', async (t) => {
  const f = await fixture(t);
  f.deps.relayProcess.ancestors = () => [{ pid: 42, tty: true }, { pid: 84, tty: true }, { pid: 7, tty: true }];
  await f.publish(event()); await f.run(); f.emitted.length = 0;
  await f.publish(event('session-end'));
  f.deps.renderProcess.ownerAlive = (pid) => pid !== 84 && pid !== 7;
  await f.run(null);
  assert.equal(f.emitted.length, 0);
});
