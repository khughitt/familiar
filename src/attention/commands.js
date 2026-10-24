// The three attention leaves: `status` reads, `dismiss` acts on explicit IDs, and
// `popup` serves one control request from a popup consumer. None renders anything or
// talks to the compositor; each answers with one JSON value whatever the output mode.
import { randomUUID } from 'node:crypto';
import { reduceAttention } from './model.js';
import { currentEpoch, healthStatus, mutateAttention, readAttentionView } from './store.js';
import { readJson } from '../bus/store.js';
import { withLock } from '../bus/lock.js';

const MAX_REQUEST_BYTES = 65_536;
const MAX_TEXT = 128;
const MAX_IDS = 512;
const OUTCOMES = ['delivered', 'failed', 'suppressed', 'interrupted'];
const REQUESTS = {
  initialise: ['op', 'consumerId', 'ids'],
  claim: ['op', 'consumerId'],
  finish: ['op', 'consumerId', 'token', 'outcome'],
};

// Errors name the field and its limit, never the value: a request may carry anything.
const invalid = (message) => new Error(`attention: popup: ${message}`);
const bounded = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;

export function parsePopupRequest(text) {
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw invalid(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
  if (text.trim() === '') throw invalid('empty request (expected one JSON object on stdin)');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('request is not one JSON value');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('request must be a JSON object');
  if (!Object.hasOwn(REQUESTS, value.op)) throw invalid('op: unknown operation');
  const keys = REQUESTS[value.op];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid(`${value.op} request has an unknown field`);
  if (!bounded(value.consumerId)) throw invalid(`consumerId must be a nonempty string of at most ${MAX_TEXT} characters`);
  if (value.op === 'initialise' && !(Array.isArray(value.ids) && value.ids.length <= MAX_IDS && value.ids.every(bounded))) {
    throw invalid(`ids must be an array of at most ${MAX_IDS} nonempty strings of at most ${MAX_TEXT} characters`);
  }
  if (value.op === 'finish') {
    if (!bounded(value.token)) throw invalid(`token must be a nonempty string of at most ${MAX_TEXT} characters`);
    if (!OUTCOMES.includes(value.outcome)) throw invalid(`outcome must be one of ${OUTCOMES.join(', ')}`);
  }
  return value;
}

// What a popup needs to play one episode. The pose follows the episode's own kind and
// never the root's current (possibly folded or expired) presentation state.
function jobFor(state, id, seen) {
  const episode = state.episodes[id];
  const origin = episode.rootKey === null ? undefined : state.desktop.origins[episode.rootKey];
  const workspace = origin && state.desktop.workspaces.find((row) => row.id === origin.workspaceId);
  return {
    episodeId: id, rootKey: episode.rootKey, kind: episode.kind,
    pose: episode.kind === 'completion' ? 'done' : episode.kind, seen,
    origin: origin ? { workspaceId: origin.workspaceId, label: workspace?.name ?? String(workspace?.idx ?? origin.workspaceId), output: origin.output } : null,
    presentation: state.desktop.enrichment[id] ?? null,
  };
}

async function healthy(paths, state, now, liveEpoch) {
  let record;
  try {
    record = await readJson(paths.attentionHealthPath);
  } catch {
    return false;
  }
  const live = liveEpoch();
  return state.desktop.instanceId !== null && healthStatus(record, {
    now, instanceId: state.desktop.instanceId, bootId: live.bootId, desktopSession: live.desktopSession,
  }) === 'healthy';
}

async function servePopup(request, { paths, now, lockWith, liveEpoch }) {
  const at = now();
  const { result } = await mutateAttention({ paths, lockWith }, async (state) => {
    if (request.op === 'initialise') {
      const out = reduceAttention(state, { type: 'initialise-popup', consumerId: request.consumerId, ids: request.ids, now: at });
      return { state: out.state, result: { suppressedIds: out.result.suppressedIds } };
    }
    if (request.op === 'finish') {
      const out = reduceAttention(state, { type: 'finish', surface: 'popup', token: request.token, outcome: request.outcome, now: at });
      return { state: out.state, result: { finishedIds: out.result.finishedIds } };
    }
    // The decision is made here, under the lock: current episode, DND and health.
    if (!await healthy(paths, state, at, liveEpoch)) return { state, result: { token: null, job: null } };
    const token = randomUUID();
    const out = reduceAttention(state, { type: 'claim', surface: 'popup', consumerId: request.consumerId, token, now: at });
    if (out.result.token === null) return { state, result: { token: null, job: null } };
    const [id] = out.result.ids;
    return { state: out.state, result: { token, job: jobFor(out.state, id, state.episodes[id].seen) } };
  });
  return result;
}

export async function runAttentionCommand(command, argv, {
  paths, stdin, stdout, now = Date.now, lockWith = withLock, liveEpoch = () => currentEpoch(),
}) {
  const write = (value) => stdout.write(`${JSON.stringify(value)}\n`);
  if (command === 'attention status') return write(await readAttentionView({ paths, now: now(), liveEpoch }));
  if (command === 'attention dismiss') {
    const { result } = await mutateAttention({ paths, lockWith }, async (state) => reduceAttention(state, { type: 'dismiss', ids: argv, now: now() }));
    return write(result);
  }
  if (command === 'attention popup') return write(await servePopup(parsePopupRequest(await stdin()), { paths, now, lockWith, liveEpoch }));
  throw new Error(`attention: unknown command ${JSON.stringify(command)}`);
}
