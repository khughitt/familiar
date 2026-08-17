import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync } from 'node:fs';
import { createWindow } from './window.js';
import { createQueue } from './queue.js';
import { spawnHook } from './hook.js';

// THE TRANSPORT — the testable core of familiar's opencode plugin. It observes opencode, folds what
// it sees into one window LEVEL (window.js), and shells out to familiar's ordinary hook CLI
// (hook.js) through a serialising queue (queue.js). It does NOT write to the bus: familiar is the
// single writer, under one lock, in a short-lived process, exactly as it is for claude-code and
// codex.
//
// This lives in its OWN module, apart from plugin.js, for a load-bearing reason: opencode's classic
// plugin loader imports the entry file and treats EVERY export as a plugin -- a non-function export
// fails the whole load with "Plugin export is not a function". So plugin.js exports nothing but the
// plugin function, and everything with correctness worth testing (createBinding, LEVEL_EVENTS) lives
// here, out of the loader's reach and reachable by `npm test`.
//
// A server plugin — the single writer of the bus. familiar ALSO ships a read-only TUI plugin
// (integrations/opencode/sprite-plugin.tsx) for the sidebar sprite; a controlled bisect (see
// docs/specs/2026-07-16-opencode-sprite-design.md §1) found the `tui.json` surface loads and
// renders fine, correcting the earlier "ships broken" note. This module stays purely the server
// side. For a local `opencode` the server runs IN the TUI's own process, so `process.pid` here is
// the window's pid and fd 1 is the user's screen -- the two facts the integration needs.
//
// FIVE OF THE SIX STATES. working / idle / done / error / needs-approval all arrive on the server
// event stream and the permission hook. needs-input (the question/idle-prompt) does NOT: opencode's
// `question.*` events are v2/experimental and absent from the stable server event union this plugin
// binds to. So we do not fake it -- opencode still reaches one more state than codex, and if the
// question events land in the stable stream later they slot into onEvent with no other change.

// OUR ERROR CHANNEL IS A FILE. A server plugin has no `api.ui.toast`, and its stderr IS the tty
// opentui is rendering into -- writing there corrupts the frame. So a failed hook, or a throw from
// the fold, goes here, where the user (and `familiar doctor`) can find it and the frame is untouched.
const STATE_DIR = process.env.FAMILIAR_STATE_DIR ?? join(homedir(), '.local', 'state', 'familiar');
const ERROR_LOG = join(STATE_DIR, 'opencode-plugin.log');
export function logError(message) {
  try {
    appendFileSync(ERROR_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch { /* the error channel itself is broken. There is nowhere left to complain to. */ }
}

// The events, out of opencode's whole firehose, that move the window's level. Three things are
// deliberately NOT here. `session.error` is an EDGE, not a level (handled separately below).
// Permission ASKS arrive on a dedicated hook, not the event stream. And `session.idle` is a
// REDUNDANT TWIN: opencode publishes it in the SAME `set()` call as the idle `session.status`
// (session/status.ts:41-43), so binding to both would fold and enqueue the idle transition TWICE --
// and the second reduction (done->idle) would erase the `done` pose on every clean turn. The idle
// `session.status` alone drives it. Everything else (message deltas, plugin churn, diffs, todos) is
// ignored.
export const LEVEL_EVENTS = new Set(['session.status', 'permission.replied']);

export function createBinding({ directory, pid = process.pid, spawn = spawnHook, report = logError } = {}) {
  // Authoritative and present at plugin init: the server plugin is handed the project directory
  // directly. If it is somehow absent we FAIL LOUDLY rather than falling back to process.cwd() --
  // opencode can be launched from anywhere, and a cat quietly attached to the wrong project is
  // worse than a plugin that says why it did not load.
  if (!directory) throw new Error('familiar: opencode gave us no project directory');

  // THE BUS KEY IS THE PROCESS, NOT THE SESSION. You switch sessions inside one opencode window;
  // key the bus by a sessionID and every switch strands a record that pruneDead (which reaps by pid
  // liveness) can never collect while the window lives. One window, one record, for its whole life.
  const payload = { session_id: `opencode:${pid}`, cwd: directory };

  const queue = createQueue({ run: (event) => spawn(event, payload), report });

  // OUR HANDLERS RUN INSIDE OPENCODE'S DISPATCHER. Everything a queued job does is already isolated
  // by the queue, but the fold (window.apply) runs synchronously HERE, before the enqueue, so a
  // throw from it -- an opencode session status kind we do not know -- would escape up into
  // opencode's loop, where the failure mode is undefined. We are a guest in this process: catch at
  // the seam and route to the same file the queue uses. Surfaced loudly, never silently swallowed,
  // but kept out of our host's dispatcher.
  const guarded = (label, fn) => {
    try {
      fn();
    } catch (err) {
      report(`familiar: ${label} handler failed — ${err?.message ?? err}`);
    }
  };

  // INIT GOES IN FIRST, BEFORE THE HOOKS ARE RETURNED. opencode delivers no event until the plugin
  // function resolves and the hooks are registered, so enqueueing `init` here -- synchronously,
  // before the return -- guarantees it reaches the bus before any transition. `init`'s level is
  // `idle`; landing after a `session.busy` it would reduce to **done**, the window announcing a turn
  // finished before it began. First makes that unrepresentable. (This is also the thing codex
  // cannot do: an opencode window announces itself the moment it opens.)
  queue.push('init');
  const window = createWindow();

  function onEvent({ event } = {}) {
    const type = event?.type;

    // AN EDGE, NOT A LEVEL. An error is a thing that HAPPENED; it changes no set, so it is enqueued
    // directly and the level is left alone -- and the idle `session.status` opencode sets microseconds
    // later is the one the adapter's reduceState turns back into `error` rather than `done`.
    // `sessionID` is OPTIONAL and opencode really does emit it without one, for PLUGIN and SKILL
    // load failures; those are not the agent's turn failing, so we drop them.
    if (type === 'session.error') {
      if (event.properties?.sessionID) queue.push('session.error');
      return;
    }

    if (!LEVEL_EVENTS.has(type)) return;
    // FOLDED SYNCHRONOUSLY, HERE. The window's sets are mutable and shared; a fold deferred into the
    // queued job would read them as they are when the job RUNS, and a burst of events would collapse
    // onto whatever the sets say once the queue drains, losing every intermediate state -- the
    // `permission.pending` the user is waiting on would vanish. Fold now; enqueue the string.
    guarded(type, () => {
      window.apply(event);
      queue.push(window.level());
    });
  }

  // opencode's DEDICATED permission hook -- a permission ask is not on the event stream. We only
  // OBSERVE: `output.status` is left untouched, so the user is still asked. The permission carries
  // the sessionID of whoever raised it -- a SUBAGENT's ask carries the CHILD's sessionID, and it
  // must raise the window too -- so we add it with NO filter. `session.status` leaves the raising
  // session `busy` throughout, which is why permission precedence has to win in window.level().
  function onPermissionAsk(permission) {
    guarded('permission.ask', () => {
      window.apply({ type: 'permission.asked', properties: { id: permission?.id } });
      queue.push(window.level());
    });
  }

  async function dispose() {
    // Queued LAST and AWAITED. It takes the record off the bus and resets the terminal's colours,
    // and runs even if every job before it failed (every job settles). opencode may not call this
    // on a hard quit -- pruneDead reaps the record by pid liveness as the backstop, so only the
    // colour reset on a cleanly-closed window depends on this firing.
    await queue.close('dispose');
  }

  return { onEvent, onPermissionAsk, dispose };
}
