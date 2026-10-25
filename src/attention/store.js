// Where attention lives on disk. Episode and control writers share the presentation lock
// and one atomic replacement; the coordinator heartbeat is a separate file that takes no
// lock and never touches the attention revision, so a held lock cannot fake a dead
// coordinator and a heartbeat cannot wake a projection.
import { readFile } from 'node:fs/promises';
import { createProcessOps } from 'relay';
import { initialAttention, validateAttention } from './model.js';
import { writeJsonAtomic } from '../bus/store.js';
import { withLock } from '../bus/lock.js';

// Older than this, a heartbeat no longer vouches for its coordinator.
export const HEALTH_STALE_MS = 10_000;
export const HEALTH_SCHEMA = 2;
// Crashes older than this no longer count; the record keeps at most this many.
export const CRASH_WINDOW_MS = 600_000;
export const CRASH_HISTORY_MAX = 8;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const sameKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readAttention(paths) {
  const contents = await readText(paths.attentionPath);
  if (contents === null) return initialAttention();
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`attention: corrupt attention state at ${paths.attentionPath}: ${error.message}`);
  }
  return validateAttention(value);
}

// One transaction: read, change, validate, and replace the file only if a byte moved.
// The lock is taken once here; `fn` must not take it again.
export async function mutateAttention({ paths, lockWith = withLock }, fn) {
  return lockWith(paths.presentationLockPath, async () => {
    const before = await readAttention(paths);
    const { state, result } = await fn(structuredClone(before));
    const next = validateAttention(state);
    if (JSON.stringify(next) !== JSON.stringify(before)) await writeJsonAtomic(paths.attentionPath, next);
    return { state: next, result };
  });
}

export function validHealth(value) {
  return sameKeys(value, ['schema', 'instanceId', 'epoch', 'owner', 'writtenAt', 'stopped', 'crashedAt'])
    && value.schema === HEALTH_SCHEMA
    && text(value.instanceId) && value.instanceId.length <= 128
    && sameKeys(value.epoch, ['bootId', 'desktopSession'])
    && (value.epoch.bootId === null || text(value.epoch.bootId))
    && (value.epoch.desktopSession === null || text(value.epoch.desktopSession))
    && sameKeys(value.owner, ['pid', 'start']) && Number.isSafeInteger(value.owner.pid) && value.owner.pid > 0
    && typeof value.owner.start === 'string' && /^(0|[1-9][0-9]*)$/.test(value.owner.start)
    && integer(value.writtenAt) && typeof value.stopped === 'boolean'
    && Array.isArray(value.crashedAt) && value.crashedAt.length <= CRASH_HISTORY_MAX
    && value.crashedAt.every((at, i) => integer(at) && at <= value.writtenAt && at >= value.writtenAt - CRASH_WINDOW_MS
      && (i === 0 || at >= value.crashedAt[i - 1]));
}

// The one health rule every consumer applies. A live identity that cannot be read is
// unknown: it never matches a saved identity, null or otherwise.
export function healthStatus(health, { now, instanceId, bootId, desktopSession }) {
  if (health === null || health === undefined) return 'missing';
  if (!validHealth(health) || health.writtenAt > now) return 'invalid';
  if (!text(bootId) || !text(desktopSession) || health.epoch.bootId !== bootId
    || health.epoch.desktopSession !== desktopSession
    || (instanceId !== undefined && health.instanceId !== instanceId)) return 'mismatched';
  return now - health.writtenAt > HEALTH_STALE_MS ? 'stale' : 'healthy';
}

export async function writeHealth({ paths, health, writeAtomic = writeJsonAtomic }) {
  if (!validHealth(health)) throw new Error('attention: invalid health record');
  await writeAtomic(paths.attentionHealthPath, health);
}

// This boot and this desktop session, read live rather than trusted from any file.
export function currentEpoch({ env = process.env, processOps = createProcessOps() } = {}) {
  let bootId = null;
  try {
    bootId = processOps.handleOf(process.pid).bootId ?? null;
  } catch {
    bootId = null;
  }
  return { bootId, desktopSession: text(env.NIRI_SOCKET) ? env.NIRI_SOCKET : null };
}

// Against the one clock reading that becomes `writtenAt`: nothing later than it or older
// than the window, ascending, the newest few. A backward clock step therefore never
// makes the writer's own record invalid.
export function normaliseCrashes(list, now) {
  return list.filter((at) => at <= now && at >= now - CRASH_WINDOW_MS)
    .sort((a, b) => a - b).slice(-CRASH_HISTORY_MAX);
}

// What a starting coordinator inherits from the record its predecessor left. Only a
// valid record of this boot and desktop session counts, and an unknown live identity
// never matches; a predecessor that did not stop cleanly adds its own end, its last
// `writtenAt`. A record that could not be read or validated is `unusable`.
export function carriedCrashes(previous, live) {
  if (previous === null) return { crashedAt: [], unusable: false };
  if (previous === undefined || !validHealth(previous)) return { crashedAt: [], unusable: true };
  if (!text(live.bootId) || !text(live.desktopSession) || previous.epoch.bootId !== live.bootId
    || previous.epoch.desktopSession !== live.desktopSession) return { crashedAt: [], unusable: false };
  return { crashedAt: previous.stopped ? [...previous.crashedAt] : [...previous.crashedAt, previous.writtenAt], unusable: false };
}

// The saved health record as parsed JSON: `null` when there is none, `undefined` when it
// cannot be read or parsed (a parsed `null` included, which is no record). Never throws.
export async function readHealthRecord(paths) {
  let contents;
  try {
    contents = await readFile(paths.attentionHealthPath, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined;
  }
  try {
    return JSON.parse(contents) ?? undefined;
  } catch {
    return undefined;
  }
}

async function readHealth(paths) {
  const contents = await readText(paths.attentionHealthPath);
  if (contents === null) return { record: null, valid: true };
  try {
    const record = JSON.parse(contents);
    return { record, valid: validHealth(record) };
  } catch {
    return { record: null, valid: false };
  }
}

// The complete saved state plus independently read health. No lock: a reader must see
// a dead coordinator even while some writer holds the presentation lock.
export async function readAttentionView({ paths, now = Date.now(), liveEpoch = () => currentEpoch() }) {
  const state = await readAttention(paths);
  const { record, valid } = await readHealth(paths);
  const live = liveEpoch();
  const status = valid ? healthStatus(record, {
    now, ...(state.desktop.instanceId === null ? {} : { instanceId: state.desktop.instanceId }),
    bootId: live.bootId, desktopSession: live.desktopSession,
  }) : 'invalid';
  return { ...state, health: { status, record: valid ? record : null } };
}
