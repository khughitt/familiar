import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSessionsToWindows, niriWindowsPath, shouldResync } from '../integrations/niri/window.js';

// The agent runs inside a terminal; niri knows the terminal's pid, not the
// agent's. Walking the agent's ancestors until one matches a window pid is the
// join. This walk was demoted here from ohai's core, where it never belonged.
const windows = [
  { id: 7, pid: 200, workspace_id: 2 },
  { id: 9, pid: 900, workspace_id: 3 },
];

const ancestorsOf = {
  300: [{ pid: 300 }, { pid: 250 }, { pid: 200 }, { pid: 1 }],   // under window 7
  800: [{ pid: 800 }, { pid: 1 }],                                // under nothing
};

test('joins a session to its window and workspace through the pid ancestry', () => {
  const agents = { s1: { sessionId: 's1', pid: 300 } };
  assert.deepEqual(
    mapSessionsToWindows(agents, windows, { ancestors: (pid) => ancestorsOf[pid] ?? [] }),
    { s1: { windowId: 7, workspaceId: 2 } }
  );
});

test('a session with no window is omitted, not guessed at', () => {
  const agents = { s2: { sessionId: 's2', pid: 800 } };
  assert.deepEqual(
    mapSessionsToWindows(agents, windows, { ancestors: (pid) => ancestorsOf[pid] ?? [] }),
    {}
  );
});

test('two sessions in one terminal retain the same workspace awareness', () => {
  const agents = { s1: { sessionId: 's1', pid: 300 }, s3: { sessionId: 's3', pid: 300 } };
  const map = mapSessionsToWindows(agents, windows, { ancestors: (pid) => ancestorsOf[pid] ?? [] });
  assert.equal(map.s1.workspaceId, 2);
  assert.equal(map.s3.workspaceId, 2);
});

test('the workspace map path stays at the Niri integration seam', () => {
  assert.equal(niriWindowsPath({ stateDir: '/state' }), '/state/niri-windows.json');
});

test('the map is NOT fixed for the life of a session — every window/workspace event invalidates it', () => {
  // A terminal moved to another workspace is the common case, and the one that
  // leaves workspace awareness pointing at the prior workspace.
  assert.equal(shouldResync({ WindowOpenedOrChanged: { window: {} } }), true);
  assert.equal(shouldResync({ WindowClosed: { id: 7 } }), true);
  assert.equal(shouldResync({ WindowsChanged: { windows: [] } }), true);
  assert.equal(shouldResync({ WorkspaceActivated: { id: 2 } }), true);
  assert.equal(shouldResync({ WorkspacesChanged: { workspaces: [] } }), true);

  assert.equal(shouldResync({ KeyboardLayoutsChanged: {} }), false);
  assert.equal(shouldResync({}), false);
});
