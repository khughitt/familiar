// The lock is the bus's single-writer invariant. test/lock.test.js proves
// exclusion via Promise.all — concurrent promises INSIDE one Node process,
// interleaved on one event loop. That exercises the reclaim guard's logic,
// but it cannot catch a lock that is broken only across independent OS
// processes with independent memory and genuinely concurrent syscalls,
// which is the actual production shape (concurrent claude-code hooks).
//
// These tests spawn REAL child processes (node:child_process) against a
// real lock file and a real shared counter file, and assert no update is
// lost. Kept small — a handful of processes, a few iterations each — per
// the review's own out-of-band proof at 8-16 processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const worker = fileURLToPath(new URL('./fixtures/lock-worker.js', import.meta.url));
const dir = () => mkdtempSync(join(tmpdir(), 'familiar-lock-mp-'));

// An impossible pid — same convention as proc.test.js — so a worker's real,
// unstubbed `isAlive` (an actual `process.kill(pid, 0)`) reliably reports it
// dead, without depending on any particular pid on this machine being free.
const DEAD_PID = 0x7fffffff;

function runWorker(lockPath, counterPath, { iterations, retries, delayMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [worker, lockPath, counterPath, String(iterations), String(retries), String(delayMs)],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
  });
}

test(
  'real child processes serializing on the lock never lose a counter update',
  { timeout: 30_000 },
  async () => {
    const d = dir();
    const lockPath = join(d, 'agents.lock');
    const counterPath = join(d, 'counter');
    writeFileSync(counterPath, '0');

    const processes = 8;
    const iterations = 3;
    await Promise.all(
      Array.from({ length: processes }, () =>
        runWorker(lockPath, counterPath, { iterations, retries: 200, delayMs: 10 })
      )
    );

    const final = Number.parseInt(readFileSync(counterPath, 'utf8'), 10);
    assert.equal(final, processes * iterations, 'a lost update means the lock did not exclude across processes');
  }
);

test(
  'real child processes reclaim a lock pre-seeded with a dead pid, with no lost updates',
  { timeout: 30_000 },
  async () => {
    const d = dir();
    const lockPath = join(d, 'agents.lock');
    const counterPath = join(d, 'counter');
    writeFileSync(counterPath, '0');
    // Simulates a hook that crashed while holding the lock: the file is
    // present, names a pid nothing alive can be, and every worker below
    // must reclaim it (and each other's later locks) using the REAL,
    // unstubbed isAlive — no isAlive override anywhere in this test.
    writeFileSync(lockPath, `${DEAD_PID}:12345:stale-token`);

    const processes = 8;
    const iterations = 3;
    await Promise.all(
      Array.from({ length: processes }, () =>
        runWorker(lockPath, counterPath, { iterations, retries: 200, delayMs: 10 })
      )
    );

    const final = Number.parseInt(readFileSync(counterPath, 'utf8'), 10);
    assert.equal(final, processes * iterations, 'a lost update means cross-process reclaim let two workers in at once');
  }
);

// THE CASE THE STALENESS RULE GOT STRICTER ABOUT, and therefore the one that has
// to be proven across real processes rather than argued about.
//
// An EMPTY lock file is now reclaimed immediately instead of after a 10s mtime
// wait. That is only sound because acquisition publishes the lock and its token
// in ONE atomic link(2): a live holder can never be observed holding an empty
// lock. If that reasoning is wrong — if there is still any window in which a lock
// exists without its token — then "empty means stale" lets a second process
// unlink a lock that was legitimately just won, and this test loses an update.
//
// It is not a latency test. It is the mutual-exclusion proof for the rule change.
test(
  'real child processes racing on an EMPTY lock file still never lose an update',
  { timeout: 30_000 },
  async () => {
    const d = dir();
    const lockPath = join(d, 'agents.lock');
    const counterPath = join(d, 'counter');
    writeFileSync(counterPath, '0');
    writeFileSync(lockPath, '');   // the debris the old create-then-write window left

    const processes = 8;
    const iterations = 3;
    await Promise.all(
      Array.from({ length: processes }, () =>
        runWorker(lockPath, counterPath, { iterations, retries: 200, delayMs: 10 })
      )
    );

    const final = Number.parseInt(readFileSync(counterPath, 'utf8'), 10);
    assert.equal(
      final, processes * iterations,
      'a lost update means "an empty token is stale" let two workers into the critical section'
    );
  }
);
