import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSnapshot } from '../src/bus/projection.js';
import { EMPTY_SESSIONS } from '../src/bus/sessions.js';

const generation = 'generation-1';
const handle = { platform: 'linux', host: 'host', bootId: 'boot', pid: 42, start: '123' };
const context = { cwd: '/repo', projectKey: 'familiar-key', project: 'repo', remote: null, repoRoot: '/repo/wt', repositoryRoot: '/repo', projectColor: '#123456' };
const row = (sid, extra = {}) => ({
  id: `codex:${sid}`, harness: 'codex', sessionId: sid, scope: 'session',
  process: handle, cwd: '/repo', repoRoot: '/repo', remote: null, projectKey: 'relay-key',
  project: 'repo', state: 'working', updatedAt: 1000, ...extra,
});
const snapshot = (...rows) => ({ schema: 2, generation, revision: 10, agents: Object.fromEntries(rows.map((r) => [r.id, r])) });
const basis = (agent, gen = generation) => ({ generation: gen, agentId: agent.id, process: agent.process, cwd: agent.cwd });
const prepared = (agent, extra = {}) => ({ basis: basis(agent), terminal: { pid: 100, starttime: 200 }, context, ...extra });
const session = (agent, extra = {}) => ({
  sessionId: agent.sessionId, agentId: agent.id, harness: agent.harness,
  basis: basis(agent), ...context, pid: 100, starttime: 200,
  seq: 1, state: agent.state, updatedAt: agent.updatedAt, ...extra,
});
const prior = (...records) => ({ ...structuredClone(EMPTY_SESSIONS), sessions: Object.fromEntries(records.map((r) => [r.sessionId, r])) });
const ended = (record, seq) => ({ sessionId: record.sessionId, harness: record.harness, project: record.project, pid: record.pid, starttime: record.starttime, seq });
const visuals = async (sessions) => ({ intent: Object.fromEntries(Object.keys(sessions).map((sid) => [sid, { visual: sid }])), faults: new Map() });
const project = (options = {}) => projectSnapshot({ snapshot: snapshot(), prior: prior(), priorIntent: {}, seq: 5, mode: 'full', event: null, prepared: null, resolveVisuals: visuals, ...options });

test('a fresh prepared event admits its session with every context and terminal field', async () => {
  const a = row('a');
  const result = await project({ snapshot: snapshot(a), event: { sessionId: 'a' }, prepared: prepared(a) });
  assert.deepEqual(result.sessions.sessions.a, session(a, { seq: 5 }));
  assert.deepEqual(result.sessions.registry, { generation, revision: 10 });
  assert.deepEqual(result.intent, { a: { visual: 'a' } });
  assert.deepEqual(result.capture, { prev: null, next: result.sessions.sessions.a });
  assert.equal(result.stale, false);
});

test('an unadmitted registry agent without prepared enrichment is not projected', async () => {
  const result = await project({ snapshot: snapshot(row('a')) });
  assert.deepEqual(result.sessions.sessions, {});
  assert.deepEqual(result.intent, {});
});

test('the projection depends on the snapshot, not on the seq order', async () => {
  const a = row('a', { state: 'done', updatedAt: 2000 });
  const first = await project({ snapshot: snapshot(a), event: { sessionId: 'a' }, prepared: prepared(a), seq: 20 });
  const second = await project({ snapshot: snapshot(a), prior: first.sessions, seq: 10 });
  assert.equal(second.sessions.sessions.a.state, 'done');
  assert.equal(second.sessions.sessions.a.updatedAt, 2000);
  assert.equal(second.sessions.sessions.a.seq, 10);
});

test('stale enrichment is discarded for a changed process, cwd or generation', async () => {
  const a = row('a', { state: 'done', updatedAt: 2000 });
  const changes = [
    { ...basis(a), process: { ...handle, start: '999' } },
    { ...basis(a), cwd: '/old' },
    { ...basis(a), generation: 'old-generation' },
  ];
  for (const staleBasis of changes) {
    const enrichment = prepared(a, { basis: staleBasis, context: { ...context, project: 'stale-project' } });
    const kept = await project({ snapshot: snapshot(a), prior: prior(session(a)), event: { sessionId: 'a' }, prepared: enrichment });
    assert.equal(kept.stale, true);
    assert.equal(kept.sessions.sessions.a.project, 'repo');
    assert.equal(kept.sessions.sessions.a.state, 'done');
    assert.equal(kept.capture, null);
    const old = session(a, { basis: staleBasis });
    const dropped = await project({ snapshot: snapshot(a), prior: prior(old), event: { sessionId: 'a' }, prepared: enrichment });
    assert.equal(dropped.stale, true);
    assert.deepEqual(dropped.sessions.sessions, {});
    assert.deepEqual(dropped.intent, {});
    assert.deepEqual(dropped.sessions.ended.a, ended(old, 5));
    assert.equal(dropped.capture, null);
    const unadmitted = await project({ snapshot: snapshot(a), event: { sessionId: 'a' }, prepared: enrichment });
    assert.deepEqual(unadmitted.sessions.sessions, {});
  }
});

test('a row whose basis moved since admission leaves the projection on reconcile', async () => {
  const old = session(row('a'));
  const result = await project({ snapshot: snapshot(row('a', { cwd: '/moved' })), prior: prior(old) });
  assert.deepEqual(result.sessions.sessions, {});
  assert.deepEqual(result.sessions.ended.a, ended(old, 5));
  assert.equal(result.capture, null);
});

test('session-end drop-only copies survivors and intent unchanged and never resolves visuals', async () => {
  const a = session(row('a'));
  const b = session(row('b'), { pid: 101 });
  const p = prior(a, b);
  const priorIntent = { a: { visual: 'old-a' }, b: { visual: 'old-b' } };
  const result = await project({ snapshot: snapshot(row('b', { cwd: '/changed', state: 'done' }), row('unadmitted')), prior: p, priorIntent, mode: 'drop-only', event: { sessionId: 'a' }, resolveVisuals: () => assert.fail('must not resolve') });
  assert.deepEqual(result.sessions.sessions, { b });
  assert.deepEqual(result.intent, { b: priorIntent.b });
  assert.deepEqual(result.sessions.ended.a, ended(a, 5));
  assert.deepEqual(result.capture, { prev: ended(a, 5), next: null });
  assert.deepEqual(p, prior(a, b));
  assert.deepEqual(priorIntent.a, { visual: 'old-a' });
});

test('removal by another observer preserves ended evidence for its own drop-only capture', async () => {
  const a = session(row('a'));
  const b = session(row('b'), { pid: 101 });
  const first = await project({ snapshot: snapshot(row('b')), prior: prior(a, b), event: { sessionId: 'b' } });
  const second = await project({ snapshot: snapshot(row('b')), prior: first.sessions, priorIntent: first.intent, mode: 'drop-only', seq: 6, event: { sessionId: 'a' } });
  assert.deepEqual(second.capture, { prev: ended(a, 5), next: null });
  assert.deepEqual(second.sessions.ended.a, ended(a, 5));
});

test('no ended entry when a present session owns the same terminal process', async () => {
  const a = session(row('a'));
  const b = row('b');
  const result = await project({ snapshot: snapshot(b), prior: prior(a), prepared: prepared(b), event: { sessionId: 'b' } });
  assert.deepEqual(result.sessions.ended, {});
  const teardown = await project({ snapshot: snapshot(b), prior: result.sessions, priorIntent: result.intent, mode: 'drop-only', event: { sessionId: 'a' } });
  assert.deepEqual(teardown.capture, { prev: null, next: null });
});

test('an admitted session with the same terminal retires a matching ended entry', async () => {
  const a = session(row('a'));
  const p = prior();
  p.ended.a = ended(a, 2);
  const b = row('b');
  const result = await project({ snapshot: snapshot(b), prior: p, event: { sessionId: 'b' }, prepared: prepared(b) });
  assert.deepEqual(result.sessions.ended, {});
});

test('re-admission under the same id replaces its ended entry', async () => {
  const a = row('a');
  const p = prior();
  p.ended.a = ended(session(a, { pid: 999 }), 2);
  const result = await project({ snapshot: snapshot(a), prior: p, event: { sessionId: 'a' }, prepared: prepared(a) });
  assert.deepEqual(result.sessions.ended, {});
  assert.deepEqual(result.capture.prev, p.ended.a);
  assert.equal(result.capture.next.pid, 100);
});

test('a visual fault omits intent but keeps the session including capture.next', async () => {
  const a = row('a');
  const result = await project({ snapshot: snapshot(a), prepared: prepared(a), event: { sessionId: 'a' }, resolveVisuals: async (records) => {
    assert.ok(records.a);
    return { intent: {}, faults: new Map([['a', 'missing sprite']]) };
  } });
  assert.ok(result.sessions.sessions.a);
  assert.equal(result.capture.next, result.sessions.sessions.a);
  assert.deepEqual(result.intent, {});
  assert.equal(result.faults.get('a'), 'missing sprite');
});

test('worker rows fold into their root, taking the latest state and updatedAt', async () => {
  const root = row('a');
  const worker = row('worker', { scope: 'worker', root: root.id, state: 'needs-input', updatedAt: 3000 });
  const orphan = row('orphan', { scope: 'worker', root: 'codex:missing', updatedAt: 4000 });
  const result = await project({ snapshot: snapshot(root, worker, orphan), event: { sessionId: 'a' }, prepared: prepared(root) });
  assert.deepEqual(Object.keys(result.sessions.sessions), ['a']);
  assert.equal(result.sessions.sessions.a.state, 'needs-input');
  assert.equal(result.sessions.sessions.a.updatedAt, 3000);
  assert.deepEqual(result.sessions.sessions.a.basis, basis(root));
  const newerRoot = row('a', { state: 'done', updatedAt: 5000 });
  const next = await project({ snapshot: snapshot(newerRoot, worker), prior: result.sessions });
  assert.equal(next.sessions.sessions.a.state, 'done');
  assert.equal(next.sessions.sessions.a.updatedAt, 5000);
});

test('a sessionId shared by two agents is a collision', async () => {
  const a = row('a');
  const other = row('a', { id: 'claude-code:a', harness: 'claude-code' });
  for (const admitted of [a, other]) {
    const old = session(admitted);
    const result = await project({ snapshot: snapshot(a, other), prior: prior(old), event: { sessionId: 'a' }, prepared: prepared(a) });
    assert.deepEqual(result.sessions.sessions, {});
    assert.deepEqual(result.intent, {});
    assert.deepEqual(result.sessions.ended.a, ended(old, 5));
    assert.match(result.diagnostics.join('\n'), /codex:a/);
    assert.match(result.diagnostics.join('\n'), /claude-code:a/);
  }
});

test('a null snapshot projects to no sessions and preserves cleanup evidence', async () => {
  const a = session(row('a'));
  const result = await project({ snapshot: null, prior: prior(a) });
  assert.deepEqual(result.sessions.sessions, {});
  assert.deepEqual(result.sessions.ended.a, ended(a, 5));
  assert.equal(result.sessions.registry, null);
});

test('generation reset drops absent sessions and records the new registry', async () => {
  const a = session(row('a'));
  const result = await project({ snapshot: { ...snapshot(row('b')), generation: 'new-generation', revision: 1 }, prior: prior(a) });
  assert.deepEqual(result.sessions.sessions, {});
  assert.deepEqual(result.sessions.ended.a, ended(a, 5));
  assert.deepEqual(result.sessions.registry, { generation: 'new-generation', revision: 1 });
});

test('session ids that name object properties stay ordinary session keys', async () => {
  const a = row('__proto__');
  const result = await project({ snapshot: snapshot(a), event: { sessionId: '__proto__' }, prepared: prepared(a) });
  assert.deepEqual(result.capture.prev, null);
  assert.deepEqual(result.sessions.sessions.__proto__, session(a, { seq: 5 }));
  assert.deepEqual(Object.keys(result.intent), ['__proto__']);
});

test('a reused terminal pid with a different starttime does not retire cleanup evidence', async () => {
  const a = session(row('a'));
  const b = row('b');
  const result = await project({ snapshot: snapshot(b), prior: prior(a), event: { sessionId: 'b' }, prepared: prepared(b, { terminal: { pid: 100, starttime: 999 } }) });
  assert.deepEqual(result.sessions.ended.a, ended(a, 5));
});

test('drop-only preserves surviving visual faults and existing cleanup evidence', async () => {
  const a = session(row('a'));
  const b = session(row('b'));
  const p = prior(b);
  p.ended.a = ended(a, 2);
  const result = await project({ snapshot: snapshot(row('b')), prior: p, priorIntent: {}, mode: 'drop-only', event: { sessionId: 'a' }, resolveVisuals: () => assert.fail('must not resolve') });
  assert.deepEqual(result.intent, {});
  assert.deepEqual(result.sessions.sessions.b, b);
  assert.deepEqual(result.sessions.ended.a, ended(a, 2));
  assert.deepEqual(result.capture, { prev: ended(a, 2), next: null });
});

test('prepared enrichment whose row disappeared is stale and cannot emit', async () => {
  const a = row('a');
  const result = await project({ snapshot: null, prior: prior(session(a)), event: { sessionId: 'a' }, prepared: prepared(a) });
  assert.equal(result.stale, true);
  assert.equal(result.capture, null);
  assert.deepEqual(result.sessions.sessions, {});
});
