import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { readJson, writeJsonAtomic } from '../../bus/store.js';
import { memoizeFor } from '../../bus/memo.js';

// What the terminal holds, as opposed to what the bus intended. The bus's intent record
// is written by the transaction whether or not any byte reached a terminal; this file is
// written only by the one section that writes the terminal (emit.js), inside the lock
// that serializes those writes. Spec §3.5.
export const EMPTY_ENTRY = Object.freeze({ seq: 0, held: null });

// Sized to wait 30 s at withLock's default 20 ms delay: inside Claude Code's 60 s hook
// budget, and long enough for the pty write the holder may be in the middle of.
export const TRANSMIT_LOCK_RETRIES = 1500;
export const LIVENESS_MEMO_MS = 1000;

// A session id is whatever the agent put in the payload; parsePayload accepts any
// non-empty string, so `../agents` is a valid id and would name agents.json. The
// sanitised prefix keeps the file readable to a person; the hash keeps distinct ids
// distinct after sanitising. The assertion cannot fire — the character class admits no
// separator — and stays as the statement of the invariant.
export function ledgerName(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('ledgerName requires a non-empty session id');
  }
  const prefix = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  const name = `${prefix}-${hash}`;
  if (name.includes('/') || name.includes(sep) || name.includes('\0')) {
    throw new Error(`ledgerName produced a path, not a name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function ledgerPaths(transmitDir, sessionId) {
  const name = ledgerName(sessionId);
  return { entryPath: join(transmitDir, `${name}.json`), lockPath: join(transmitDir, `${name}.lock`) };
}

export function fileLedger(entryPath) {
  return {
    read: async () => (await readJson(entryPath)) ?? EMPTY_ENTRY,
    write: (entry) => writeJsonAtomic(entryPath, entry),
    remove: async () => {
      try { await unlink(entryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

// For tests: the same interface over a variable, plus the write history.
export function memoryLedger(initial = null) {
  let entry = initial;
  const writes = [];
  return {
    read: async () => entry ?? EMPTY_ENTRY,
    write: async (next) => { entry = next; writes.push(next); },
    remove: async () => { entry = null; },
    writes,
    get entry() { return entry; },
  };
}

// EVERY write goes through here, so every entry carries the identity pruning tests.
export function stamp({ held = null, ended = false } = {}, { seq, owner }) {
  return { seq, pid: owner.pid, starttime: owner.starttime, held, ended };
}

// Evidence never survives a change of owner. A resumed session under a new process
// whose first hook was suppressed would otherwise be restamped with the new identity
// while keeping the old process's `held`, and the next graphical hook would `update` an
// image the new terminal never received.
export function inherit(entry, owner) {
  return entry.pid === owner.pid && entry.starttime === owner.starttime ? entry.held : null;
}

export function transmitLockOptions({ ownerAlive, startTimeOf, now = () => Date.now() }) {
  return {
    staleMs: Infinity,
    retries: TRANSMIT_LOCK_RETRIES,
    isAlive: memoizeFor(ownerAlive, LIVENESS_MEMO_MS, { now }),
    startTimeOf,
    now,
  };
}
