import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialAttention, reduceAttention } from '../src/attention/model.js';
import {
  carriedCrashes, healthStatus, mutateAttention, normaliseCrashes, readAttention, readAttentionView,
  readHealthRecord, writeHealth,
} from '../src/attention/store.js';
import { paths as familiarPaths } from '../src/bus/paths.js';
import { withLock } from '../src/bus/lock.js';
import { createRegistry, nativeEvent, snapshotOf } from './helpers/attention.js';

const BOOT = '11111111-1111-4111-8111-111111111111';
const SOCKET = '/run/user/1000/niri.wayland-1.sock';
const epoch = { bootId: BOOT, desktopSession: SOCKET };
const health = (extra = {}) => ({
  schema: 2, instanceId: 'coordinator-1', epoch, owner: { pid: 77, start: '123' }, writtenAt: 50_000,
  stopped: false, crashedAt: [], ...extra,
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-attention-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, paths: familiarPaths({ HOME: dir, FAMILIAR_STATE_DIR: join(dir, 'state'), FAMILIAR_CONFIG_DIR: join(dir, 'config') }) };
}

// One request observed through the production reducer and saved through the store.
async function saveRequest(paths) {
  const registry = createRegistry();
  registry.apply(nativeEvent('codex', 'PermissionRequest', { session: 'root' }));
  await mutateAttention({ paths }, async (state) => reduceAttention(state, {
    type: 'observe', snapshot: snapshotOf([], { revision: 1 }), envelope: null, now: 1,
  }));
  return mutateAttention({ paths }, async (state) => reduceAttention(state, {
    type: 'observe', snapshot: snapshotOf(registry.rows(), { revision: 2 }), envelope: null, now: 2,
  }));
}

test('a missing attention file reads as the initial state and writes nothing', async (t) => {
  const { paths } = await fixture(t);
  assert.deepEqual(await readAttention(paths), initialAttention());
  await mutateAttention({ paths }, async (state) => ({ state, result: null }));
  await assert.rejects(stat(paths.attentionPath), { code: 'ENOENT' });
});

test('a corrupt or truncated file is an error and is never overwritten', async (t) => {
  const { paths } = await fixture(t);
  await saveRequest(paths);
  const whole = await readFile(paths.attentionPath, 'utf8');
  for (const bytes of [whole.slice(0, whole.length / 2), '{"schema":1}', 'not json']) {
    await writeFile(paths.attentionPath, bytes);
    const previousBytes = await readFile(paths.attentionPath, 'utf8');
    await assert.rejects(readAttention(paths), /attention/);
    await assert.rejects(mutateAttention({ paths }, async (state) => reduceAttention(state, { type: 'dismiss', ids: ['e1'], now: 3 })), /attention/);
    const bytesAfterRejectedCorruptMutation = await readFile(paths.attentionPath, 'utf8');
    assert.deepEqual(previousBytes, bytesAfterRejectedCorruptMutation);
  }
});

test('a mutation producing an invalid state is rejected without a write', async (t) => {
  const { paths } = await fixture(t);
  await saveRequest(paths);
  const before = await readFile(paths.attentionPath, 'utf8');
  await assert.rejects(mutateAttention({ paths }, async (state) => ({ state: { ...state, schema: 9 }, result: null })),
    { name: 'AttentionSchemaError' });
  assert.equal(await readFile(paths.attentionPath, 'utf8'), before);
});

test('an unchanged mutation leaves the file untouched', async (t) => {
  const { paths } = await fixture(t);
  await saveRequest(paths);
  const before = await stat(paths.attentionPath);
  await mutateAttention({ paths }, async (state) => reduceAttention(state, { type: 'dismiss', ids: ['e999'], now: 9 }));
  const after = await stat(paths.attentionPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('competing dismiss, capture and reservation mutations all land', async (t) => {
  const { paths } = await fixture(t);
  const { state } = await saveRequest(paths);
  const [id] = Object.keys(state.episodes);
  await mutateAttention({ paths }, async (s) => reduceAttention(s, {
    type: 'desktop', instanceId: 'coordinator-1', status: 'known', dnd: 'off',
    workspaces: [{ id: '1', idx: 1, is_active: true, is_focused: true, is_urgent: false, occupied: true }],
    origins: {}, enrichment: {}, now: 3,
  }));
  const registry = createRegistry();
  registry.apply(nativeEvent('codex', 'PermissionRequest', { session: 'root' }));
  registry.apply(nativeEvent('codex', 'PermissionRequest', { session: 'other' }));
  await Promise.all([
    mutateAttention({ paths }, async (s) => reduceAttention(s, { type: 'dismiss', ids: [id], now: 4 })),
    mutateAttention({ paths }, async (s) => reduceAttention(s, {
      type: 'observe', snapshot: snapshotOf(registry.rows(), { revision: 3 }), envelope: null, now: 4,
    })),
    mutateAttention({ paths }, async (s) => reduceAttention(s, { type: 'claim', surface: 'toast', consumerId: 'coordinator-1', token: 'tok', now: 4 })),
  ]);
  const saved = await readAttention(paths);
  assert.equal(saved.episodes[id].dismissed, true);
  assert.equal(Object.values(saved.episodes).length, 2);
});

test('readers racing atomic replacement always parse a complete state', async (t) => {
  const { paths } = await fixture(t);
  await saveRequest(paths);
  let writing = true;
  const writer = (async () => {
    for (let i = 0; i < 40; i++) {
      await mutateAttention({ paths }, async (s) => reduceAttention(s, { type: 'dismiss', ids: [`x${i}`, 'e1'], now: 10 + i }));
      await mutateAttention({ paths }, async (s) => ({ state: { ...s, revision: s.revision + 1 }, result: null }));
    }
    writing = false;
  })();
  let reads = 0;
  while (writing) {
    await readAttention(paths);
    reads += 1;
  }
  await writer;
  assert.ok(reads > 0);
});

test('a registry reset and an idempotent reconcile are stored once', async (t) => {
  const { paths } = await fixture(t);
  await saveRequest(paths);
  const registry = createRegistry();
  registry.apply(nativeEvent('codex', 'PermissionRequest', { session: 'root' }));
  const reset = { type: 'observe', snapshot: snapshotOf(registry.rows(), { generation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revision: 1 }), envelope: null, now: 5 };
  await mutateAttention({ paths }, async (s) => reduceAttention(s, reset));
  const once = await readFile(paths.attentionPath, 'utf8');
  await mutateAttention({ paths }, async (s) => reduceAttention(s, { ...reset, now: 6 }));
  assert.equal(await readFile(paths.attentionPath, 'utf8'), once);
  assert.equal(Object.values(JSON.parse(once).sources)[0].generation, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
});

// --- health ---------------------------------------------------------------------------

test('healthStatus distinguishes healthy, missing, stale, invalid and mismatched heartbeats', () => {
  const live = { now: 55_000, instanceId: 'coordinator-1', ...epoch };
  assert.equal(healthStatus(health(), live), 'healthy');
  assert.equal(healthStatus(null, live), 'missing');
  assert.equal(healthStatus(health(), { ...live, now: 60_000 }), 'healthy');
  assert.equal(healthStatus(health(), { ...live, now: 60_001 }), 'stale');
  assert.equal(healthStatus(health({ writtenAt: 55_001 }), live), 'invalid');
  assert.equal(healthStatus({ ...health(), schema: 3 }, live), 'invalid');
  assert.equal(healthStatus({ ...health(), extra: 1 }, live), 'invalid');
  assert.equal(healthStatus(health(), { ...live, instanceId: 'coordinator-2' }), 'mismatched');
  assert.equal(healthStatus(health(), { ...live, bootId: '22222222-2222-4222-8222-222222222222' }), 'mismatched');
  assert.equal(healthStatus(health(), { ...live, desktopSession: '/other.sock' }), 'mismatched');
  // A live identity that cannot be read is unknown, never a match to a saved one.
  assert.equal(healthStatus(health(), { ...live, bootId: null }), 'mismatched');
  assert.equal(healthStatus(health({ epoch: { bootId: BOOT, desktopSession: null } }), { ...live, desktopSession: null }), 'mismatched');
  assert.equal(healthStatus(health(), { now: 55_000, ...epoch }), 'healthy');
});

test('schema-2 health validity: keys, stopped, crashedAt bounds and order', () => {
  const live = { now: 55_000, instanceId: 'coordinator-1', ...epoch };
  const W = 700_000;
  const at = (extra) => healthStatus(health({ writtenAt: W, ...extra }), { ...live, now: W });
  assert.equal(healthStatus(health({ schema: 1 }), live), 'invalid');
  const { stopped, ...noStopped } = health();
  assert.equal(healthStatus(noStopped, live), 'invalid');
  assert.equal(at({ stopped: 'no' }), 'invalid');
  assert.equal(at({ crashedAt: Array.from({ length: 9 }, () => W) }), 'invalid');
  assert.equal(at({ crashedAt: [W - 4, W - 5] }), 'invalid');
  assert.equal(at({ crashedAt: [W + 1] }), 'invalid');
  assert.equal(at({ crashedAt: [W - 600_001] }), 'invalid');
  assert.equal(at({ crashedAt: [W - 1.5] }), 'invalid');
  assert.equal(healthStatus(health({ writtenAt: 5, crashedAt: [-1] }), { ...live, now: 5 }), 'invalid');
  assert.equal(at({ crashedAt: [W - 600_000, W] }), 'healthy');
  assert.equal(at({ stopped: true }), 'healthy');
});

test('a heartbeat write takes no presentation lock and changes no attention revision', async (t) => {
  const { paths } = await fixture(t);
  await saveRequest(paths);
  const before = await readFile(paths.attentionPath, 'utf8');
  let heartbeatWriteTookPresentationLock = true;
  await withLock(paths.presentationLockPath, async () => {
    await writeHealth({ paths, health: health() });
    heartbeatWriteTookPresentationLock = false;
  });
  assert.equal(heartbeatWriteTookPresentationLock, false);
  assert.deepEqual(JSON.parse(await readFile(paths.attentionHealthPath, 'utf8')), health());
  assert.equal(await readFile(paths.attentionPath, 'utf8'), before);
  await assert.rejects(writeHealth({ paths, health: { ...health(), writtenAt: -1 } }), /health/);
});

test('the view is the saved state plus independently read health, read while the lock is held', async (t) => {
  const { paths } = await fixture(t);
  const { state } = await saveRequest(paths);
  await mkdir(paths.stateDir, { recursive: true });
  const liveEpoch = () => epoch;
  const missing = await readAttentionView({ paths, now: 55_000, liveEpoch });
  assert.deepEqual({ ...missing, health: undefined }, { ...state, health: undefined });
  assert.deepEqual(missing.health, { status: 'missing', record: null });
  await writeHealth({ paths, health: health() });
  const view = await withLock(paths.presentationLockPath, () => readAttentionView({ paths, now: 55_000, liveEpoch }));
  assert.deepEqual(view.health, { status: 'healthy', record: health() });
  await writeFile(paths.attentionHealthPath, '{"schema":');
  assert.equal((await readAttentionView({ paths, now: 55_000, liveEpoch })).health.status, 'invalid');
  await writeHealth({ paths, health: health() });
  assert.equal((await readAttentionView({ paths, now: 55_000, liveEpoch: () => ({ ...epoch, bootId: '33333333-3333-4333-8333-333333333333' }) })).health.status, 'mismatched');
});

test('the view compares the coordinator that classified the saved state', async (t) => {
  const { paths } = await fixture(t);
  await saveRequest(paths);
  await mutateAttention({ paths }, async (s) => reduceAttention(s, {
    type: 'desktop', instanceId: 'coordinator-1', status: 'known', dnd: 'off', workspaces: [], origins: {}, enrichment: {}, now: 3,
  }));
  await writeHealth({ paths, health: health({ instanceId: 'coordinator-2' }) });
  const view = await readAttentionView({ paths, now: 55_000, liveEpoch: () => epoch });
  assert.equal(view.health.status, 'mismatched');
});


test('crash history normalises against one clock reading', () => {
  const now = 1_000_000;
  assert.deepEqual(normaliseCrashes([now - 600_000, now], now), [now - 600_000, now]);
  assert.deepEqual(normaliseCrashes([now + 1, now - 600_001, now - 5], now), [now - 5]);
  assert.deepEqual(normaliseCrashes([3, 1, 2], 10), [1, 2, 3]);
});

test('the history keeps the newest eight', () => {
  const now = 1_000_000;
  const ten = Array.from({ length: 10 }, (_, i) => now - 10 + i);
  assert.deepEqual(normaliseCrashes(ten, now), ten.slice(2));
});

test('a predecessor contributes its history only when valid and of the live epoch', () => {
  const W = 700_000;
  const live = epoch;
  const empty = { crashedAt: [], unusable: false };
  const unusable = { crashedAt: [], unusable: true };
  assert.deepEqual(carriedCrashes(null, live), empty);
  assert.deepEqual(carriedCrashes(undefined, live), unusable);
  const { stopped, crashedAt, ...schemaOne } = health({ schema: 1 });
  assert.deepEqual(carriedCrashes(schemaOne, live), unusable);
  assert.deepEqual(carriedCrashes(health({ writtenAt: W, crashedAt: [W - 4, W - 5] }), live), unusable);
  assert.deepEqual(carriedCrashes(health({ crashedAt: 'none' }), { ...live, bootId: null }), unusable);
  for (const other of [{ bootId: null }, { desktopSession: null }, { bootId: '33333333-3333-4333-8333-333333333333' },
    { desktopSession: '/other.sock' }]) {
    assert.deepEqual(carriedCrashes(health({ writtenAt: W, crashedAt: [W - 5] }), { ...live, ...other }), empty);
  }
  assert.deepEqual(carriedCrashes(health({ epoch: { bootId: null, desktopSession: SOCKET } }), { ...live, bootId: null }), empty);
  assert.deepEqual(carriedCrashes(health({ writtenAt: W, crashedAt: [W - 5] }), live), { crashedAt: [W - 5, W], unusable: false });
  assert.deepEqual(carriedCrashes(health({ writtenAt: W, stopped: true, crashedAt: [W - 5] }), live), { crashedAt: [W - 5], unusable: false });
});

test('a health record that cannot be read is unusable, a missing one is null, and neither throws', async (t) => {
  const { paths } = await fixture(t);
  assert.equal(await readHealthRecord(paths), null);
  await mkdir(paths.stateDir, { recursive: true });
  await writeHealth({ paths, health: health() });
  assert.deepEqual(await readHealthRecord(paths), health());
  await writeFile(paths.attentionHealthPath, '{"schema":');
  assert.equal(await readHealthRecord(paths), undefined);
  await writeFile(paths.attentionHealthPath, 'null');
  assert.equal(await readHealthRecord(paths), undefined);
  await rm(paths.attentionHealthPath);
  await mkdir(paths.attentionHealthPath);
  assert.equal(await readHealthRecord(paths), undefined);
});
