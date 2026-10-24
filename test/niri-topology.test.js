// The lock-free workspace feed: Niri's event stream reduced to the rows a workspace
// switcher needs, keyed by stable IDs, and published newest-last.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLatestWriter, niriWorkspacesPath, reduceTopology, validateTopology } from '../integrations/niri/topology.js';
import { writeJsonAtomic } from '../src/bus/store.js';

const epoch = { bootId: '11111111-1111-4111-8111-111111111111', desktopSession: '/run/niri.sock' };
const opts = (now = 1000) => ({ now, instanceId: 'coordinator-1', epoch });
const ws = (id, idx, output, extra = {}) => ({
  id, idx, name: null, output, is_urgent: false, is_active: false, is_focused: false, active_window_id: null, ...extra,
});
// Two monitors, each with a workspace at index 2: only the stable ID tells them apart.
const seed = () => reduceTopology(null, { WorkspacesChanged: { workspaces: [
  ws(10, 1, 'DP-1', { is_active: true, is_focused: true, active_window_id: 5 }),
  ws(11, 2, 'DP-1', { name: 'code' }),
  ws(20, 1, 'HDMI-A-1', { is_active: true }),
  ws(21, 2, 'HDMI-A-1', { active_window_id: 9 }),
] } }, opts());
const row = (topology, id) => topology.workspaces.find((workspace) => workspace.id === id);

test('the initial WorkspacesChanged seeds normalized rows with decimal string IDs', () => {
  const topology = seed();
  assert.deepEqual(row(topology, '11'), { id: '11', idx: 2, name: 'code', output: 'DP-1', is_active: false, is_focused: false, is_urgent: false, occupied: false });
  assert.deepEqual(row(topology, '10'), { id: '10', idx: 1, output: 'DP-1', is_active: true, is_focused: true, is_urgent: false, occupied: true });
  assert.deepEqual([topology.schema, topology.revision, topology.connected, topology.instanceId, topology.writtenAt], [1, 1, true, 'coordinator-1', 1000]);
  assert.deepEqual(topology.epoch, epoch);
  assert.deepEqual(validateTopology(topology), topology);
});

test('activation moves the active row within its output and the focused row globally', () => {
  const focusedB = reduceTopology(seed(), { WorkspaceActivated: { id: 21, focused: true } }, opts(1010));
  assert.deepEqual(focusedB.workspaces.filter((w) => w.is_focused).map((w) => w.id), ['21']);
  assert.deepEqual(focusedB.workspaces.filter((w) => w.is_active).map((w) => w.id).sort(), ['10', '21']);
  assert.equal(focusedB.revision, 2);
  assert.equal(focusedB.writtenAt, 1010);
  const activeOnly = reduceTopology(seed(), { WorkspaceActivated: { id: 11, focused: false } }, opts());
  assert.deepEqual(activeOnly.workspaces.filter((w) => w.is_focused).map((w) => w.id), ['10']);
  assert.deepEqual(activeOnly.workspaces.filter((w) => w.is_active).map((w) => w.id).sort(), ['11', '20']);
});

test('urgency and occupancy follow their own events', () => {
  const urgent = reduceTopology(seed(), { WorkspaceUrgencyChanged: { id: 20, urgent: true } }, opts());
  assert.equal(row(urgent, '20').is_urgent, true);
  const emptied = reduceTopology(urgent, { WorkspaceActiveWindowChanged: { workspace_id: 21, active_window_id: null } }, opts());
  assert.equal(row(emptied, '21').occupied, false);
  const filled = reduceTopology(emptied, { WorkspaceActiveWindowChanged: { workspace_id: 11, active_window_id: 3 } }, opts());
  assert.equal(row(filled, '11').occupied, true);
});

test('unrelated events and no-op deltas return the same topology', () => {
  const topology = seed();
  assert.equal(reduceTopology(topology, { WindowFocusChanged: { id: 5 } }, opts(2000)), topology);
  assert.equal(reduceTopology(topology, { WorkspaceActivated: { id: 10, focused: true } }, opts(2000)), topology);
  assert.equal(reduceTopology(null, { WindowsChanged: { windows: [] } }, opts()), null);
});

test('a delta before a full snapshot or naming an unknown row is refused, never guessed', () => {
  assert.throws(() => reduceTopology(null, { WorkspaceActivated: { id: 10, focused: true } }, opts()), /before a full workspace snapshot/);
  assert.throws(() => reduceTopology(seed(), { WorkspaceActivated: { id: 99, focused: true } }, opts()), /unknown workspace/);
  assert.throws(() => reduceTopology(seed(), { WorkspaceActiveWindowChanged: { workspace_id: 99, active_window_id: 1 } }, opts()), /unknown workspace/);
});

test('unsafe or malformed workspace IDs are rejected rather than rounded', () => {
  for (const id of [2 ** 53, -1, 1.5, '10']) {
    assert.throws(() => reduceTopology(null, { WorkspacesChanged: { workspaces: [ws(id, 1, 'DP-1')] } }, opts()), /workspace id/);
  }
  assert.equal(row(reduceTopology(null, { WorkspacesChanged: { workspaces: [ws(2 ** 53 - 1, 1, 'DP-1')] } }, opts()), '9007199254740991').idx, 1);
  assert.throws(() => reduceTopology(seed(), { WorkspaceActivated: { id: 2 ** 53, focused: true } }, opts()), /workspace id/);
});

test('validateTopology refuses malformed documents', () => {
  const good = seed();
  for (const bad of [{ ...good, schema: 2 }, { ...good, extra: 1 }, { ...good, connected: 'yes' },
    { ...good, workspaces: [{ ...good.workspaces[0], id: 10 }] }, { ...good, epoch: { bootId: null } }]) {
    assert.throws(() => validateTopology(bad), /topology/);
  }
});

test('the feed lives in the configured state directory', () => {
  assert.equal(niriWorkspacesPath({ stateDir: '/s' }), '/s/niri-workspaces.json');
});

test('the latest-value writer never lets an older write replace a newer one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-topology-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'feed.json');
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writer = createLatestWriter({ path, writeAtomic: async (p, value) => {
    started.push(value.n);
    if (value.n === 1) await gate;
    await writeJsonAtomic(p, value);
  } });
  const first = writer.publish({ n: 1 });
  writer.publish({ n: 2 });
  writer.publish({ n: 3 });
  const last = writer.publish({ n: 4 });
  release();
  await Promise.all([first, last]);
  await writer.idle();
  assert.deepEqual(started, [1, 4]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 4 });
});

test('a failed write does not wedge the writer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-topology-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'feed.json');
  let fail = true;
  const errors = [];
  const writer = createLatestWriter({ path, onError: (error) => errors.push(error.message), writeAtomic: async (p, value) => {
    if (fail) { fail = false; throw new Error('disk full'); }
    await writeJsonAtomic(p, value);
  } });
  await writer.publish({ n: 1 });
  await writer.publish({ n: 2 });
  assert.deepEqual(errors, ['disk full']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
});
