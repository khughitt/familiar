import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../src/bus/lock.js';
import { startTimeOf } from '../src/bus/proc.js';

const dir = () => mkdtempSync(join(tmpdir(), 'familiar-lock-'));

// The token a real holder writes: `pid:starttime:uuid`. A live holder ALWAYS has
// one — acquisition publishes the lock and its token in one atomic link(2), so
// there is no instant at which the file exists without it.
const liveToken = () => `${process.pid}:${startTimeOf(process.pid)}:held`;

test('serializes concurrent writers — no interleaving', async () => {
  const lockPath = join(dir(), 'agents.lock');
  const order = [];
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      withLock(lockPath, async () => {
        order.push(`enter-${n}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`exit-${n}`);
      }, { delayMs: 1 })
    )
  );
  // Every enter is immediately followed by its own exit.
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i].replace('enter-', ''), order[i + 1].replace('exit-', ''));
  }
});

test('releases the lock even when the critical section throws', async () => {
  const lockPath = join(dir(), 'agents.lock');
  await assert.rejects(withLock(lockPath, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lockPath), false);
  await withLock(lockPath, async () => {});   // still acquirable
});

// The dead holder is pid 999999. Every real racer is THIS process, and is alive.
// `isAlive: () => false` would be a broken stub: it makes the live holder look
// dead too, so racers "correctly" reclaim a lock that is legitimately held, and
// the test would fail against even a correct implementation.
const isAlive = (pid) => pid !== 999999;

test('reclaims a lock held by a dead process — a crashed hook must not wedge the bus', async () => {
  const lockPath = join(dir(), 'agents.lock');
  writeFileSync(lockPath, '999999:stale-token');
  let ran = false;
  await withLock(lockPath, async () => { ran = true; }, { retries: 5, delayMs: 1, isAlive });
  assert.equal(ran, true);
});

test('EIGHT racers reclaiming ONE stale lock do not overlap — that would lose a write', async () => {
  // The bug this pins down: check-staleness-then-unlink is not atomic. All eight
  // read the same stale lock and all decide "stale". The first unlinks it and
  // acquires — and the other seven then unlink THAT LIVE LOCK and acquire too.
  // Two hooks in the critical section means two read-modify-writes of agents.json
  // and one session's record silently gone. claude-code runs tool calls in
  // parallel, so this is routine, not exotic.
  //
  // Eight, not two: with two, a correct-looking-but-wrong implementation passes
  // most of the time. This one reproduced the bug on roughly one run in six.
  const lockPath = join(dir(), 'agents.lock');
  writeFileSync(lockPath, '999999:stale-token');

  let inside = 0;
  let overlapped = false;
  let ran = 0;
  const critical = async () => {
    inside += 1;
    if (inside > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 5));
    inside -= 1;
    ran += 1;
  };

  await Promise.all(
    Array.from({ length: 8 }, () =>
      withLock(lockPath, critical, { retries: 2000, delayMs: 1, isAlive })
    )
  );

  assert.equal(overlapped, false, 'two holders were inside the lock at once');
  assert.equal(ran, 8, 'every racer eventually got its turn');
});

test('gives up rather than hanging forever on a live holder', async () => {
  const lockPath = join(dir(), 'agents.lock');
  writeFileSync(lockPath, liveToken());
  await assert.rejects(
    withLock(lockPath, async () => {}, { retries: 2, delayMs: 1, staleMs: 1_000_000 }),
    /could not acquire lock/
  );
});

// --- Staleness must not cost ten seconds ------------------------------------
//
// Measured hook latency before this: a dead pid in the token was reclaimed in
// 116ms, but an EMPTY lock file — a process killed between `open('wx')` and
// `writeFile(token)` — took 10_018ms, and a token whose pid had been reused by a
// live process took 10_024ms. Bounded, and still exit 0, but a ten-second freeze
// landing on every session on the machine at once.
//
// Both fall back to mtime because the token cannot be resolved to a DEAD pid. A
// valid holder always writes a token, so an unresolvable token is a corpse — and
// after the switch to atomic acquisition (link(2)), that is true by construction
// rather than by hope.

test('an EMPTY lock file is reclaimed AT ONCE — no valid holder can leave one behind', async () => {
  const lockPath = join(dir(), 'agents.lock');
  writeFileSync(lockPath, '');

  let ran = false;
  const { now, sleep } = fakeClock(Date.now());
  // A budget of 3 x 1ms: it cannot possibly wait out a 10s mtime staleness. If
  // this acquires, it is because the empty token was recognized immediately.
  await withLock(lockPath, async () => { ran = true; }, { retries: 3, delayMs: 1, isAlive, now, sleep });
  assert.equal(ran, true);
});

test('a token whose pid has been REUSED by a live process is reclaimed at once', async () => {
  const lockPath = join(dir(), 'agents.lock');
  // A live pid (ours), but the wrong process: the starttime in the token names a
  // process that no longer exists. Pid-only liveness says "held by a live
  // process" and waits 10s. The real, unstubbed isAlive knows better.
  writeFileSync(lockPath, `${process.pid}:${startTimeOf(process.pid) + 1}:recycled`);

  let ran = false;
  const { now, sleep } = fakeClock(Date.now());
  // No isAlive override: the REAL one, doing a real /proc starttime comparison.
  await withLock(lockPath, async () => { ran = true; }, { retries: 3, delayMs: 1, now, sleep });
  assert.equal(ran, true);
});

test('garbage in the lock file is debris, not a holder', async () => {
  const lockPath = join(dir(), 'agents.lock');
  writeFileSync(lockPath, 'not-a-token-at-all\n');
  let ran = false;
  const { now, sleep } = fakeClock(Date.now());
  await withLock(lockPath, async () => { ran = true; }, { retries: 3, delayMs: 1, isAlive, now, sleep });
  assert.equal(ran, true);
});

test('a lock is NEVER visible without its token — the window an empty lock came from is gone', async () => {
  // The reason the rule above is safe. If acquisition were create-then-write,
  // there would be an instant where a live holder's lock file is empty — and
  // "empty means stale" would then let a second process reclaim a lock that was
  // legitimately just won. Atomic link(2) means the file's very first observable
  // state already carries the full token.
  const lockPath = join(dir(), 'agents.lock');
  let seen = null;
  await withLock(lockPath, async () => { seen = readFileSync(lockPath, 'utf8'); }, { delayMs: 1 });
  assert.match(seen, /^\d+:\d+:[0-9a-f-]{36}$/, `lock content inside the critical section: ${JSON.stringify(seen)}`);
});

// Finding 1 (Task 8 review): a process can die in the narrow window after
// creating the `.reclaim` guard but before releasing it. Every OTHER racer
// then sees an EEXIST on the guard and has to wait GUARD_STALE_MS (5000ms)
// before anyone will clean it up — the lock is fully recoverable, but only
// to a caller whose retry budget can outlast that wait. This pins the
// arithmetic (DEFAULT_RETRIES * DEFAULT_DELAY_MS vs GUARD_STALE_MS), not
// wall-clock time: `sleep` advances a fake clock instead of really waiting,
// so the test is fast and immune to scheduler jitter, but the elapsed time
// `reclaim()` observes via `now()` is exactly what real retries would rack
// up at the real default `delayMs`.
function fakeClock(startMs) {
  let elapsed = 0;
  return {
    now: () => startMs + elapsed,
    sleep: async (ms) => { elapsed += ms; },
  };
}

test('a caller with DEFAULT options outlasts a guard left by a crashed reclaimer', async () => {
  const lockPath = join(dir(), 'agents.lock');
  // The underlying lock names a dead pid — reclaimable in principle.
  writeFileSync(lockPath, '999999:stale-token');
  // The `.reclaim` guard already exists, as if a reclaimer opened it and
  // died before the matching `unlink` — simulating a mid-guard crash.
  writeFileSync(`${lockPath}.reclaim`, '');

  const { now, sleep } = fakeClock(Date.now());
  let ran = false;
  // No `retries`/`delayMs` passed — this exercises the shipped defaults.
  await withLock(lockPath, async () => { ran = true; }, { isAlive, now, sleep });
  assert.equal(ran, true, 'default options must be able to reclaim past a stale guard');
});

test('OLD budget (100 x 20ms = 2000ms) cannot outlast the same guard — pins the bug', async () => {
  const lockPath = join(dir(), 'agents.lock');
  writeFileSync(lockPath, '999999:stale-token');
  writeFileSync(`${lockPath}.reclaim`, '');

  const { now, sleep } = fakeClock(Date.now());
  await assert.rejects(
    withLock(lockPath, async () => {}, { retries: 100, delayMs: 20, isAlive, now, sleep }),
    /could not acquire lock/,
    'a 2000ms budget against a 5000ms guard must still fail — this is the bug Finding 1 fixed'
  );
});
