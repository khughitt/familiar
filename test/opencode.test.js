import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterFor, AGENTS } from '../src/adapters/index.js';
import { HOOK_EVENTS, stateForEvent, reduceState, resolveAgentPid } from '../src/adapters/opencode.js';

test('opencode is registered', () => {
  assert.ok(AGENTS.includes('opencode'));
  assert.equal(adapterFor('opencode').printsPlaceholderCells, false);
});

// The registry's shape gate (Task 1) runs on every adapterFor(), so this is the assertion that
// opencode satisfies the whole contract — four functions and the flag — not merely some of it.
test('opencode satisfies the adapter contract', () => {
  assert.doesNotThrow(() => adapterFor('opencode'));
});

test('the six events, and only the six', () => {
  // No `question.pending`: opencode's question events are not on the stable server event stream the
  // plugin binds to, so needs-input is not driven. See src/adapters/opencode.js.
  assert.deepEqual(Object.keys(HOOK_EVENTS).sort(), [
    'dispose', 'init', 'permission.pending',
    'session.busy', 'session.error', 'session.idle',
  ]);
});

test('each event names its level', () => {
  assert.equal(stateForEvent('init'), 'idle');
  assert.equal(stateForEvent('session.busy'), 'working');
  assert.equal(stateForEvent('permission.pending'), 'needs-approval');
  assert.equal(stateForEvent('session.error'), 'error');
  assert.equal(stateForEvent('session.idle'), 'idle');
  assert.equal(stateForEvent('dispose'), null);
});

test('an unknown event throws before anything is written', () => {
  assert.throws(() => stateForEvent('session.status'), /unknown opencode event: session\.status/);
  // The opencode-native name is the tempting mistake: the PLUGIN subscribes to `session.status`,
  // but what it SENDS is the folded level. Getting this wrong must be loud.
});

// THE WHOLE REASON reduceState EXISTS. opencode publishes session.error and then sets the status
// to idle microseconds later (processor.ts:599-626, `halt`). A reducer that could not see `prev`
// would map that idle to `done` and erase the error every single time -- TTL_ERROR_MS is 30
// seconds precisely so a failure outlives a success, and it would never once be seen.
test('the idle that follows an error does not erase it', () => {
  assert.equal(reduceState('error', 'working'), 'error');
  assert.equal(reduceState('idle', 'error'), 'error');
});

test('quiet after an ACTIVE state is `done` — that is what done means', () => {
  for (const active of ['working', 'needs-input', 'needs-approval']) {
    assert.equal(reduceState('idle', active), 'done');
  }
});

test('quiet after quiet is just quiet', () => {
  assert.equal(reduceState('idle', null), 'idle');    // `init`: the window just opened
  assert.equal(reduceState('idle', 'idle'), 'idle');
  assert.equal(reduceState('idle', 'done'), 'idle');  // a `done` that already decayed
});

test('every other level is what it says it is', () => {
  for (const prev of ['idle', 'working', 'needs-input', 'needs-approval', 'error', 'done', null]) {
    assert.equal(reduceState('working', prev), 'working');
    assert.equal(reduceState('needs-approval', prev), 'needs-approval');
    assert.equal(reduceState('needs-input', prev), 'needs-input');
    assert.equal(reduceState('error', prev), 'error');
  }
});

// Same predicate as codex's, same two halves, same reason: a name alone matches daemons that own
// no terminal, and writing escape bytes into a daemon's log file is the bug the tty test closes.
test('resolveAgentPid finds the opencode process with a tty, and skips the hook itself', () => {
  const chain = [
    { pid: 400, comm: 'node', ttyNr: 0 },        // the hook: index 0, always skipped
    { pid: 300, comm: 'opencode', ttyNr: 0 },    // a daemon: right name, no terminal
    { pid: 200, comm: 'opencode', ttyNr: 34816 },// the agent
  ];
  assert.equal(resolveAgentPid({ startPid: 400, ancestors: () => chain }), 200);
});

test('no opencode among the ancestors names the whole chain', () => {
  assert.throws(
    () => resolveAgentPid({ startPid: 9, ancestors: () => [{ pid: 9, comm: 'node', ttyNr: 0 }] }),
    /could not find the opencode process among the ancestors of 9/,
  );
});
