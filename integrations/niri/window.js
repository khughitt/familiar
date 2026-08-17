import { ancestors as procAncestors } from '../../src/bus/proc.js';
import { join } from 'node:path';

export const niriWindowsPath = (paths) => join(paths.stateDir, 'niri-windows.json');

// niri knows the TERMINAL's pid, not the agent's. Walk the agent's ancestors
// until one matches a window pid. This walk was demoted here from ohai's core,
// where it never belonged: session -> window -> workspace is an INTEGRATION
// concern, and nothing under src/ may depend on a compositor existing.
export function mapSessionsToWindows(agents, windows, { ancestors = procAncestors } = {}) {
  const byPid = new Map(windows.map((w) => [w.pid, w]));
  const map = {};

  for (const [sessionId, record] of Object.entries(agents)) {
    const hit = ancestors(record.pid).find((p) => byPid.has(p.pid));
    if (!hit) continue;   // no window: a headless or SSH session. Omit, do not guess.
    const window = byPid.get(hit.pid);
    map[sessionId] = { windowId: window.id, workspaceId: window.workspace_id };
  }

  return map;
}

// niri's event stream tags each event with a single top-level key. Any Window*
// or Workspace* event can change which workspace a window sits on — including
// the plain move that `WindowOpenedOrChanged` reports — so all of them
// invalidate the map. Resyncing is one `niri msg` round trip; it keeps workspace
// awareness current after a terminal moves.
export function shouldResync(event) {
  const kind = Object.keys(event ?? {})[0] ?? '';
  return kind.startsWith('Window') || kind.startsWith('Workspace');
}
