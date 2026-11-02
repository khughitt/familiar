// The render side of the status line's task stage: remember the session's last task after its
// claim is released, read the per-(task, worktree) cache the detached refresher wrote, and
// spawn that refresher when the cache is stale. Everything here is synchronous and on the
// render path: file reads, two stats, and at most one detached spawn.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ABSENT } from './hud.js';
import { ledgerName } from './ledger.js';
import { REFRESHER_PATH, TASK_ID, cachePaths, lockHeld, mtimeStamp } from './stagerefresh.js';

export const STAGE_CEILING_MS = 600_000;
export const FAILED_RETRY_MS = 30_000;

export const sessionFilePath = (stateDir, sessionId) =>
  join(stateDir, 'statusline', `${ledgerName(sessionId)}.json`);

function readJsonOrNull(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

function writeSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch { /* never created, or already gone */ }
    throw error;
  }
}

const isTaskId = (value) => typeof value === 'string' && TASK_ID.test(value);

// The task the line shows: the live claim (recorded when it changed), else the one recorded.
// Only a canonical task id is recorded or read back; a live claim with another id is still
// shown, and readStage reports it as a fault.
export function taskForSession({ stateDir, sessionId, claim, now, warn }) {
  if (!sessionId) return claim;
  const path = sessionFilePath(stateDir, sessionId);
  let recorded = null;
  try {
    recorded = readJsonOrNull(path);
  } catch (error) {
    warn(`session file ${path}: ${error.message}`);
  }
  const valid = recorded !== null && typeof recorded === 'object'
    && isTaskId(recorded.taskId) && typeof recorded.worktree === 'string';
  if (recorded !== null && !valid) warn(`session file ${path}: not the { taskId, worktree, seenAt } shape`);
  if (!claim) return valid ? { id: recorded.taskId, others: 0, worktree: recorded.worktree } : null;
  if (isTaskId(claim.id) && (!valid || recorded.taskId !== claim.id || recorded.worktree !== claim.worktree)) {
    try {
      writeSync(path, { taskId: claim.id, worktree: claim.worktree, seenAt: new Date(now).toISOString() });
    } catch (error) {
      warn(`session file ${path}: ${error.message}`);
    }
  }
  return claim;
}

function defaultSpawnRefresher({ taskId, worktree, cwd }) {
  spawn(process.execPath, [REFRESHER_PATH, taskId, worktree, cwd], { detached: true, stdio: 'ignore' }).unref();
}

const outOfWindow = (age, limit) => age < 0 || age > limit;

// A cache the render cannot trust is a fault, never a throw: the refresher is what repairs it.
function loadCache(file) {
  let cache;
  try {
    cache = readJsonOrNull(file);
  } catch (error) {
    return { corrupt: `stage cache ${file}: ${error.message}` };
  }
  if (cache === null) return { cache: null };
  // `fault` reaches stderr through a string replace, so anything but null or a string is corrupt.
  const shaped = typeof cache === 'object' && typeof cache.stage === 'string'
    && (cache.fault === null || typeof cache.fault === 'string')
    && typeof cache.refreshedAt === 'string' && Number.isFinite(Date.parse(cache.refreshedAt));
  return shaped ? { cache } : { corrupt: `stage cache ${file}: not the cache shape` };
}

export function readStage({ stateDir, task, cwd, now, spawnRefresher = defaultSpawnRefresher, pidAlive }) {
  let file;
  let lock;
  try {
    ({ file, lock } = cachePaths(stateDir, task.id, task.worktree));
  } catch (error) {
    // A claim id that is not a task id has no cache and nothing a refresher could ask tasks.
    return { stage: ABSENT, fault: error.message };
  }
  const { cache, corrupt } = loadCache(file);
  let result;
  let stale;
  if (corrupt) {
    result = { stage: ABSENT, fault: corrupt };
    stale = true;
  } else if (cache === null || cache.worktree !== task.worktree) {
    result = { stage: ABSENT, fault: null };
    stale = true;
  } else {
    result = { stage: cache.stage, fault: cache.fault };
    const age = now - Date.parse(cache.refreshedAt);
    if (cache.tasksDir === null) {
      stale = outOfWindow(age, FAILED_RETRY_MS);
    } else {
      stale = outOfWindow(age, STAGE_CEILING_MS);
      for (const [path, stamp] of [[cache.tasksDir, cache.tasksDirMtimeNs], [cache.parkStore, cache.parkStoreMtimeNs]]) {
        try {
          stale = mtimeStamp(path) !== stamp || stale;
        } catch (error) {
          result = { stage: cache.stage, fault: `stage cache stamp ${path}: ${error.message}` };
          stale = true;
        }
      }
    }
  }
  if (!stale) return result;
  let held;
  try {
    held = lockHeld(lock, now, pidAlive);
  } catch (error) {
    return { ...result, fault: `stage cache lock ${lock}: ${error.message}` };
  }
  if (!held) spawnRefresher({ taskId: task.id, worktree: task.worktree, cwd });
  return result;
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function removeIfPresent(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// The cache file a session file names, or null when it names none (it does not parse, or is
// not the { taskId, worktree } shape the render would show).
function namedCache(stateDir, path) {
  let recorded;
  try {
    recorded = readJsonOrNull(path);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof recorded?.taskId !== 'string' || typeof recorded.worktree !== 'string') return null;
  try {
    return cachePaths(stateDir, recorded.taskId, recorded.worktree).file;
  } catch {
    return null;
  }
}

// `familiar reap`'s share. A session file goes once its session is not among `sessionIds` (the
// bus's sessions). A cache goes once it is past STAGE_CEILING_MS and no remaining session file
// names it, together with its lock, unless a live refresher holds that lock. Returns the
// number of files removed.
export function pruneStatusline({ stateDir, sessionIds, now, pidAlive }) {
  const dir = join(stateDir, 'statusline');
  const live = new Set(sessionIds.map(ledgerName));
  const named = new Set();
  let removed = 0;
  for (const name of listDir(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    if (!live.has(name.slice(0, -'.json'.length))) {
      if (removeIfPresent(path)) removed += 1;
      continue;
    }
    const file = namedCache(stateDir, path);
    if (file !== null) named.add(file);
  }

  const tasksDir = join(dir, 'tasks');
  const stems = new Set(listDir(tasksDir)
    .filter((name) => /\.(json|lock)$/.test(name))
    .map((name) => join(tasksDir, name.replace(/\.(json|lock)$/, ''))));
  for (const stem of stems) {
    const file = `${stem}.json`;
    const lock = `${stem}.lock`;
    if (named.has(file)) continue;
    const mtimeMs = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (mtimeMs !== undefined && !outOfWindow(now - mtimeMs, STAGE_CEILING_MS)) continue;
    if (lockHeld(lock, now, pidAlive)) continue;
    for (const path of [file, lock]) if (removeIfPresent(path)) removed += 1;
  }
  return removed;
}
