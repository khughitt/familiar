// The portable attention reducer: which agent sources need the user, and what each
// surface has done about it. It reads relay's raw registry rows (never familiar's folded
// pet state), so a worker's activity cannot erase its root's request. It knows nothing
// of sprites, compositors or files; callers persist its state and supply the desktop.
// Spec: docs/specs/2026-10-24-desktop-attention-design.md.
import { createHash } from 'node:crypto';
import { adapterFor } from 'relay';

export class AttentionSchemaError extends Error {
  constructor(message) {
    super(`attention: ${message}`);
    this.name = 'AttentionSchemaError';
    this.code = 'ATTENTION_SCHEMA';
  }
}

const fail = (message) => { throw new AttentionSchemaError(message); };

const STATES = ['idle', 'working', 'needs-input', 'needs-approval', 'done', 'error'];
const KINDS = ['needs-input', 'needs-approval', 'error', 'completion'];
const REQUESTS = new Set(['needs-input', 'needs-approval', 'error']);
// A worker in one of these states keeps its root's turn from counting as finished.
const BLOCKING = new Set(['working', 'needs-input', 'needs-approval']);
const DELIVERY = ['pending', 'eligible', 'reserved', 'delivered', 'failed', 'suppressed', 'interrupted', 'uncertain'];
const OUTCOMES = ['delivered', 'failed', 'suppressed', 'interrupted'];
const QUEUED = new Set(['pending', 'eligible']);
const SURFACES = ['popup', 'toast'];
const PRIORITY = { error: 0, 'needs-approval': 1, 'needs-input': 2, completion: 3 };
// Closed episodes are kept for their live source's history, newest first, up to this many.
const CLOSED_KEPT = 8;
const MAX_TEXT = 128;
const MAX_IDS = 512;

// --- validation --------------------------------------------------------------------

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const bounded = (value) => text(value) && value.length <= MAX_TEXT;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const flag = (value) => typeof value === 'boolean';
const nullable = (check) => (value) => value === null || check(value);

function exactKeys(value, required, optional = [], where) {
  if (!object(value)) fail(`${where} must be an object`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${where} is missing ${key}`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${where} has unknown field ${key}`);
  }
}

function check(valid, message) { if (!valid) fail(message); }

const validHandle = (value) => object(value) && ['linux', 'darwin'].includes(value.platform)
  && text(value.host) && (value.bootId === null || text(value.bootId))
  && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.start === 'string' && /^(0|[1-9][0-9]*)$/.test(value.start);

function validDelivery(value, where) {
  exactKeys(value, ['status'], ['token', 'consumer', 'at'], where);
  check(DELIVERY.includes(value.status), `${where}.status is invalid`);
  const reserved = value.status === 'reserved';
  for (const key of ['token', 'consumer']) {
    check(reserved ? bounded(value[key]) : !Object.hasOwn(value, key), `${where}.${key} is invalid`);
  }
  check(reserved ? integer(value.at) : !Object.hasOwn(value, 'at'), `${where}.at is invalid`);
}

function validSource(value, key) {
  const where = `source ${key}`;
  exactKeys(value, ['agentId', 'harness', 'scope', 'rootKey', 'generation', 'process', 'state', 'observedAt', 'frontier'], [], where);
  check(text(value.agentId) && ['claude-code', 'codex', 'opencode'].includes(value.harness), `${where} identity is invalid`);
  check(['root', 'worker'].includes(value.scope), `${where}.scope is invalid`);
  check(value.scope === 'root' ? value.rootKey === key : nullable(text)(value.rootKey), `${where}.rootKey is invalid`);
  check(text(value.generation) && (value.process === null || validHandle(value.process)), `${where} incarnation is invalid`);
  check(value.state === null || STATES.includes(value.state), `${where}.state is invalid`);
  check(integer(value.observedAt) && integer(value.frontier), `${where} observation is invalid`);
}

function validEpisode(value, key) {
  const where = `episode ${key}`;
  exactKeys(value, ['id', 'sourceKey', 'rootKey', 'kind', 'order', 'createdAt', 'seen', 'dismissed', 'closed', 'delivery'], [], where);
  check(value.id === key && text(value.sourceKey) && nullable(text)(value.rootKey), `${where} identity is invalid`);
  check(KINDS.includes(value.kind) && integer(value.order) && integer(value.createdAt), `${where} kind or order is invalid`);
  check(flag(value.seen) && flag(value.dismissed) && flag(value.closed), `${where} disposition is invalid`);
  exactKeys(value.delivery, SURFACES, [], `${where}.delivery`);
  for (const surface of SURFACES) validDelivery(value.delivery[surface], `${where}.delivery.${surface}`);
}

function validDiagnostic(value, key) {
  const where = `diagnostic ${key}`;
  exactKeys(value, ['id', 'rootKey', 'blockers', 'observedAt', 'dismissed'], [], where);
  check(value.id === key && text(value.rootKey), `${where} identity is invalid`);
  check(Array.isArray(value.blockers) && value.blockers.length > 0 && value.blockers.every(text), `${where}.blockers is invalid`);
  check(integer(value.observedAt) && flag(value.dismissed), `${where} observation is invalid`);
}

function validWorkspace(value, where) {
  exactKeys(value, ['id', 'idx', 'is_active', 'is_focused', 'is_urgent', 'occupied'], ['name', 'output'], where);
  check(typeof value.id === 'string' && /^(0|[1-9][0-9]*)$/.test(value.id), `${where}.id must be a decimal string`);
  check(integer(value.idx), `${where}.idx is invalid`);
  for (const key of ['is_active', 'is_focused', 'is_urgent', 'occupied']) check(flag(value[key]), `${where}.${key} is invalid`);
  for (const key of ['name', 'output']) check(!Object.hasOwn(value, key) || text(value[key]), `${where}.${key} is invalid`);
}

function validDesktop(value, where = 'desktop') {
  exactKeys(value, ['instanceId', 'status', 'dnd', 'workspaces', 'origins', 'enrichment'], [], where);
  check(nullable(bounded)(value.instanceId), `${where}.instanceId is invalid`);
  check(['known', 'unknown', 'disconnected'].includes(value.status), `${where}.status is invalid`);
  check(['on', 'off', 'unknown'].includes(value.dnd), `${where}.dnd is invalid`);
  check(Array.isArray(value.workspaces), `${where}.workspaces must be an array`);
  value.workspaces.forEach((workspace, index) => validWorkspace(workspace, `${where}.workspaces[${index}]`));
  check(value.workspaces.filter((workspace) => workspace.is_focused).length <= 1, `${where} has more than one focused workspace`);
  check(object(value.origins), `${where}.origins must be an object`);
  for (const [key, origin] of Object.entries(value.origins)) {
    exactKeys(origin, ['workspaceId', 'output'], [], `${where}.origins ${key}`);
    check(text(origin.workspaceId) && nullable(text)(origin.output), `${where}.origins ${key} is invalid`);
  }
  check(object(value.enrichment) && Object.values(value.enrichment).every(object), `${where}.enrichment is invalid`);
}

export function validateAttention(value) {
  exactKeys(value, ['schema', 'revision', 'registry', 'nextEpisode', 'sources', 'episodes', 'turns', 'diagnostics', 'desktop'], [], 'state');
  check(value.schema === 1, 'state.schema must be 1');
  check(integer(value.revision) && integer(value.nextEpisode) && value.nextEpisode > 0, 'state counters are invalid');
  if (value.registry !== null) {
    exactKeys(value.registry, ['generation', 'revision'], [], 'state.registry');
    check(value.registry.generation === null ? value.registry.revision === null
      : text(value.registry.generation) && integer(value.registry.revision), 'state.registry is invalid');
  }
  for (const name of ['sources', 'episodes', 'turns', 'diagnostics']) check(object(value[name]), `state.${name} must be an object`);
  for (const [key, source] of Object.entries(value.sources)) validSource(source, key);
  for (const [key, episode] of Object.entries(value.episodes)) {
    validEpisode(episode, key);
    check(Object.hasOwn(value.sources, episode.sourceKey), `episode ${key} names an unknown source`);
  }
  for (const [key, turn] of Object.entries(value.turns)) {
    exactKeys(turn, ['episodeId', 'observedAt'], [], `turn ${key}`);
    check(Object.hasOwn(value.sources, key) && Object.hasOwn(value.episodes, turn.episodeId) && integer(turn.observedAt), `turn ${key} is invalid`);
  }
  for (const [key, diagnostic] of Object.entries(value.diagnostics)) validDiagnostic(diagnostic, key);
  validDesktop(value.desktop, 'state.desktop');
  return structuredClone(value);
}

const initialDesktop = () => ({ instanceId: null, status: 'unknown', dnd: 'unknown', workspaces: [], origins: {}, enrichment: {} });

export function initialAttention() {
  return {
    schema: 1, revision: 0, registry: null, nextEpisode: 1,
    sources: {}, episodes: {}, turns: {}, diagnostics: {}, desktop: initialDesktop(),
  };
}

// --- sources and episodes ------------------------------------------------------------

const processKey = (process) => `${process.host}:${process.bootId ?? '-'}:${process.pid}:${process.start}`;

function sourceKeyFor(state, generation, row) {
  if (row.process !== null) return `${generation}/${row.id}/${processKey(row.process)}`;
  // No process identity: the same live source keeps its key; a reappearance after
  // absence gets a fresh local incarnation, because nothing proves it is the same one.
  const live = Object.entries(state.sources)
    .find(([, source]) => source.generation === generation && source.agentId === row.id && source.process === null);
  return live ? live[0] : `${generation}/${row.id}/#${state.nextEpisode++}`;
}

const suppressQueued = (episode) => {
  for (const surface of SURFACES) {
    if (QUEUED.has(episode.delivery[surface].status)) episode.delivery[surface] = { status: 'suppressed' };
  }
};

function openEpisode(ctx, key, kind, { restored = false } = {}) {
  const order = ctx.state.nextEpisode++;
  const id = `e${order}`;
  const status = restored ? 'suppressed' : 'pending';
  ctx.state.episodes[id] = {
    id, sourceKey: key, rootKey: ctx.state.sources[key].rootKey, kind, order, createdAt: ctx.now,
    seen: false, dismissed: false, closed: false, delivery: { popup: { status }, toast: { status } },
  };
  ctx.result.opened.push(id);
  return ctx.state.episodes[id];
}

function closeEpisode(ctx, episode) {
  if (episode.closed) return;
  episode.closed = true;
  suppressQueued(episode);
  ctx.result.closed.push(episode.id);
}

const episodesOf = (state, key) => Object.values(state.episodes)
  .filter((episode) => episode.sourceKey === key).sort((a, b) => a.order - b.order);

function endSource(ctx, key) {
  const { state } = ctx;
  for (const episode of episodesOf(state, key)) {
    closeEpisode(ctx, episode);
    delete state.episodes[episode.id];
  }
  delete state.turns[key];
  for (const [id, diagnostic] of Object.entries(state.diagnostics)) if (diagnostic.rootKey === key) delete state.diagnostics[id];
  delete state.sources[key];
}

const diagnosticId = (rootKey, blockers) => `d${createHash('sha256')
  .update([rootKey, ...blockers].join('\n')).digest('hex').slice(0, 16)}`;

function blockersOf(rootKey, current) {
  return [...current].filter(([, { row, source }]) => source.scope === 'worker' && source.rootKey === rootKey
    && BLOCKING.has(row.state)).map(([key]) => key).sort();
}

// A genuine root completion with live workers: publish (or refresh) the one diagnostic
// for exactly this blocker set. Its dismissal belongs to that set, not to the turn.
function withhold(ctx, rootKey, blockers) {
  const id = diagnosticId(rootKey, blockers);
  for (const [other, diagnostic] of Object.entries(ctx.state.diagnostics)) {
    if (diagnostic.rootKey === rootKey && other !== id) delete ctx.state.diagnostics[other];
  }
  const existing = ctx.state.diagnostics[id];
  ctx.state.diagnostics[id] = existing ? { ...existing, observedAt: ctx.now }
    : { id, rootKey, blockers, observedAt: ctx.now, dismissed: false };
}

// One state change of one source. Only that source's attention is affected, except that
// a root's turn history and completion gate also consult its workers.
function transition(ctx, key, to, current) {
  const { state } = ctx;
  const source = state.sources[key];
  if (source.state === to) return;
  source.state = to;
  for (const episode of episodesOf(state, key)) {
    if (!episode.closed && episode.kind !== 'completion') closeEpisode(ctx, episode);
  }
  if (source.scope === 'root') {
    const turn = state.turns[key];
    const completion = turn ? state.episodes[turn.episodeId] : undefined;
    const live = completion !== undefined && !completion.closed;
    if (to === 'working') {
      // Genuine new activity ends the completed turn and its association.
      if (live) closeEpisode(ctx, completion);
      delete state.turns[key];
      return;
    }
    if (to === 'idle') return; // passive: the completed turn and its decisions stand
    if (to === 'needs-input' && live && completion.kind === 'completion') {
      // A late idle prompt for the same finished turn: same episode, same decisions.
      completion.kind = 'needs-input';
      return;
    }
    if (to === 'done') {
      if (live) closeEpisode(ctx, completion);
      delete state.turns[key];
      const blockers = blockersOf(key, current);
      if (blockers.length > 0) return withhold(ctx, key, blockers);
      const episode = openEpisode(ctx, key, 'completion');
      state.turns[key] = { episodeId: episode.id, observedAt: ctx.now };
      return;
    }
    // A new request supersedes the visible completion; the turn history remains.
    if (live) closeEpisode(ctx, completion);
  }
  if (REQUESTS.has(to)) openEpisode(ctx, key, to);
}

// Blockers that finished or vanished leave the diagnostic; a changed set is a new
// diagnostic (an old click cannot have dismissed it). No withheld completion is replayed.
function settleDiagnostics(ctx, current) {
  for (const diagnostic of Object.values(ctx.state.diagnostics)) {
    const remaining = diagnostic.blockers.filter((key) => current.has(key) && BLOCKING.has(current.get(key).row.state));
    if (remaining.length === diagnostic.blockers.length) continue;
    delete ctx.state.diagnostics[diagnostic.id];
    if (remaining.length === 0) continue;
    const id = diagnosticId(diagnostic.rootKey, remaining);
    ctx.state.diagnostics[id] = { id, rootKey: diagnostic.rootKey, blockers: remaining, observedAt: diagnostic.observedAt, dismissed: false };
  }
}

function validRow(row) {
  check(object(row) && text(row.id) && ['claude-code', 'codex', 'opencode'].includes(row.harness)
    && ['session', 'process', 'worker'].includes(row.scope) && STATES.includes(row.state) && integer(row.updatedAt)
    && (row.process === null || validHandle(row.process)) && (row.scope !== 'worker' || text(row.root)), 'invalid registry row');
}

function observe(state, input) {
  exactKeys(input, ['type', 'snapshot', 'envelope', 'now'], [], 'observe input');
  const { snapshot, envelope, now } = input;
  check(integer(now), 'observe.now is invalid');
  if (snapshot !== null) {
    check(object(snapshot) && text(snapshot.generation) && integer(snapshot.revision) && object(snapshot.agents), 'invalid registry snapshot');
    Object.values(snapshot.agents).forEach(validRow);
  }
  if (envelope !== null) {
    check(object(envelope) && object(envelope.registry) && (envelope.event === null || object(envelope.event)), 'invalid observer envelope');
  }
  const ctx = { state, now, result: { opened: [], closed: [], stale: false } };
  const recorded = state.registry;
  if (snapshot !== null && recorded?.generation === snapshot.generation && snapshot.revision < recorded.revision) {
    ctx.result.stale = true;
    return ctx.result;
  }
  // The first observation restores current requests as static attention: what happened
  // before familiar watched cannot be announced now.
  const initial = recorded === null;
  state.registry = snapshot === null ? { generation: null, revision: null }
    : { generation: snapshot.generation, revision: snapshot.revision };

  const rows = snapshot === null ? [] : Object.values(snapshot.agents);
  const keyed = rows.map((row) => [sourceKeyFor(state, snapshot.generation, row), row]);
  const keyOfAgent = new Map(keyed.map(([key, row]) => [row.id, key]));
  for (const key of Object.keys(state.sources)) if (!keyOfAgent.has(state.sources[key].agentId) || keyOfAgent.get(state.sources[key].agentId) !== key) endSource(ctx, key);

  const created = [];
  for (const [key, row] of keyed) {
    const rootKey = row.scope === 'worker' ? keyOfAgent.get(row.root) ?? null : key;
    if (!Object.hasOwn(state.sources, key)) {
      state.sources[key] = {
        agentId: row.id, harness: row.harness, scope: row.scope === 'worker' ? 'worker' : 'root', rootKey,
        generation: snapshot.generation, process: row.process, state: null, observedAt: row.updatedAt, frontier: snapshot.revision,
      };
      created.push(key);
    }
    state.sources[key].rootKey = rootKey;
    for (const episode of episodesOf(state, key)) episode.rootKey = rootKey;
  }
  const current = new Map(keyed.map(([key, row]) => [key, { row, source: state.sources[key] }]));

  // An envelope newer than what this source has seen carries a state the snapshot may
  // already have moved past; apply it first so that intervening activity is not lost.
  const event = envelope?.event;
  if (event && snapshot !== null && envelope.registry.generation === snapshot.generation) {
    const key = keyOfAgent.get(event.agentId);
    const source = key === undefined ? undefined : state.sources[key];
    const revision = envelope.registry.revision;
    if (source && !created.includes(key) && integer(revision) && revision > source.frontier && revision <= snapshot.revision) {
      const adapter = adapterFor(event.harness);
      const level = adapter.stateForEvent(event.nativeEvent);
      if (level !== null) {
        const background = event.background === undefined ? current.get(key).row.background : event.background ?? undefined;
        transition(ctx, key, adapter.reduceState(level, source.state, { background }), current);
      }
      source.frontier = revision;
    }
  }

  for (const [key, row] of keyed) {
    const source = state.sources[key];
    if (initial && created.includes(key)) {
      source.state = row.state;
      if (REQUESTS.has(row.state)) openEpisode(ctx, key, row.state, { restored: true });
    } else {
      transition(ctx, key, row.state, current);
    }
    source.observedAt = row.updatedAt;
    source.frontier = snapshot.revision;
  }
  settleDiagnostics(ctx, current);
  return ctx.result;
}

// --- desktop classification and dispositions -------------------------------------------

function desktop(state, input) {
  exactKeys(input, ['type', 'instanceId', 'status', 'dnd', 'workspaces', 'origins', 'enrichment', 'now'], ['seenIds'], 'desktop input');
  check(integer(input.now), 'desktop.now is invalid');
  const next = {
    instanceId: input.instanceId, status: input.status, dnd: input.dnd,
    workspaces: input.workspaces, origins: input.origins, enrichment: input.enrichment,
  };
  validDesktop(next, 'desktop input');
  const explicit = input.seenIds === undefined ? null : new Set(ids(input.seenIds, 'desktop.seenIds'));
  state.desktop = structuredClone(next);
  const focused = next.status === 'known' ? next.workspaces.find((workspace) => workspace.is_focused)?.id ?? null : null;
  const originOf = (episode) => episode.rootKey === null ? null : next.origins[episode.rootKey]?.workspaceId ?? null;
  const result = { seenIds: [], classifiedIds: [] };
  const see = (episode) => {
    if (episode.seen) return;
    episode.seen = true;
    result.seenIds.push(episode.id);
  };
  for (const episode of Object.values(state.episodes).sort((a, b) => a.order - b.order)) {
    if (episode.closed) continue;
    const origin = originOf(episode);
    const onFocused = focused !== null && origin === focused;
    const unclassified = episode.delivery.popup.status === 'pending' && episode.delivery.toast.status === 'pending';
    if (next.status === 'known' && unclassified) {
      result.classifiedIds.push(episode.id);
      if (onFocused) see(episode);
      if (next.dnd !== 'off' || episode.dismissed) {
        suppressQueued(episode);
        continue;
      }
      episode.delivery.popup = { status: 'eligible' };
      // A completion toasts only where it finished out of sight, on a known workspace.
      const toast = episode.kind !== 'completion' || (origin !== null && !onFocused);
      episode.delivery.toast = { status: toast ? 'eligible' : 'suppressed' };
    } else if (onFocused && (explicit === null || explicit.has(episode.id))) {
      see(episode);
    } else if (explicit?.has(episode.id)) {
      see(episode);
    }
    // Unknown or on: drop what has not started, durably. Nothing is held for later.
    if (next.dnd !== 'off') suppressQueued(episode);
  }
  return result;
}

function ids(value, where) {
  check(Array.isArray(value) && value.length <= MAX_IDS && value.every(bounded), `${where} must be at most ${MAX_IDS} IDs`);
  return [...new Set(value)];
}

function dismiss(state, input) {
  exactKeys(input, ['type', 'ids', 'now'], [], 'dismiss input');
  const result = { dismissedIds: [], missingIds: [] };
  for (const id of ids(input.ids, 'dismiss.ids')) {
    if (Object.hasOwn(state.episodes, id)) {
      const episode = state.episodes[id];
      episode.dismissed = true;
      suppressQueued(episode);
    } else if (Object.hasOwn(state.diagnostics, id)) {
      state.diagnostics[id].dismissed = true;
    } else {
      result.missingIds.push(id);
      continue;
    }
    result.dismissedIds.push(id);
  }
  return result;
}

// A popup consumer attaching: whatever it was shown at attachment is history to it.
function initialisePopup(state, input) {
  exactKeys(input, ['type', 'consumerId', 'ids', 'now'], [], 'initialise-popup input');
  check(bounded(input.consumerId), 'initialise-popup.consumerId is invalid');
  const result = { suppressedIds: [] };
  for (const id of ids(input.ids, 'initialise-popup.ids')) {
    if (!Object.hasOwn(state.episodes, id)) continue;
    const delivery = state.episodes[id].delivery;
    if (QUEUED.has(delivery.popup.status)) delivery.popup = { status: 'suppressed' };
    else if (delivery.popup.status === 'reserved' && delivery.popup.consumer !== input.consumerId) delivery.popup = { status: 'uncertain' };
    else continue;
    result.suppressedIds.push(id);
  }
  return result;
}

const byPriority = (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.order - b.order;

function claim(state, input) {
  exactKeys(input, ['type', 'surface', 'consumerId', 'token', 'now'], [], 'claim input');
  check(SURFACES.includes(input.surface), 'claim.surface is invalid');
  check(bounded(input.consumerId) && bounded(input.token), 'claim consumer or token is invalid');
  check(integer(input.now), 'claim.now is invalid');
  const none = { token: null, ids: [] };
  if (state.desktop.status !== 'known' || state.desktop.dnd !== 'off') return none;
  const eligible = Object.values(state.episodes)
    .filter((episode) => !episode.closed && !episode.dismissed && episode.delivery[input.surface].status === 'eligible')
    .sort(byPriority);
  // A popup plays one moment at a time; a toast pass summarises everything eligible.
  const chosen = input.surface === 'popup' ? eligible.slice(0, 1) : eligible;
  if (chosen.length === 0) return none;
  for (const episode of chosen) {
    episode.delivery[input.surface] = { status: 'reserved', token: input.token, consumer: input.consumerId, at: input.now };
  }
  return { token: input.token, ids: chosen.map((episode) => episode.id) };
}

function finish(state, input) {
  exactKeys(input, ['type', 'surface', 'token', 'outcome', 'now'], [], 'finish input');
  check(SURFACES.includes(input.surface) && bounded(input.token), 'finish surface or token is invalid');
  check(OUTCOMES.includes(input.outcome), 'finish.outcome is invalid');
  const finishedIds = [];
  for (const episode of Object.values(state.episodes)) {
    const delivery = episode.delivery[input.surface];
    if (delivery.status !== 'reserved' || delivery.token !== input.token) continue;
    episode.delivery[input.surface] = { status: input.outcome };
    finishedIds.push(episode.id);
  }
  return { finishedIds };
}

// A coordinator starting: another instance's sends may or may not have happened, and
// what was queued before it started is history. Nothing is replayed.
function recover(state, input) {
  exactKeys(input, ['type', 'instanceId', 'ids', 'now'], [], 'recover input');
  check(bounded(input.instanceId), 'recover.instanceId is invalid');
  const result = { uncertainIds: [], suppressedIds: [] };
  for (const episode of Object.values(state.episodes)) {
    const toast = episode.delivery.toast;
    if (toast.status === 'reserved' && toast.consumer !== input.instanceId) {
      episode.delivery.toast = { status: 'uncertain' };
      result.uncertainIds.push(episode.id);
    }
  }
  for (const id of ids(input.ids, 'recover.ids')) {
    if (!Object.hasOwn(state.episodes, id)) continue;
    const episode = state.episodes[id];
    if (!SURFACES.some((surface) => QUEUED.has(episode.delivery[surface].status))) continue;
    suppressQueued(episode);
    result.suppressedIds.push(id);
  }
  return result;
}

const HANDLERS = {
  observe, desktop, dismiss, 'initialise-popup': initialisePopup, claim, finish, recover,
};

function pruneClosed(state) {
  const referenced = new Set(Object.values(state.turns).map((turn) => turn.episodeId));
  const closedBySource = new Map();
  for (const episode of Object.values(state.episodes)) {
    if (!episode.closed || referenced.has(episode.id)) continue;
    const list = closedBySource.get(episode.sourceKey) ?? [];
    list.push(episode);
    closedBySource.set(episode.sourceKey, list);
  }
  for (const list of closedBySource.values()) {
    list.sort((a, b) => b.order - a.order);
    for (const episode of list.slice(CLOSED_KEPT)) delete state.episodes[episode.id];
  }
}

// The revision counts attention and control changes; observing a newer registry
// revision with nothing new to show is not one.
const content = (state) => JSON.stringify({
  ...state, revision: 0, registry: null,
  sources: Object.fromEntries(Object.entries(state.sources).map(([key, source]) => [key, { ...source, frontier: 0 }])),
});

export function reduceAttention(state, input) {
  const before = validateAttention(state);
  if (!object(input) || typeof input.type !== 'string' || !Object.hasOwn(HANDLERS, input.type)) fail('unknown attention input');
  const next = structuredClone(before);
  const result = HANDLERS[input.type](next, input);
  pruneClosed(next);
  if (content(next) !== content(before)) next.revision = before.revision + 1;
  return { state: validateAttention(next), result };
}
