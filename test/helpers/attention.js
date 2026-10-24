// Deterministic raw-registry traces for the attention tests. Events come from relay's
// public normalizer and its adapters' own state reduction, so a trace states what a
// harness reports rather than what a test hopes it reports. Every attention change goes
// through the production reducer; nothing here decides lifecycle.
import { adapterFor, normalizeEvent } from 'relay';
import { initialAttention, reduceAttention, validateAttention } from '../../src/attention/model.js';

export const GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OTHER_GENERATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const BOOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CWD = '/work/repo';

export const handle = (pid = 4242, start = '9000') => ({ platform: 'linux', host: 'host', bootId: BOOT, pid, start });

// One native hook payload, normalized exactly as relay's dispatcher would.
export function nativeEvent(harness, native, { session, worker, background } = {}) {
  const data = { session_id: session, cwd: CWD };
  if (worker !== undefined) data.agent_id = worker;
  if (background !== undefined) data.background_tasks = background;
  if (native === 'PreToolUse') Object.assign(data, { tool_name: 'Read', tool_input: { file_path: '/work/repo/a' } });
  return normalizeEvent(harness, native, JSON.stringify(data));
}

// The registry rows relay would hold after applying events, using relay's adapters for
// every state reduction. Only the bookkeeping a test needs is modelled.
export function createRegistry({ now = () => 1000 } = {}) {
  const rows = new Map();
  return {
    rows: () => [...rows.values()].map((row) => structuredClone(row)),
    apply(event, { process = handle() } = {}) {
      const adapter = adapterFor(event.harness);
      const level = adapter.stateForEvent(event.nativeEvent);
      if (level === null) {
        for (const [id, row] of rows) if (id === event.agentId || row.root === event.agentId) rows.delete(id);
        return;
      }
      const previous = rows.get(event.agentId);
      const background = event.background === undefined ? previous?.background : event.background ?? undefined;
      const state = adapter.reduceState(level, previous?.state ?? null, { background });
      rows.set(event.agentId, {
        id: event.agentId, harness: event.harness, sessionId: event.sessionId,
        scope: event.harness === 'opencode' ? 'process' : event.root === undefined ? 'session' : 'worker',
        ...(event.root === undefined ? {} : { root: event.root }),
        ...(background === undefined ? {} : { background }),
        process: previous?.process ?? process, cwd: CWD, repoRoot: CWD, remote: null,
        projectKey: 'repo-key', project: 'repo', state, updatedAt: now(),
      });
    },
    replace(agentId, change) { rows.set(agentId, { ...rows.get(agentId), ...change }); },
    remove(agentId) { rows.delete(agentId); },
  };
}

export function snapshotOf(rows, { generation = GENERATION, revision = 1 } = {}) {
  return { schema: 2, generation, revision, agents: Object.fromEntries(rows.map((row) => [row.id, row])) };
}

const roundTrip = (state) => validateAttention(JSON.parse(JSON.stringify(state)));

// Drives the production reducer through a trace. `observe` takes the registry rows after
// some events and, optionally, the event whose envelope announces them; `eventRevision`
// lets a test deliver a delayed envelope older than the snapshot it is reconciled with.
export function traceAttention({ generation = GENERATION, start = 1000 } = {}) {
  let state = initialAttention();
  let revision = 0;
  let now = start;
  let instance = 'coordinator-1';
  const results = [];
  const step = (input) => {
    const out = reduceAttention(state, input);
    state = roundTrip(out.state);
    results.push(out.result);
    return out.result;
  };
  const sourceKeyOf = (agentId) => {
    const keys = Object.keys(state.sources).filter((key) => state.sources[key].agentId === agentId);
    if (keys.length !== 1) throw new Error(`trace: expected one live source for ${agentId}, found ${keys.length}`);
    return keys[0];
  };
  const workspace = (id, focused) => ({
    id, idx: Number(id), output: 'DP-1', is_active: focused, is_focused: focused, is_urgent: false, occupied: true,
  });
  return {
    get state() { return state; },
    get now() { return now; },
    get revision() { return revision; },
    tick(ms) { now += ms; },
    sourceKeyOf,
    episodesOf(agentId, { open = false } = {}) {
      const key = sourceKeyOf(agentId);
      return Object.values(state.episodes)
        .filter((episode) => episode.sourceKey === key && (!open || !episode.closed))
        .sort((a, b) => a.order - b.order);
    },
    // `snapshotAhead` skips revisions other events published before this observer read
    // the registry; `envelopeGen` names the generation the envelope was published under.
    observe(rows, event = null, eventRevision = undefined, { gen = generation, snapshotAhead = 0, envelopeGen = gen } = {}) {
      revision += 1 + snapshotAhead;
      now += 1;
      const snapshot = rows === null ? null : snapshotOf(rows, { generation: gen, revision });
      const envelope = event === null ? null : {
        schema: 1, type: 'event', subscriber: 'familiar',
        event: { ...event, tool: event.tool === null ? null : { name: event.tool.name } },
        registry: { generation: envelopeGen, revision: eventRevision ?? revision }, changed: true, reaped: [],
      };
      return step({ type: 'observe', snapshot, envelope, now });
    },
    // A stale snapshot: an observer that read the registry before another one published.
    observeAt(rows, snapshotRevision, { gen = generation } = {}) {
      now += 1;
      return step({ type: 'observe', snapshot: snapshotOf(rows, { generation: gen, revision: snapshotRevision }), envelope: null, now });
    },
    desktop({ focused = null, origins = {}, dnd = 'off', status = 'known', seenIds = undefined } = {}) {
      now += 1;
      const ids = new Set(Object.values(origins));
      if (focused !== null) ids.add(focused);
      const byRoot = Object.fromEntries(Object.entries(origins)
        .map(([agentId, workspaceId]) => [sourceKeyOf(agentId), { workspaceId, output: 'DP-1' }]));
      return step({
        type: 'desktop', instanceId: instance, status, dnd,
        workspaces: [...ids].sort().map((id) => workspace(id, id === focused)),
        origins: byRoot, enrichment: {}, ...(seenIds === undefined ? {} : { seenIds }), now,
      });
    },
    dismiss(ids) { now += 1; return step({ type: 'dismiss', ids, now }); },
    initialise(consumerId, ids) { now += 1; return step({ type: 'initialise-popup', consumerId, ids, now }); },
    claim(surface, consumerId, token) { now += 1; return step({ type: 'claim', surface, consumerId, token, now }); },
    finish(surface, token, outcome) { now += 1; return step({ type: 'finish', surface, token, outcome, now }); },
    // A coordinator restart: the saved file is reread and a new instance recovers it,
    // suppressing every transient opportunity the old instance had queued.
    restart(instanceId = 'coordinator-2') {
      state = roundTrip(state);
      instance = instanceId;
      now += 1;
      const ids = Object.values(state.episodes).filter((episode) => ['pending', 'eligible']
        .some((status) => episode.delivery.popup.status === status || episode.delivery.toast.status === status))
        .map((episode) => episode.id);
      return step({ type: 'recover', instanceId, ids, now });
    },
  };
}
