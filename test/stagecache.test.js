// The render side of the task stage: the remembered task and the cache read. Everything runs
// against a temp state dir and temp source files, with a recording spawnRefresher and an
// injected clock; no subprocess starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FAILED_RETRY_MS, STAGE_CEILING_MS, readStage, sessionFilePath, taskForSession,
} from '../src/render/term/stagecache.js';
import { LOCK_STALE_MS, cachePaths, mtimeStamp } from '../src/render/term/stagerefresh.js';

const ID = 'fam-8f0f2b';
const A = '/w/a';
const B = '/w/b';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const SID = 'sess-1';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'stagecache-'));
  try {
    const stateDir = join(root, 'state');
    const tasksDir = join(root, 'tasks');
    const parkStore = join(root, 'park.toml');
    mkdirSync(tasksDir);
    writeFileSync(parkStore, 'x');
    const spawns = [];
    const spawnRefresher = (a) => spawns.push(a);
    return fn({ root, stateDir, tasksDir, parkStore, spawns, spawnRefresher });
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
}

function writeCache(stateDir, taskId, worktree, over = {}, atPath = worktree) {
  const { file } = cachePaths(stateDir, taskId, atPath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({
    taskId, worktree, tasksDir: null, tasksDirMtimeNs: null, parkStore: null, parkStoreMtimeNs: null,
    stage: 'review', fault: null, refreshedAt: new Date(NOW).toISOString(), ...over,
  }));
}

const fresh = (f, over = {}) => ({
  tasksDir: f.tasksDir, tasksDirMtimeNs: mtimeStamp(f.tasksDir),
  parkStore: f.parkStore, parkStoreMtimeNs: mtimeStamp(f.parkStore), ...over,
});

const read = (f, over = {}) => readStage({
  stateDir: f.stateDir, task: { id: ID, others: 0, worktree: A }, cwd: '/cwd', now: NOW,
  spawnRefresher: f.spawnRefresher, pidAlive: () => true, ...over,
});

const recall = (f, claim, warnings = []) => taskForSession({
  stateDir: f.stateDir, sessionId: SID, claim, now: NOW, warn: (m) => warnings.push(m),
});

test('a claimed task is remembered with its worktree', () => fixture((f) => {
  const claim = { id: ID, others: 1, worktree: A };
  assert.deepEqual(recall(f, claim), claim);
  const rec = JSON.parse(readFileSync(sessionFilePath(f.stateDir, SID), 'utf8'));
  assert.deepEqual(rec, { taskId: ID, worktree: A, seenAt: new Date(NOW).toISOString() });
}));

test('after release the remembered task is the line\'s task, with no +N', () => fixture((f) => {
  recall(f, { id: ID, others: 3, worktree: A });
  assert.deepEqual(recall(f, null), { id: ID, others: 0, worktree: A });
}));

test('a new claim replaces it', () => fixture((f) => {
  recall(f, { id: ID, others: 0, worktree: A });
  recall(f, { id: 'fam-aaaaaa', others: 0, worktree: A });
  assert.deepEqual(recall(f, null), { id: 'fam-aaaaaa', others: 0, worktree: A });
}));

test('the same id in a new worktree replaces it', () => fixture((f) => {
  recall(f, { id: ID, others: 0, worktree: A });
  recall(f, { id: ID, others: 0, worktree: B });
  assert.deepEqual(recall(f, null), { id: ID, others: 0, worktree: B });
}));

test('no remembered task and no claim is no task', () => fixture((f) => {
  assert.equal(recall(f, null), null);
}));

test('no session id writes nothing', () => fixture((f) => {
  const claim = { id: ID, others: 0, worktree: A };
  assert.equal(taskForSession({ stateDir: f.stateDir, sessionId: undefined, claim, now: NOW, warn: assert.fail }), claim);
  assert.equal(taskForSession({ stateDir: f.stateDir, sessionId: undefined, claim: null, now: NOW, warn: assert.fail }), null);
  assert.throws(() => readFileSync(join(f.stateDir, 'statusline')), { code: 'ENOENT' });
}));

test('an unwritable state dir still returns the claim and warns once', () => fixture((f) => {
  const blocked = join(f.root, 'blocked');
  mkdirSync(blocked);
  chmodSync(blocked, 0o500);
  const warnings = [];
  const claim = { id: ID, others: 0, worktree: A };
  const out = taskForSession({
    stateDir: join(blocked, 'state'), sessionId: SID, claim, now: NOW, warn: (m) => warnings.push(m),
  });
  assert.equal(out, claim);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session file/);
  chmodSync(blocked, 0o700);
}));

test('no cache renders — and starts one refresh', () => fixture((f) => {
  assert.deepEqual(read(f), { stage: '—', fault: null });
  assert.deepEqual(f.spawns, [{ taskId: ID, worktree: A, cwd: '/cwd' }]);
}));

test('a cache built for another worktree is never shown', () => fixture((f) => {
  writeCache(f.stateDir, ID, B, fresh(f, { stage: 'done' }), A);
  assert.deepEqual(read(f), { stage: '—', fault: null });
  assert.equal(f.spawns.length, 1);
}));

test('two worktrees of one task keep separate caches', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f, { stage: 'review' }));
  writeCache(f.stateDir, ID, B, fresh(f, { stage: 'done' }));
  for (let i = 0; i < 2; i += 1) {
    assert.equal(read(f).stage, 'review');
    assert.equal(read(f, { task: { id: ID, others: 0, worktree: B } }).stage, 'done');
  }
  assert.deepEqual(f.spawns, []);
}));

test('a fresh cache renders its stage and starts nothing', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f, { stage: 'review', fault: 'some fault' }));
  assert.deepEqual(read(f), { stage: 'review', fault: 'some fault' });
  assert.deepEqual(f.spawns, []);
}));

test('a failed refresh renders — without a stat, and retries after the back-off', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, { stage: '—', fault: 'tasks show: boom' });
  assert.deepEqual(read(f, { now: NOW + 29_000 }), { stage: '—', fault: 'tasks show: boom' });
  assert.deepEqual(f.spawns, []);
  assert.equal(FAILED_RETRY_MS, 30_000);
  read(f, { now: NOW + 31_000 });
  assert.equal(f.spawns.length, 1);
}));

test('a record write makes it stale but the cached stage still shows', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f));
  writeFileSync(join(f.tasksDir, 'x.md'), 'new');
  const later = new Date(NOW + 5000);
  utimesSync(f.tasksDir, later, later);
  assert.equal(read(f).stage, 'review');
  assert.equal(f.spawns.length, 1);
}));

test('a park saved after the stamp is picked up', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f));
  const later = new Date(NOW + 5000);
  writeFileSync(f.parkStore, 'parked');
  utimesSync(f.parkStore, later, later);
  assert.equal(read(f).stage, 'review');
  assert.equal(f.spawns.length, 1);
}));

test('a store appearing where none was stamped, and a stamped store vanishing, are changes', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f, { parkStore: join(f.root, 'later.toml'), parkStoreMtimeNs: null }));
  writeFileSync(join(f.root, 'later.toml'), 'x');
  read(f);
  assert.equal(f.spawns.length, 1);
  rmSync(f.parkStore);
  writeCache(f.stateDir, ID, A, { ...fresh(f), parkStoreMtimeNs: '123' });
  read(f);
  assert.equal(f.spawns.length, 2);
}));

test('past the ceiling it refreshes; a future refreshedAt is stale', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f));
  read(f, { now: NOW + STAGE_CEILING_MS - 1000 });
  assert.equal(f.spawns.length, 0);
  read(f, { now: NOW + STAGE_CEILING_MS + 1000 });
  assert.equal(f.spawns.length, 1);
  read(f, { now: NOW - 1000 });
  assert.equal(f.spawns.length, 2);
}));

test('a held lock starts nothing; a lock past LOCK_STALE_MS or with a dead pid does', () => fixture((f) => {
  const { lock } = cachePaths(f.stateDir, ID, A);
  mkdirSync(join(lock, '..'), { recursive: true });
  const take = (at, pid = 4242) => writeFileSync(lock, JSON.stringify({ pid, at: new Date(at).toISOString() }));
  take(NOW - 5000);
  read(f);
  assert.equal(f.spawns.length, 0);
  take(NOW - LOCK_STALE_MS - 1000);
  read(f);
  assert.equal(f.spawns.length, 1);
  take(NOW - 5000);
  read(f, { pidAlive: () => false });
  assert.equal(f.spawns.length, 2);
}));

const cacheFile = (f) => cachePaths(f.stateDir, ID, A).file;
const putRaw = (f, text) => {
  const file = cacheFile(f);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

test('a corrupt cache file renders — with a fault and starts a refresh', () => fixture((f) => {
  putRaw(f, '{');
  const out = read(f);
  assert.equal(out.stage, '—');
  assert.match(out.fault, /^stage cache .*: /);
  assert.equal(f.spawns.length, 1);
}));

test('a cache with an unparsable refreshedAt is corrupt, not ageless', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f, { refreshedAt: 'garbage' }));
  const out = read(f);
  assert.equal(out.stage, '—');
  assert.match(out.fault, /stage cache/);
  assert.equal(f.spawns.length, 1);
}));

test('a cache with a non-string stage is corrupt', () => fixture((f) => {
  writeCache(f.stateDir, ID, A, fresh(f, { stage: 7 }));
  const out = read(f);
  assert.equal(out.stage, '—');
  assert.match(out.fault, /stage cache/);
  assert.equal(f.spawns.length, 1);
}));

test('a stamp that cannot be read is a fault and a refresh, not a throw', () => fixture((f) => {
  // A source path under a regular file: stat answers ENOTDIR, not ENOENT.
  writeCache(f.stateDir, ID, A, fresh(f, { tasksDir: join(f.parkStore, 'sub') }));
  const out = read(f);
  assert.equal(out.stage, 'review');
  assert.match(out.fault, /sub/);
  assert.equal(f.spawns.length, 1);
}));

test('a lock that cannot be read is a fault and starts nothing', () => fixture((f) => {
  const { lock } = cachePaths(f.stateDir, ID, A);
  mkdirSync(lock, { recursive: true });   // reading a directory: EISDIR
  const out = read(f);
  assert.match(out.fault, /lock/);
  assert.equal(f.spawns.length, 0);
}));

test('a session file of the wrong shape warns and is no task', () => fixture((f) => {
  const path = sessionFilePath(f.stateDir, SID);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ taskId: 5, worktree: A }));
  const warnings = [];
  assert.equal(recall(f, null, warnings), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session file/);
}));

test('a session file whose taskId is not a task id warns and is no task', () => fixture((f) => {
  const path = sessionFilePath(f.stateDir, SID);
  mkdirSync(join(path, '..'), { recursive: true });
  for (const taskId of ['BAD_ID', '../../etc', 'fam-8f0f2', '']) {
    writeFileSync(path, JSON.stringify({ taskId, worktree: A, seenAt: new Date(NOW).toISOString() }));
    const warnings = [];
    assert.equal(recall(f, null, warnings), null, taskId);
    assert.equal(warnings.length, 1, taskId);
    assert.match(warnings[0], /session file .*not the \{ taskId, worktree, seenAt \} shape/);
  }
}));

test('a live claim whose id is not a task id is shown but never recorded', () => fixture((f) => {
  const claim = { id: 'BAD_ID', others: 0, worktree: A };
  assert.deepEqual(recall(f, claim), claim);
  assert.throws(() => readFileSync(sessionFilePath(f.stateDir, SID)), { code: 'ENOENT' });
}));

test('a task whose id is not a task id is a fault naming it, and starts nothing', () => fixture((f) => {
  for (const id of ['BAD_ID', '../x', '']) {
    const out = read(f, { task: { id, others: 0, worktree: A } });
    assert.equal(out.stage, '—');
    assert.ok(out.fault.includes(JSON.stringify(id)), out.fault);
  }
  const out = read(f, { task: { id: ID, others: 0, worktree: '' } });
  assert.deepEqual([out.stage, /not a worktree path/.test(out.fault)], ['—', true]);
  assert.equal(f.spawns.length, 0);
}));
