import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { adapterFor, AGENTS, assertAdapter } from '../src/adapters/index.js';
import { HOOK_EVENTS, stateForEvent, resolveAgentPid, printsPlaceholderCells, reduceState } from '../src/adapters/codex.js';
import { STATES } from 'familiar-theme';

// An adapter is four functions and a flag. These pin the parts where codex and claude-code
// DIFFER -- which is the whole reason the adapter seam exists, and the only place a bug can hide
// that the shared core cannot catch.

test('the registry refuses an agent it does not know, and says which it does', () => {
  assert.throws(() => adapterFor('cursor'), /unknown agent: cursor.*claude-code, codex, opencode/s);
  assert.deepEqual(AGENTS, ['claude-code', 'codex', 'opencode']);
});

test('every adapter answers the same four questions and declares the flag — that IS the interface', () => {
  for (const name of AGENTS) {
    const adapter = adapterFor(name);
    for (const fn of ['stateForEvent', 'reduceState', 'parsePayload', 'resolveAgentPid']) {
      assert.equal(typeof adapter[fn], 'function', `${name} has no ${fn}`);
    }
    assert.equal(typeof adapter.printsPlaceholderCells, 'boolean', `${name} has no printsPlaceholderCells`);
  }
});

// THE FLAG IS THE ONE THAT FAILS SILENTLY, which is why the registry validates rather than trusts.
// bin/familiar does `transmitSprite = adapter.printsPlaceholderCells`. An adapter that forgot it
// yields `undefined` -- falsy -- so familiar would quietly stop transmitting the image for that
// agent, forever, with no error anywhere. A missing FUNCTION at least throws a TypeError on the
// first call; a missing BOOLEAN throws nothing and lies.
test('the registry refuses an adapter that is missing a function', () => {
  assert.throws(
    () => assertAdapter('bogus', { ...adapterFor('codex'), reduceState: undefined }),
    /bogus.*reduceState/s,
  );
});

test('the registry refuses an adapter whose printsPlaceholderCells is not a boolean', () => {
  assert.throws(
    () => assertAdapter('bogus', { ...adapterFor('codex'), printsPlaceholderCells: undefined }),
    /bogus.*printsPlaceholderCells/s,
  );
});

test('every non-removal Codex event maps to a state the protocol actually has', () => {
  // A typo here -- 'needs_approval', 'approval' -- would resolve to undefined and write a record
  // whose state no renderer has a sprite for. Cheap to assert, silent if wrong.
  for (const [event, state] of Object.entries(HOOK_EVENTS)) {
    if (state !== null) {
      assert.ok(STATES.includes(state), `${event} maps to "${state}", which is not a state`);
    }
  }
});

test('PermissionRequest is the needs-approval signal — the one event worth porting for', () => {
  assert.equal(stateForEvent('PermissionRequest'), 'needs-approval');
  assert.equal(stateForEvent('SessionStart'), 'idle');
  assert.equal(stateForEvent('UserPromptSubmit'), 'working');
  assert.equal(stateForEvent('Stop'), 'done');
});

test('an unknown codex event throws, and names codex — not claude-code', () => {
  // The adapters still have different vocabularies: Codex has no idle-prompt hook event.
  // SessionEnd is shared in Codex 0.146 and has its own removal test below.
  assert.throws(() => stateForEvent('Notification:idle_prompt'), /unknown codex hook event/);
});

test('SessionEnd clears the record rather than setting a state', () => {
  assert.equal(stateForEvent('SessionEnd'), null);
  assert.ok('SessionEnd' in HOOK_EVENTS);
});

test('the shipped Codex hooks invoke Familiar for SessionEnd', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('../integrations/codex/hooks.json', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(fixture.hooks.SessionEnd, [{
    hooks: [{
      type: 'command',
      command: '~/d/familiar/bin/familiar hook --agent codex SessionEnd',
    }],
  }]);
});

test('codex offers no needs-input and no error, and the map does not pretend otherwise', () => {
  // This test EXISTS TO FAIL when somebody adds them. If a future codex ships an idle-prompt
  // notification or an error event, wire it up and delete this -- but do not quietly infer either
  // from PostToolUse's tool_response or the rollout JSONL (whose format codex documents as
  // unstable). Four honest states beat six with two of them guessing.
  const reachable = new Set(Object.values(HOOK_EVENTS).filter((state) => state !== null));
  assert.ok(!reachable.has('needs-input'), 'codex grew a needs-input signal — good, update the docs');
  assert.ok(!reachable.has('error'), 'codex grew an error signal — good, update the docs');
  assert.deepEqual([...reachable].sort(), ['done', 'idle', 'needs-approval', 'working']);
});

test('codex prints no placeholder cells — so familiar transmits no image', () => {
  // The flag asks "does anything in this agent's UI print the cells the image lands in?"
  // codex's status line is a closed enum of built-ins; there are no cells, and there never
  // will be. claude-code's status line runs `familiar statusline`, so there are.
  assert.equal(printsPlaceholderCells, false);
  assert.equal(adapterFor('claude-code').printsPlaceholderCells, true);
});

test('codex reduces a level to itself — it has no state that depends on what came before', () => {
  for (const level of STATES) assert.equal(reduceState(level, null), level);
  assert.equal(reduceState('done', 'working'), 'done');
});

test('the agent is the codex process WITH a terminal — not the hook, and not its helper child', () => {
  // A live codex session on this machine is a `codex` process with a tty, and it spawns a
  // `codex-code-mode` child. Walking up from the hook we must land on `codex`, and the tty test
  // must survive a same-named process that owns no terminal -- the failure claude-code's spike
  // found in 370 of 1507 samples, where fd 1 was a log file and we would have written escape
  // codes into it.
  const chain = [
    { pid: 10, comm: 'node', ttyNr: 0 },          // the hook itself — index 0, always skipped
    { pid: 9, comm: 'sh', ttyNr: 0 },
    { pid: 8, comm: 'codex', ttyNr: 0 },          // same comm, NO terminal: a daemon. Not our agent.
    { pid: 7, comm: 'codex', ttyNr: 34816 },      // the real one
  ];
  assert.equal(resolveAgentPid({ startPid: 10, ancestors: () => chain }), 7);
});

test('no codex process among the ancestors is a named failure with the whole chain in it', () => {
  const chain = [
    { pid: 10, comm: 'node', ttyNr: 0 },
    { pid: 9, comm: 'claude', ttyNr: 34816 },     // a claude-code session: the wrong --agent flag
  ];
  assert.throws(
    () => resolveAgentPid({ startPid: 10, ancestors: () => chain }),
    /could not find the codex process.*10\(node\) -> 9\(claude\)/s,
  );
});
