import { ancestors as procAncestors } from '../bus/proc.js';
import { parsePayload } from './payload.js';

// codex's payload is the same JSON, field for field, so the parser lives in one place now
// (./payload.js). Re-exported rather than moved out of sight: an adapter is a complete answer to
// "how do I read this agent", and a caller should not have to know which parts it shares.
export { parsePayload };

// The hook payloads already carry every distinction we need. We keep all six
// states the payloads discriminate, rather than collapsing them.
//
// The event name arrives on argv, and the two Notification subtypes are
// discriminated by separate settings.json matchers — Task 1's spike (finding
// D) confirmed they fire independently (12 idle_prompt vs 3 permission_prompt,
// zero double-fires) across 1507 real samples. null means: clear.
export const HOOK_EVENTS = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  'Notification:idle_prompt': 'needs-input',
  'Notification:permission_prompt': 'needs-approval',
  Stop: 'done',
  StopFailure: 'error',
  SessionEnd: null,
};

export function stateForEvent(event) {
  if (!Object.prototype.hasOwnProperty.call(HOOK_EVENTS, event)) {
    throw new Error(`unknown claude-code hook event: ${event}`);
  }
  return HOOK_EVENTS[event];
}

// The agent, not the hook. The hook is a short-lived node process under a
// shell under the agent; both die when the turn ends, so pruning on either
// pid would evict a live session on its very next event.
//
// THE PREDICATE THE TASK 1 SPIKE SETTLED (docs/spikes/2026-07-11-hook-environment.md,
// finding C), overriding the plan's original guess of "comm === 'claude'"
// alone. That guess picks the WRONG process in 370 of 1507 real samples (25%):
// background/daemon-hosted sessions put a `claude bg-pty-host` and a
// `claude daemon run` between the hook and the real agent, and the daemon
// process ALSO reports comm === 'claude' — but it owns no terminal
// (ttyNr === 0). Its fd 1 is a pipe or a log, not the user's screen.
//
// The corrected predicate — comm === 'claude' AND ttyNr !== 0 — found the
// right process in 1507 of 1507 samples, at depth 1 (interactive) or depth 4
// (background). Both `comm` and `ttyNr` come straight off /proc/<pid>/stat
// (see ../bus/proc.js), so no separate cmdline read is needed.
const AGENT_COMM = 'claude';

export function resolveAgentPid({
  startPid = process.pid,
  ancestors = procAncestors,
} = {}) {
  const chain = ancestors(startPid);
  // Skip index 0: that is this hook process itself.
  const agent = chain.find((p, i) => i > 0 && p.comm === AGENT_COMM && p.ttyNr !== 0);
  if (!agent) {
    throw new Error(
      `could not find the claude-code process among the ancestors of ${startPid}: ` +
      chain.map((p) => `${p.pid}(${p.comm})`).join(' -> ')
    );
  }
  return agent.pid;
}

// claude-code's events are already edges: every one of them names a state outright, and none of
// them needs to know what came before. The identity reducer is not a placeholder for something
// smarter -- it is the honest answer, and it is written here rather than defaulted in the core
// because a default in the core is how the core quietly acquires an opinion about agents.
export const reduceState = (level) => level;

// claude-code's status line runs `familiar statusline`, which prints the placeholder cells the
// transmitted image lands in. So familiar transmits.
export const printsPlaceholderCells = true;
