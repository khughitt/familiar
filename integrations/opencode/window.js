// THE WINDOW: opencode's session tree, folded down to one thing familiar can render.
//
// WHY THIS EXISTS AT ALL. opencode's event bus is the RAW, UNFILTERED global stream -- and its
// subagents are REAL CHILD SESSIONS with their own sessionID, publishing their own busy/idle
// (tool/task.ts:142-158, session/status.ts:39-48, which discriminates parent from child not at
// all). So the obvious integration -- one boolean, "is it busy" -- is wrong twice over: a child's
// `idle` clears the parent's `busy`, and a background subagent working while you look at another
// session is invisible.
//
// AND WHY WE DO NOT FILTER. The tempting fix is to keep only the session the user is viewing
// (api.route.current). That is wrong in the WORST direction: a permission prompt raised BY A
// SUBAGENT carries the CHILD's sessionID (session/tools.ts:81-89 hard-binds it into the ask), and
// the user must still answer it. Filtering on the active session would discard precisely the
// events whose entire purpose is to demand attention.
//
// The resolution is that ONE OPENCODE PROCESS IS ONE WINDOW -- for a local `opencode` the server
// runs in the TUI's own process, so there is no cross-window bleed on the bus. Every session in the
// process belongs to the window in front of you. So: no filter, no route to track, no parentID to
// walk. Just sets.
//
// (That invariant is the ground the design stands on, and it is why an externally-shared opencode
// server is explicitly out of scope. See the spec, §11.)
//
// PURE. No opencode imports, no I/O, no clock. Everything here is testable, and after the two
// paragraphs above it has real correctness to prove.

const BUSY = new Set(['busy', 'retry']);   // retry is a sub-state of busy (processor.ts:665-671)

export function createWindow() {
  // Two SETS, not two booleans. Each is a set because each has more than one member in the ordinary
  // case: sessions (parent + subagents), and permission ids (a subagent's ask and the parent's,
  // both pending, each needing its own answer).
  const busy = new Set();
  const permissions = new Set();

  // The field names are EXACT and were read off opencode's SDK types, not guessed. A permission ASK
  // reaches us on opencode's `permission.ask` hook (plugin.js synthesises `permission.asked` from
  // it, carrying the Permission's `id`); `permission.replied` is a real event and carries the id as
  // `properties.permissionID`. Cross them and the set never drains -- the window sticks in
  // `needs-approval` forever, which is the most annoying possible way to be wrong.
  function apply({ type, properties = {} }) {
    switch (type) {
      case 'session.status': {
        const kind = properties.status?.type;
        if (BUSY.has(kind)) busy.add(properties.sessionID);
        else if (kind === 'idle') busy.delete(properties.sessionID);
        else throw new Error(`opencode: unknown session status: ${kind}`);
        return;
      }
      case 'permission.asked':   permissions.add(properties.id); return;
      case 'permission.replied': permissions.delete(properties.permissionID); return;
      default:
        // session.error AND session.idle are both excluded deliberately, and binding.js filters both
        // before the fold. session.error is an EDGE, not a level (it changes no set; the plugin
        // enqueues it directly). session.idle is a redundant twin of the idle session.status that
        // opencode fires in the same set() — folding it too would transition twice (see binding.js's
        // LEVEL_EVENTS). Either one reaching here would be a caller's bug, so we say so.
        throw new Error(`opencode: the window does not track "${type}"`);
    }
  }

  // PRECEDENCE, and it is not arbitrary: it is ordered by how much the window needs YOU. A
  // permission is raised BY a busy session -- opencode leaves the session `busy` throughout -- so
  // both sets are non-empty at once in the ordinary case, and the more demanding one has to win or
  // the demand is never shown. (There is no `needs-input` tier: opencode's question events are not
  // on the stable server stream this plugin binds to. See plugin.js.)
  function level() {
    if (permissions.size) return 'permission.pending';
    if (busy.size) return 'session.busy';
    return 'session.idle';
  }

  return { apply, level };
}
