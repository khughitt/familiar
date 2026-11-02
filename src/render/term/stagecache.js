// The status line's task stage cache, per (task, worktree): where it and its refresher lock
// live, how a source file's mtime is stamped, and when a lock is held, which the detached
// refresher (stagerefresh.js) that writes the cache imports from here; and the render side's
// read, which spawns that refresher when the cache is stale. The read is synchronous and on the
// render path: file reads, two stats, and at most one detached spawn. The front door loads this
// only for a poll that shows a task (stagesession.js decides that), so its imports are node
// builtins, absent.js, ledger.js and stagesession.js: never the refresher's graph (it runs
// `tasks` and holds the stage table) or the HUD's. `familiar reap`'s share is here too.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABSENT } from './absent.js';
import { ledgerName } from './ledger.js';
import { TASK_ID, readJsonOrNull } from './stagesession.js';

export const LOCK_STALE_MS = 30_000;
// The script the render spawns, run directly by node.
export const REFRESHER_PATH = fileURLToPath(new URL('./stagerefresh.js', import.meta.url));
export const STAGE_CEILING_MS = 600_000;
export const FAILED_RETRY_MS = 30_000;

// Full precision, as a string: two writes within one millisecond must still differ.
export function mtimeStamp(path) {
  try {
    return statSync(path, { bigint: true }).mtimeNs.toString();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function cachePaths(stateDir, taskId, worktree) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new Error(`stage cache: not a task id: ${JSON.stringify(taskId)}`);
  }
  if (typeof worktree !== 'string' || worktree === '') {
    throw new Error(`stage cache: not a worktree path: ${JSON.stringify(worktree)}`);
  }
  const stem = join(stateDir, 'statusline', 'tasks',
    `${taskId}.${createHash('sha256').update(worktree).digest('hex').slice(0, 12)}`);
  return { file: `${stem}.json`, lock: `${stem}.lock` };
}

const defaultPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;   // alive, someone else's
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

// Held when it names a live pid and was taken within LOCK_STALE_MS of now, either way: a lock
// stamped far in the future (a clock step) would otherwise hold forever. A lock that does not
// parse yet (taken but not written) or no longer parses is judged by its file's mtime alone.
export function lockHeld(lockPath, now, pidAlive = defaultPidAlive) {
  let text;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  let lock = null;
  try {
    lock = JSON.parse(text);
  } catch {
    lock = null;
  }
  const at = typeof lock?.at === 'string' ? Date.parse(lock.at) : NaN;
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0 || Number.isNaN(at)) {
    let mtimeMs;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    return Math.abs(now - mtimeMs) <= LOCK_STALE_MS;
  }
  return Math.abs(now - at) <= LOCK_STALE_MS && pidAlive(lock.pid);
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
