import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindow } from './window.js';

const status = (sessionID, type) => ({ type: 'session.status', properties: { sessionID, status: { type } } });
const permAsked = (id, sessionID) => ({ type: 'permission.asked', properties: { id, sessionID } });
const permReplied = (permissionID) => ({ type: 'permission.replied', properties: { permissionID } });

test('a fresh window is quiet', () => {
  assert.equal(createWindow().level(), 'session.idle');
});

test('busy, then idle, and back to quiet', () => {
  const w = createWindow();
  w.apply(status('s1', 'busy'));
  assert.equal(w.level(), 'session.busy');
  w.apply(status('s1', 'idle'));
  assert.equal(w.level(), 'session.idle');
});

test('retry is a sub-state of busy, not a state of its own', () => {
  const w = createWindow();
  w.apply(status('s1', 'retry'));
  assert.equal(w.level(), 'session.busy');
});

// PRECEDENCE. Both sets non-empty at once is the ordinary case, not a corner: a permission is asked
// BY a running session, and opencode leaves that session `busy` throughout.
test('permissions beat busy beat quiet', () => {
  const w = createWindow();
  w.apply(status('s1', 'busy'));
  assert.equal(w.level(), 'session.busy');
  w.apply(permAsked('r1', 's1'));
  assert.equal(w.level(), 'permission.pending');

  w.apply(permReplied('r1'));
  assert.equal(w.level(), 'session.busy');        // falls back to busy, still busy
  w.apply(status('s1', 'idle'));
  assert.equal(w.level(), 'session.idle');
});

// THE SUBAGENT CASE, and the reason this module is a SET and not a boolean. opencode subagents are
// real child sessions with their own sessionID, publishing their own status onto the same bus. A
// boolean would let the child's `idle` clear the parent's `busy`, and the window would go quiet
// while the agent was still working.
test('a subagent going idle does not clear its parent — sessions are tracked independently', () => {
  const w = createWindow();
  w.apply(status('parent', 'busy'));
  w.apply(status('child', 'busy'));
  w.apply(status('child', 'idle'));
  assert.equal(w.level(), 'session.busy');   // the parent is still working
  w.apply(status('parent', 'idle'));
  assert.equal(w.level(), 'session.idle');
});

test('two pending permissions need two replies — permission ids are tracked independently', () => {
  const w = createWindow();
  w.apply(permAsked('r1', 's1'));
  w.apply(permAsked('r2', 's2'));      // s2 is a subagent: its ask still demands an answer
  w.apply(permReplied('r1'));
  assert.equal(w.level(), 'permission.pending');
  w.apply(permReplied('r2'));
  assert.equal(w.level(), 'session.idle');
});

// NO DEDUPLICATION. The window reports the level it is at, every time it is asked. It is not the
// window's job to notice that the level has not changed -- see the spec, §5: a plugin that
// deduplicates leaves the window lying in `error` for a full TTL when opencode hits a context
// overflow, publishes the error, and STAYS BUSY.
test('the same level folded twice is the same level twice — the window never deduplicates', () => {
  const w = createWindow();
  w.apply(status('s1', 'busy'));
  w.apply(status('s2', 'busy'));
  assert.equal(w.level(), 'session.busy');
  assert.equal(w.level(), 'session.busy');
});

test('an event the window does not track is a bug, and says so', () => {
  assert.throws(() => createWindow().apply({ type: 'session.error', properties: {} }), /does not track/);
  // session.error is an EDGE, not a level: it changes no set, and plugin.js enqueues it directly.
  assert.throws(() => createWindow().apply({ type: 'message.part.delta', properties: {} }), /does not track/);
});

test('an unknown session status is a bug, and says so', () => {
  assert.throws(() => createWindow().apply(status('s1', 'thinking')), /unknown session status/);
});
