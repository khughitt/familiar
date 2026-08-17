import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBinding, LEVEL_EVENTS } from './binding.js';

// createBinding's whole surface is three callbacks and an injected spawn/report -- no opencode in
// the room. The server plugin (`Familiar`) is a three-line adapter over this; what has correctness
// worth proving is here.
const recorder = () => {
  const calls = [];
  const spawn = async (event, payload) => { calls.push({ event, payload }); };
  return { spawn, calls, events: () => calls.map((c) => c.event) };
};
const capture = () => {
  const msgs = [];
  return { report: (m) => msgs.push(m), msgs };
};

// The server-side event shapes, read off opencode's v1 SDK types.
const status = (sessionID, kind) => ({ event: { type: 'session.status', properties: { sessionID, status: { type: kind } } } });
const idle = (sessionID) => ({ event: { type: 'session.idle', properties: { sessionID } } });
const replied = (permissionID) => ({ event: { type: 'permission.replied', properties: { permissionID } } });
const errored = (sessionID) => ({ event: { type: 'session.error', properties: sessionID ? { sessionID } : {} } });

test('LEVEL_EVENTS is exactly the two stream events the window folds', () => {
  assert.deepEqual([...LEVEL_EVENTS].sort(), ['permission.replied', 'session.status']);
});

test('the payload keys the bus by the PROCESS, and takes cwd from opencode', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/home/k/proj', pid: 4242, spawn: rec.spawn });
  await b.dispose();
  assert.equal(rec.calls[0].payload.session_id, 'opencode:4242');
  assert.equal(rec.calls[0].payload.cwd, '/home/k/proj');
});

// init is pushed synchronously in createBinding, before the hooks exist for opencode to call -- so
// it is always first, without the subscription race a TUI plugin has to defend against.
test('init is enqueued FIRST, before any event', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  b.onEvent(status('s1', 'busy'));
  await b.dispose();
  assert.deepEqual(rec.events(), ['init', 'session.busy', 'dispose']);
});

test('a busy session, a permission, and the fall back to busy', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  b.onEvent(status('s1', 'busy'));
  b.onPermissionAsk({ id: 'r1', sessionID: 's1' });
  b.onEvent(replied('r1'));
  b.onEvent(status('s1', 'idle'));
  await b.dispose();
  assert.deepEqual(rec.events(), [
    'init', 'session.busy', 'permission.pending', 'session.busy', 'session.idle', 'dispose',
  ]);
});

// REGRESSION. opencode publishes the idle transition TWICE — the idle `session.status` AND a
// dedicated `session.idle` twin, both from the same `set()` call (session/status.ts:41-43). Only
// ONE may reach the hook. Two drive reduceState idle->done then done->idle and ERASE the `done`
// pose on every clean turn. So `session.idle` is NOT a level event; `session.status{idle}` alone
// drives the transition and the twin must add nothing.
test('opencode double-fires idle; the window transitions exactly once', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  b.onEvent(status('s1', 'busy'));
  b.onEvent(status('s1', 'idle'));   // the real driver
  b.onEvent(idle('s1'));             // the redundant twin opencode fires in the same set()
  await b.dispose();
  assert.deepEqual(rec.events(), ['init', 'session.busy', 'session.idle', 'dispose']);
});

// THE SUBAGENT CASE: the child's permission ask carries the CHILD's sessionID, and it must still
// raise the window. There is no filter, by design.
test("a subagent's permission still reaches the window", async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  b.onEvent(status('parent', 'busy'));
  b.onEvent(status('child', 'busy'));
  b.onPermissionAsk({ id: 'r1', sessionID: 'child' });
  await b.dispose();
  assert.deepEqual(rec.events(), [
    'init', 'session.busy', 'session.busy', 'permission.pending', 'dispose',
  ]);
});

test('an error with a sessionID is an edge, and does not disturb the level', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  b.onEvent(status('s1', 'busy'));
  b.onEvent(errored('s1'));
  b.onEvent(status('s1', 'idle'));
  await b.dispose();
  // The error rides between the two levels without changing either -- the idle `session.status` after
  // it is the one the adapter's reduceState turns back into `error`.
  assert.deepEqual(rec.events(), ['init', 'session.busy', 'session.error', 'session.idle', 'dispose']);
});

// `sessionID` is OPTIONAL on session.error, and opencode emits it without one for PLUGIN and SKILL
// load failures -- not the agent's turn failing, and not worth a demand state on every launch.
test('an error with NO sessionID is ignored', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  b.onEvent(errored(null));
  await b.dispose();
  assert.deepEqual(rec.events(), ['init', 'dispose']);
});

// The event hook is a firehose -- token deltas, plugin churn, diffs. Everything not in LEVEL_EVENTS
// (and not session.error) must enqueue nothing.
test('the firehose is ignored — only the level events move the window', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  for (const type of ['message.part.delta', 'plugin.added', 'session.diff', 'session.updated', 'todo.updated']) {
    b.onEvent({ event: { type, properties: {} } });
  }
  await b.dispose();
  assert.deepEqual(rec.events(), ['init', 'dispose']);
});

test('a failing hook is reported and does not stop the window', async () => {
  const calls = [];
  const spawn = async (event) => { calls.push(event); if (event === 'session.busy') throw new Error('EAGAIN'); };
  const cap = capture();
  const b = createBinding({ directory: '/p', pid: 1, spawn, report: cap.report });
  b.onEvent(status('s1', 'busy'));
  b.onEvent(status('s1', 'idle'));
  await b.dispose();
  assert.deepEqual(calls, ['init', 'session.busy', 'session.idle', 'dispose']);
  assert.equal(cap.msgs.length, 1);
  assert.match(cap.msgs[0], /session\.busy/);
  assert.match(cap.msgs[0], /EAGAIN/);
});

// A throw inside window.apply() -- a session status kind we do not know -- must NOT escape into
// opencode's dispatcher. It is caught at the seam, reported, and the window keeps working.
test('an unknown session.status kind is reported, not thrown into opencode', async () => {
  const rec = recorder();
  const cap = capture();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn, report: cap.report });
  await assert.doesNotReject(async () => b.onEvent(status('s1', 'thinking')));
  b.onEvent(status('s1', 'busy'));   // the window still works
  await b.dispose();
  assert.deepEqual(rec.events(), ['init', 'session.busy', 'dispose']);   // the bad event enqueued nothing
  assert.equal(cap.msgs.length, 1);
  assert.match(cap.msgs[0], /session\.status/);
  assert.match(cap.msgs[0], /thinking/);
});

test('no project directory is a loud failure, not a quiet guess', () => {
  assert.throws(() => createBinding({ directory: undefined, spawn: recorder().spawn }), /project directory/);
});

test('dispose is enqueued last', async () => {
  const rec = recorder();
  const b = createBinding({ directory: '/p', pid: 1, spawn: rec.spawn });
  b.onEvent(status('s1', 'busy'));
  await b.dispose();
  assert.equal(rec.events().at(-1), 'dispose');
});
