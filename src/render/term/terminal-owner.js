import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock } from '../../bus/lock.js';
import { ownerAlive as defaultOwnerAlive, startTimeOf } from '../../bus/proc.js';
import { readJson, writeJsonAtomic } from '../../bus/store.js';
import { fileLedger, transmitLockOptions } from './ledger.js';

export function terminalOwnerPaths(transmitDir, { pid, starttime }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(starttime) || starttime < 0) {
    throw new TypeError('terminal ownership requires integer pid and starttime');
  }
  const name = `${pid}-${starttime}`;
  return {
    entryPath: join(transmitDir, 'terminals', `${name}.json`),
    lockPath: join(transmitDir, 'terminals', `${name}.lock`),
  };
}

export function decideClaim(current, { sessionId, seq }) {
  if (seq === null) return current?.sessionId === sessionId ? 'own' : 'superseded';
  if (!Number.isInteger(seq)) throw new TypeError('terminal claim requires an integer seq or null');
  return current === null || seq > current.seq ? 'own' : 'superseded';
}

const defaultLockOptions = () => transmitLockOptions({ ownerAlive: defaultOwnerAlive, startTimeOf });

// The terminal lock always surrounds the caller's per-session transmission section.
export async function withTerminal({
  transmitDir, terminal, sessionId, seq, lockWith = withLock, lockOptions = defaultLockOptions(),
}, fn) {
  const { entryPath, lockPath } = terminalOwnerPaths(transmitDir, terminal);
  return lockWith(lockPath, async () => {
    const current = await readJson(entryPath);
    if (decideClaim(current, { sessionId, seq }) === 'superseded') {
      return { kind: 'superseded', reason: 'terminal' };
    }
    if (seq !== null) await writeJsonAtomic(entryPath, { sessionId, seq });
    return fn();
  }, lockOptions);
}

export async function pruneTerminalOwners({ transmitDir, ownerAlive, lockWith = withLock }) {
  let files;
  try { files = await readdir(join(transmitDir, 'terminals'), { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return { removed: [] };
    throw error;
  }
  const removed = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    const match = /^(\d+)-(\d+)\.json$/.exec(file.name);
    if (match === null) continue;
    const terminal = { pid: Number(match[1]), starttime: Number(match[2]) };
    const { entryPath, lockPath } = terminalOwnerPaths(transmitDir, terminal);
    await lockWith(lockPath, async () => {
      if (await readJson(entryPath) === null || ownerAlive(terminal.pid, { starttime: terminal.starttime })) return;
      await fileLedger(entryPath).remove();
      removed.push(file.name.slice(0, -'.json'.length));
    }, defaultLockOptions());
  }
  return { removed };
}
