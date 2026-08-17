import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateForEvent, parsePayload, resolveAgentPid, HOOK_EVENTS, printsPlaceholderCells, reduceState } from '../src/adapters/claude-code.js';
import { STATES } from 'familiar-theme';

test('the hook map keeps all six distinctions the payloads already carry', () => {
  assert.equal(stateForEvent('SessionStart'), 'idle');
  assert.equal(stateForEvent('UserPromptSubmit'), 'working');
  assert.equal(stateForEvent('PreToolUse'), 'working');
  assert.equal(stateForEvent('Notification:idle_prompt'), 'needs-input');
  assert.equal(stateForEvent('Notification:permission_prompt'), 'needs-approval');
  assert.equal(stateForEvent('Stop'), 'done');
  assert.equal(stateForEvent('StopFailure'), 'error');
});

test('SessionEnd clears the record rather than setting a state', () => {
  assert.equal(stateForEvent('SessionEnd'), null);
  assert.ok('SessionEnd' in HOOK_EVENTS);   // null is a MAPPING, not an absence
});

test('an unrecognized hook event is an error, never a silent no-op', () => {
  assert.throws(() => stateForEvent('PostToolUse'), /unknown claude-code hook event: PostToolUse/);
  assert.throws(() => stateForEvent(undefined), /unknown claude-code hook event: undefined/);
});

test('claude-code reduces a level to itself, and prints the cells its status line draws', () => {
  assert.equal(printsPlaceholderCells, true);
  for (const level of STATES) assert.equal(reduceState(level, null), level);
});

test('parsePayload takes the session id and cwd the hook provides', () => {
  const payload = JSON.stringify({ session_id: 'abc', cwd: '/home/k/d/api', tool_name: 'Bash' });
  assert.deepEqual(parsePayload(payload), { sessionId: 'abc', cwd: '/home/k/d/api' });
});

test('a payload without a session id is unusable and says so', () => {
  assert.throws(() => parsePayload('{}'), /hook payload has no session_id/);
  assert.throws(() => parsePayload(''), /hook payload is not JSON/);
  assert.throws(() => parsePayload('{ broken'), /hook payload is not JSON/);
});

// --- resolveAgentPid -------------------------------------------------------
//
// Task 1's spike (docs/spikes/2026-07-11-hook-environment.md, finding C) found
// the plan's original predicate ("first ancestor whose comm is claude") wrong
// in 370 of 1507 real samples (25%): background/daemon-hosted sessions put a
// `claude bg-pty-host` and a `claude daemon run` in the chain, and the daemon
// process ALSO has comm === 'claude' but owns no terminal (ttyNr === 0). The
// naive predicate stops there and would target the daemon's stdout, not the
// user's screen.
//
// The corrected predicate — verified right in 1507 of 1507 samples — is
// `comm === 'claude' AND ttyNr !== 0`: the first ancestor that IS claude and
// OWNS a terminal. It needs no readCmdline dependency: comm and ttyNr both
// come straight off /proc/<pid>/stat (see src/bus/proc.js), which `ancestors`
// already supplies.

test('interactive session: the agent is the immediate parent, one level up', () => {
  // docs/spikes/2026-07-11-hook-environment.md, finding C, "interactive" shape.
  const chain = [
    { pid: 500, comm: 'node', ppid: 450, ttyNr: 0 },
    { pid: 450, comm: 'claude', ppid: 200, ttyNr: 34835 },
    { pid: 200, comm: 'zsh', ppid: 100, ttyNr: 34835 },
    { pid: 100, comm: 'kitty', ppid: 1, ttyNr: 0 },
  ];
  assert.equal(resolveAgentPid({ startPid: 500, ancestors: () => chain }), 450);
});

test('background/daemon-hosted session: a claude process with no tty (the daemon) is skipped for the real terminal-owning agent four levels up', () => {
  // docs/spikes/2026-07-11-hook-environment.md, finding C, "background" shape.
  // comm === 'claude' alone would wrongly stop at pid 300 (the daemon, ttyNr 0)
  // in 370 of 1507 real samples.
  const chain = [
    { pid: 500, comm: 'node', ppid: 450, ttyNr: 0 },
    { pid: 450, comm: '2.1.207', ppid: 400, ttyNr: 0 },       // claude bg-pty-host
    { pid: 400, comm: '2.1.207', ppid: 300, ttyNr: 0 },
    { pid: 300, comm: 'claude', ppid: 200, ttyNr: 0 },        // claude daemon run — comm matches, no tty
    { pid: 200, comm: 'claude', ppid: 100, ttyNr: 34847 },    // the real, terminal-attached agent
    { pid: 100, comm: 'zsh', ppid: 1, ttyNr: 34847 },
  ];
  assert.equal(resolveAgentPid({ startPid: 500, ancestors: () => chain }), 200);
});

test('a claude process with no terminal anywhere in the chain is a hard error, not a silent daemon match', () => {
  const chain = [
    { pid: 500, comm: 'node', ppid: 300, ttyNr: 0 },
    { pid: 300, comm: 'claude', ppid: 1, ttyNr: 0 },   // daemon only — must not match
  ];
  assert.throws(
    () => resolveAgentPid({ startPid: 500, ancestors: () => chain }),
    /could not find the claude-code process/
  );
});

test('no agent in the ancestor chain is a hard error — a record keyed to a dead pid is worse than none', () => {
  const chain = [{ pid: 500, comm: 'node', ppid: 1, ttyNr: 0 }];
  assert.throws(
    () => resolveAgentPid({ startPid: 500, ancestors: () => chain }),
    /could not find the claude-code process/
  );
});
