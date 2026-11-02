// The task a status line shows: the live claim, else the one this session last showed, kept in
// a per-session file after its claim is released. Every poll runs this, task or not, so it
// imports node builtins and ledger.js, which the render cache's hit path already loads, and
// holds only what a poll with no task needs: with no claim and no session file, a poll loads
// this alone and does one read. The stage of a task that is shown is read by stagecache.js,
// which the front door loads only then (test/stagecache.test.js and test/bin-familiar.test.js
// hold both graphs to that). Each module a poll loads costs it a fixed share, and its code a
// compile, so keep code here to the session file.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ledgerName } from './ledger.js';

// A canonical tasks id: what stagecache.js's cachePaths accepts, and what the render records or
// reads back.
export const TASK_ID = /^[a-z][a-z0-9-]*-[0-9a-f]{6}$/;

export const sessionFilePath = (stateDir, sessionId) =>
  join(stateDir, 'statusline', `${ledgerName(sessionId)}.json`);

// A file's JSON, or null when there is no file. Anything else (unreadable, not JSON) throws.
export function readJsonOrNull(path) {
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
