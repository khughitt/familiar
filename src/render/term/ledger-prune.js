import { readdir as readdirDefault } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock } from '../../bus/lock.js';
import { readJson } from '../../bus/store.js';
import { fileLedger, ledgerName, transmitLockOptions } from './ledger.js';

// The agents snapshot only narrows candidates: an ended session can still own a
// terminal through a straggling hook. Each candidate is re-read under its own
// transmission lock, then removed only when its owner is freshly dead.
export async function pruneLedgers({
  transmitDir, agents, ownerAlive, startTimeOf,
  lockWith = withLock, readdir = readdirDefault, now = () => Date.now(),
}) {
  let names;
  try { names = await readdir(transmitDir); } catch (error) {
    if (error.code === 'ENOENT') return { removed: [], skipped: [] };
    throw error;
  }

  const liveNames = new Set(Object.keys(agents).map(ledgerName));
  const removed = [];
  const skipped = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    if (liveNames.has(name)) continue;

    const entryPath = join(transmitDir, file);
    const lockPath = join(transmitDir, `${name}.lock`);
    const options = { ...transmitLockOptions({ ownerAlive, startTimeOf, now }), retries: 5 };
    try {
      await lockWith(lockPath, async () => {
        const entry = await readJson(entryPath);
        if (entry === null || ownerAlive(entry.pid, { starttime: entry.starttime })) return;
        await fileLedger(entryPath).remove();
        removed.push(name);
      }, options);
    } catch (error) {
      if (!/could not acquire lock/.test(error.message)) throw error;
      skipped.push(name);
    }
  }
  return { removed, skipped };
}
