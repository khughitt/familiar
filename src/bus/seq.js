import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';

// ONE COUNTER FOR THE WHOLE BUS, deliberately not a per-session field on the agent
// record. The record is removed by eviction (commit() evicts and later readmits live
// sessions) and by SessionEnd, while the transmission ledger for that session survives
// both; a per-session counter would restart at 1 under a ledger holding 100 and
// suppress the next hundred events. This never resets, and because it is monotonic
// across all sessions, "which of two events of one session is newer" is still answered
// by comparing it. Call ONLY under the bus lock: the read-increment-write is not atomic.
export async function nextSeq(paths) {
  const current = await currentSeq(paths);
  const seq = current + 1;
  await writeJsonAtomic(paths.seqPath, { seq });
  return seq;
}

async function currentSeq(paths) {
  const stored = await readJson(paths.seqPath);
  if (stored === null) {
    try {
      await access(paths.seqPath);
    } catch (error) {
      if (error.code === 'ENOENT') return seedFromLedgers(paths.transmitDir);
      throw error;
    }
  }
  if (!Number.isSafeInteger(stored?.seq) || stored.seq < 0) {
    throw new Error(`invalid event sequence counter at ${paths.seqPath}`);
  }
  return stored.seq;
}

// A missing counter with ledgers present (a wiped state directory that kept transmit/,
// or a first run after this feature lands) must start ABOVE every ledger, or an old
// ledger would outrank every new event.
async function seedFromLedgers(transmitDir) {
  let names;
  try { names = await readdir(transmitDir); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let highest = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const entry = await readJson(join(transmitDir, name));
    if (Number.isInteger(entry?.seq) && entry.seq > highest) highest = entry.seq;
  }
  return highest;
}
