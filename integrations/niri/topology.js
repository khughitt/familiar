// The workspace feed a switcher widget reads: Niri's own event stream reduced to stable
// rows and published immediately, with no lock, no debounce and no attention work in
// the way. Attention attribution joins these same IDs; indices are labels only.
import { join } from 'node:path';
import { writeJsonAtomic } from '../../src/bus/store.js';

export const niriWorkspacesPath = (paths) => join(paths.stateDir, 'niri-workspaces.json');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const flag = (value) => typeof value === 'boolean';
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const FLAGS = ['is_active', 'is_focused', 'is_urgent', 'occupied'];

const fail = (message) => { throw new Error(`niri topology: ${message}`); };

// Niri IDs are u64. Above 2^53 - 1 a JavaScript number cannot hold one exactly, so the
// adapter refuses it rather than round it into some other workspace's ID.
export function workspaceIdText(value) {
  if (!integer(value)) fail(`workspace id ${JSON.stringify(value)} is not an integer in 0..${Number.MAX_SAFE_INTEGER}`);
  return String(value);
}

function rowOf(workspace) {
  if (!object(workspace)) fail('workspace must be an object');
  const id = workspaceIdText(workspace.id);
  if (!integer(workspace.idx)) fail(`workspace ${id} has an invalid idx`);
  for (const key of ['is_active', 'is_focused', 'is_urgent']) if (!flag(workspace[key])) fail(`workspace ${id} has an invalid ${key}`);
  for (const key of ['name', 'output']) {
    if (!(workspace[key] === null || workspace[key] === undefined || text(workspace[key]))) fail(`workspace ${id} has an invalid ${key}`);
  }
  if (!(workspace.active_window_id === null || integer(workspace.active_window_id))) fail(`workspace ${id} has an invalid active_window_id`);
  return {
    id, idx: workspace.idx, ...(text(workspace.name) ? { name: workspace.name } : {}),
    ...(text(workspace.output) ? { output: workspace.output } : {}),
    is_active: workspace.is_active, is_focused: workspace.is_focused, is_urgent: workspace.is_urgent,
    occupied: workspace.active_window_id !== null,
  };
}

export function validateTopology(value) {
  const keys = ['schema', 'instanceId', 'epoch', 'revision', 'writtenAt', 'connected', 'workspaces'];
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail('document has missing or unknown fields');
  if (value.schema !== 1 || !text(value.instanceId) || !integer(value.revision) || !integer(value.writtenAt) || !flag(value.connected)) fail('header is invalid');
  if (!object(value.epoch) || Object.keys(value.epoch).length !== 2
    || !(value.epoch.bootId === null || text(value.epoch.bootId))
    || !(value.epoch.desktopSession === null || text(value.epoch.desktopSession))) fail('epoch is invalid');
  if (!Array.isArray(value.workspaces)) fail('workspaces must be an array');
  for (const row of value.workspaces) {
    const allowed = ['id', 'idx', 'name', 'output', ...FLAGS];
    if (!object(row) || Object.keys(row).some((key) => !allowed.includes(key))) fail('workspace row has unknown fields');
    if (typeof row.id !== 'string' || !DECIMAL.test(row.id) || !integer(row.idx)) fail('workspace row id or idx is invalid');
    if (!FLAGS.every((key) => flag(row[key]))) fail(`workspace ${row.id} flags are invalid`);
    for (const key of ['name', 'output']) if (Object.hasOwn(row, key) && !text(row[key])) fail(`workspace ${row.id} ${key} is invalid`);
  }
  if (value.workspaces.filter((row) => row.is_focused).length > 1) fail('more than one focused workspace');
  return structuredClone(value);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One event in, the next topology out; the same object back when nothing a switcher
// shows changed. A delta Niri sends before its full snapshot, or for a row it never
// announced, means this reduction has lost track: it throws, and the stream is
// restarted to reacquire the initial state.
export function reduceTopology(topology, event, { now, instanceId, epoch }) {
  const [kind] = Object.keys(event ?? {});
  const body = event?.[kind];
  let workspaces;
  if (kind === 'WorkspacesChanged') {
    if (!object(body) || !Array.isArray(body.workspaces)) fail('WorkspacesChanged without a workspace list');
    workspaces = body.workspaces.map(rowOf).sort((a, b) => (a.output ?? '').localeCompare(b.output ?? '') || a.idx - b.idx);
  } else if (['WorkspaceActivated', 'WorkspaceUrgencyChanged', 'WorkspaceActiveWindowChanged'].includes(kind)) {
    if (topology === null) fail(`${kind} before a full workspace snapshot`);
    const id = workspaceIdText(kind === 'WorkspaceActiveWindowChanged' ? body?.workspace_id : body?.id);
    const target = topology.workspaces.find((row) => row.id === id);
    if (!target) fail(`${kind} names unknown workspace ${id}`);
    workspaces = topology.workspaces.map((row) => ({ ...row }));
    const at = workspaces.find((row) => row.id === id);
    if (kind === 'WorkspaceActivated') {
      if (!flag(body.focused)) fail('WorkspaceActivated without a focused flag');
      for (const row of workspaces) {
        if (row.output === at.output) row.is_active = row === at;
        if (body.focused) row.is_focused = row === at;
      }
    } else if (kind === 'WorkspaceUrgencyChanged') {
      if (!flag(body.urgent)) fail('WorkspaceUrgencyChanged without an urgent flag');
      at.is_urgent = body.urgent;
    } else {
      if (!(body.active_window_id === null || integer(body.active_window_id))) fail('invalid active_window_id');
      at.occupied = body.active_window_id !== null;
    }
  } else {
    return topology;
  }
  if (topology !== null && topology.connected && same(topology.workspaces, workspaces)) return topology;
  return validateTopology({
    schema: 1, instanceId, epoch: { bootId: epoch.bootId, desktopSession: epoch.desktopSession },
    revision: (topology?.revision ?? 0) + 1, writtenAt: now, connected: true, workspaces,
  });
}

// One writer per file that only ever writes the newest value it has been given: a
// burst collapses to its last value, and an older write never lands after a newer one.
export function createLatestWriter({ path, writeAtomic = writeJsonAtomic, onError = () => {} }) {
  let pending = null;
  let running = null;
  const drain = async () => {
    while (pending !== null) {
      const { value, waiters } = pending;
      pending = null;
      try {
        await writeAtomic(path, value);
      } catch (error) {
        onError(error);
      }
      for (const resolve of waiters) resolve();
    }
    running = null;
  };
  return {
    publish(value) {
      return new Promise((resolve) => {
        if (pending === null) pending = { value, waiters: [resolve] };
        else {
          pending.value = value;
          pending.waiters.push(resolve);
        }
        running ??= drain();
      });
    },
    idle: () => running ?? Promise.resolve(),
  };
}
