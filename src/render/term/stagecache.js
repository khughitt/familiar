// The render side of the status line's task stage: remember the session's last task after its
// claim is released, read the per-(task, worktree) cache the detached refresher wrote, and
// spawn that refresher when the cache is stale. Everything here is synchronous and on the
// render path: file reads, two stats, and at most one detached spawn.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ABSENT } from './hud.js';
import { ledgerName } from './ledger.js';
import { REFRESHER_PATH, cachePaths, lockHeld, mtimeStamp } from './stagerefresh.js';

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

// The task the line shows: the live claim (recorded when it changed), else the one recorded.
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
    && typeof recorded.taskId === 'string' && typeof recorded.worktree === 'string';
  if (!claim) return valid ? { id: recorded.taskId, others: 0, worktree: recorded.worktree } : null;
  if (!valid || recorded.taskId !== claim.id || recorded.worktree !== claim.worktree) {
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

export function readStage({ stateDir, task, cwd, now, spawnRefresher = defaultSpawnRefresher, pidAlive }) {
  const { file, lock } = cachePaths(stateDir, task.id, task.worktree);
  const cache = readJsonOrNull(file);
  let result;
  let stale;
  if (cache === null || cache.worktree !== task.worktree) {
    result = { stage: ABSENT, fault: null };
    stale = true;
  } else {
    result = { stage: cache.stage, fault: cache.fault };
    const age = now - Date.parse(cache.refreshedAt);
    if (cache.tasksDir === null) {
      stale = outOfWindow(age, FAILED_RETRY_MS);
    } else {
      stale = outOfWindow(age, STAGE_CEILING_MS)
        || mtimeStamp(cache.tasksDir) !== cache.tasksDirMtimeNs
        || mtimeStamp(cache.parkStore) !== cache.parkStoreMtimeNs;
    }
  }
  if (stale && !lockHeld(lock, now, pidAlive)) {
    spawnRefresher({ taskId: task.id, worktree: task.worktree, cwd });
  }
  return result;
}
