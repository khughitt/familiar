import { ancestors as procAncestors } from '../bus/proc.js';
import { parsePayload } from './payload.js';

export { parsePayload };

// WHAT THE HOOKS ARE FOR HERE, WHICH IS NOT WHAT THEY ARE FOR IN CLAUDE-CODE.
//
// codex renders the cat itself (src/render/codex/pets.js) and drives the pose from its own turn
// state. So these hooks paint NOTHING in the terminal. What they do is put the session on the
// BUS -- and the surfaces that watch the bus need no cooperation from the agent whatsoever.
//
// That is the payoff: a codex session gets the same per-project identity on those surfaces as a
// claude-code session, and the terminal cat comes free from codex itself.
//
// TWO STATES ARE UNREACHABLE, and pretending otherwise would be worse than the gap:
//
//   needs-input  codex hooks have no idle-prompt notification. Its native pet renderer chooses
//                its own coarse state, but no hook event can put needs-input on Familiar's bus.
//                claude-code's Notification:idle_prompt has no counterpart.
//   error        codex has no error event either. PostToolUse carries a `tool_response` we could
//                sniff, and the rollout JSONL would tell us -- but codex documents that file's
//                format as UNSTABLE, and a state inferred from a schema nobody promises is a
//                state that silently stops working. We would rather show four states honestly
//                than six with two of them lying.
//
// Codex 0.146 emits SessionEnd. The shared transaction interprets its null mapping as removal;
// `familiar reap` remains the fallback for older Codex versions and abnormal termination.
//
// AND `SessionStart` DOES NOT FIRE AT LAUNCH. Measured: a codex TUI sat at a clean prompt for
// over a minute with no hook of any kind having run -- nothing on the bus, no title marker. The
// chain begins at the FIRST TURN. So a codex window you have opened but not yet spoken to is
// invisible to familiar, and `idle` below is not the state of a fresh window: it is the state
// codex reports when a session actually begins. There is no session before that, and nothing to
// say about one. (claude-code does fire at launch -- the two are not symmetric.)
export const HOOK_EVENTS = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PermissionRequest: 'needs-approval',
  Stop: 'done',
  SessionEnd: null,
};

// WE DO NOT DRAW IN CODEX'S TERMINAL, and this is the flag that says so -- but note WHICH
// question it asks. Not "does codex draw its own cat" (it does, natively, from a spritesheet on
// disk -- src/render/codex/pets.js), but "does anything in codex's UI print the CELLS an image
// would land in".
//
// The terminal renderer works by transmitting an image under an id and letting something PRINT
// the cells it lands in. codex has no status line we can print into -- its own is a closed enum
// of built-in items -- so there are no cells, and an image transmitted for cells that never get
// printed is a few KB of escape codes landing nowhere. Not harmful (a virtual placement draws
// nothing by definition), just a lie in the code about what we are doing.
//
// The title, the identity tint and the bell still go out: those need no cells, and the title is
// the entire channel the window-manager integration has (see osc.js).
export const printsPlaceholderCells = false;

// codex's events are edges, like claude-code's: each names a state outright. See claude-code.js.
export const reduceState = (level) => level;

export function stateForEvent(event) {
  if (!Object.prototype.hasOwnProperty.call(HOOK_EVENTS, event)) {
    throw new Error(`unknown codex hook event: ${event}`);
  }
  return HOOK_EVENTS[event];
}

// Same shape of question as claude-code's, same answer for the same reason: we need the process
// whose fd 1 is the user's screen and whose environment describes their terminal, and that is
// the agent, never the hook.
//
// `comm === 'codex'` AND a controlling terminal. Both halves earn their place, measured on this
// machine: a live codex session is a `codex` process with a tty, but it also spawns a
// `codex-code-mode` child (a different comm, so the name test alone is nearly enough) -- and the
// tty test is what claude-code's spike proved necessary when a daemon shares the agent's comm
// but owns no terminal. Requiring both costs nothing and closes the family of bugs where we
// write escape codes into something's log file.
const AGENT_COMM = 'codex';

export function resolveAgentPid({
  startPid = process.pid,
  ancestors = procAncestors,
} = {}) {
  const chain = ancestors(startPid);
  const agent = chain.find((p, i) => i > 0 && p.comm === AGENT_COMM && p.ttyNr !== 0);
  if (!agent) {
    throw new Error(
      `could not find the codex process among the ancestors of ${startPid}: ` +
      chain.map((p) => `${p.pid}(${p.comm})`).join(' -> ')
    );
  }
  return agent.pid;
}
