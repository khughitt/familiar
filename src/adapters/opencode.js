import { ancestors as procAncestors } from '../bus/proc.js';
import { parsePayload } from './payload.js';

export { parsePayload };

// opencode has NO HOOKS. It has plugins -- long-lived JavaScript inside the agent's own process
// -- and the events below are not opencode's. They are OURS: the seven things the plugin, in the
// integration layer, says, having folded opencode's session tree down to one window.
//
// So `session.busy` is not opencode's `session.status`. It means "some session in this window is
// working", which is a fact about the WINDOW, and the plugin is the only thing that can know it:
// opencode's bus carries every session in the process, subagents included, and a subagent's
// `idle` must not clear its parent's `busy`. That fold is opencode's concurrency model and it
// stays in the plugin. What stays HERE is the only thing familiar can decide -- what a window
// level MEANS -- and it stays here because `npm test` cannot reach inside somebody else's TUI.
//
// opencode reaches FIVE of familiar's six states -- one more than codex, which produces neither
// `error` nor `needs-input` and is not on the bus until its first turn. opencode's server plugin
// runs at LAUNCH (the window is on the bus the moment it opens), publishes `error`, and raises
// `needs-approval` on every permission ask. The sixth, `needs-input`, needs opencode's question
// events, which are not on the stable server event stream the plugin binds to -- so it is not
// driven rather than faked. If they reach the stable stream later, add a `question.pending` mapping
// here and a case in window.js; nothing else changes.
export const HOOK_EVENTS = {
  init: 'idle',
  'session.busy': 'working',
  'permission.pending': 'needs-approval',
  'session.error': 'error',
  'session.idle': 'idle',
  dispose: null,
};

export function stateForEvent(event) {
  if (!Object.prototype.hasOwnProperty.call(HOOK_EVENTS, event)) {
    throw new Error(`unknown opencode event: ${event}`);
  }
  return HOOK_EVENTS[event];
}

// ACTIVE = the states in which the window is MID-TURN. `idle` and `done` are not active (nothing
// is happening) and `error` is not active (something STOPPED happening). The distinction is the
// whole definition of `done`: quiet that follows work.
const ACTIVE = new Set(['working', 'needs-input', 'needs-approval']);

// THE ONE REDUCTION IN THE PROJECT, and it exists because of one measured fact:
//
//   opencode publishes `session.error` and then sets the session status to idle, IMMEDIATELY --
//   `SessionProcessor.halt`, processor.ts:599-626:
//
//       yield* events.publish(Session.Event.Error, { sessionID, error })
//       yield* status.set(ctx.sessionID, { type: "idle" })
//
// Map that idle to `done` unconditionally and the error is overwritten microseconds after it is
// written. TTL_ERROR_MS is 30 seconds precisely so that a failure gets longer to be noticed than
// a success; under that map it would never be noticed at ALL. The error state would be dead code.
//
// `prev` is the only thing that can tell those two idles apart, and `prev` exists only inside the
// bus lock -- which is why this is a second function and not an argument to stateForEvent, whose
// job (validate the event, before the lock, before any write) must not move.
export function reduceState(level, prev) {
  if (level !== 'idle') return level;
  if (prev === 'error') return 'error';   // the idle that follows an error must not erase it
  if (ACTIVE.has(prev)) return 'done';    // the turn ended
  return 'idle';                          // quiet after quiet, or after a done that already decayed
}

// opencode draws nothing, and nothing in its UI prints the cells an image would land in. Not
// "for now" in the sense of an oversight: @opentui/core stores ONE codepoint per cell, so the
// kitty placeholder's combining diacritics are unrepresentable, and the way through (N one-row
// images, the row encoded in the image id) is its own spec. See the design doc, §7.
export const printsPlaceholderCells = false;

// Same shape of question as claude-code's and codex's, and the same answer for the same reason:
// we need the process whose fd 1 is the user's screen, and that is the agent, never the hook.
//
// `comm === 'opencode'` AND a controlling terminal. The tty half is not belt-and-braces: it is
// what claude-code's spike proved necessary when a daemon shares the agent's comm but owns no
// terminal, and its fd 1 is a pipe or a log file. Requiring both costs nothing and closes the
// whole family of bugs where we write escape codes into something's log.
//
// Note the plugin ALSO knows this pid -- it is `process.pid` in opencode's own process, and it is
// what the session key is built from. The two agree by construction (the hook is a child of
// opencode), and we still walk the chain rather than trusting the payload: the tty check is a
// real guard, and a payload is a claim.
const AGENT_COMM = 'opencode';

export function resolveAgentPid({
  startPid = process.pid,
  ancestors = procAncestors,
} = {}) {
  const chain = ancestors(startPid);
  const agent = chain.find((p, i) => i > 0 && p.comm === AGENT_COMM && p.ttyNr !== 0);
  if (!agent) {
    throw new Error(
      `could not find the opencode process among the ancestors of ${startPid}: ` +
      chain.map((p) => `${p.pid}(${p.comm})`).join(' -> ')
    );
  }
  return agent.pid;
}
