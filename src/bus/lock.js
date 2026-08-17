import { open, unlink, readFile, writeFile, link, stat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAlive as defaultIsAlive, startTimeOf } from './proc.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `pid:starttime:uuid`.
//
// The pid says who holds it; the STARTTIME says which process that pid actually
// is, so a pid recycled onto an unrelated live process is not mistaken for the
// holder (see isAlive in ./proc.js); the uuid makes the token unique per
// acquisition, so the release path can verify it still owns what it is about to
// unlink.
const mintToken = () => `${process.pid}:${startTimeOf(process.pid)}:${randomUUID()}`;

function parseToken(text) {
  const [pidText, startText] = String(text).trim().split(':');
  const pid = Number.parseInt(pidText ?? '', 10);
  if (!Number.isInteger(pid)) return null;
  const starttime = Number.parseInt(startText ?? '', 10);
  return { pid, starttime: Number.isInteger(starttime) ? starttime : null };
}

// STALENESS IS A QUESTION ABOUT THE HOLDER, and mtime is the answer of last
// resort — it is the only one that can be wrong about a live holder, so it is
// asked last and only when the token names a process that really is running.
//
// AN UNPARSABLE OR EMPTY TOKEN IS IMMEDIATELY STALE. That is a claim about
// construction, not a guess: `acquire` below publishes the lock and its token in
// ONE atomic step, so no holder — live or dead — can ever leave a lock file
// without a complete token in it. Anything else at that path is debris.
//
// It is only true BECAUSE of that atomicity, and that is the whole reason
// acquisition was changed. With the old create-then-write, an empty lock file was
// an ordinary state: the holder had created it and not yet written its token.
// Declaring THAT stale would let a reclaimer unlink a lock a live holder had just
// won, and put two hooks in the critical section at once. The 10s mtime fallback
// was accidentally load-bearing there — it waited the writer out. So the window
// had to be REMOVED before the rule could be made strict; fixing the rule alone
// would have traded a 10-second stall for a lost write.
function isStaleText(text, mtimeMs, staleMs, now, isAlive) {
  const holder = parseToken(text);
  if (holder === null) return true;                                  // no valid holder wrote this
  if (!isAlive(holder.pid, { starttime: holder.starttime })) return true;   // dead, or a recycled pid
  return now() - mtimeMs > staleMs;                                  // alive: wedged, or just slow?
}

// PUBLISH THE LOCK AND ITS TOKEN AS ONE INDIVISIBLE STEP.
//
// `open(path, 'wx')` + `writeFile(token)` is two steps, and the gap between them
// is a real state the world can observe: a lock file with no token, which is
// indistinguishable from a corpse. A process killed in that window (a hook is
// killed whenever its agent's turn is cancelled) left one behind permanently, and
// every subsequent hook on the machine then paid 10s waiting for mtime to age it
// out — measured at 10_018ms, hitting every session at once.
//
// link(2) closes it. Write the token to a private temp file, then link that inode
// into place: the link either succeeds — and the lock exists WITH its full token,
// from the first instant it is visible — or it fails EEXIST because someone else
// holds it. There is no third state, and no window. (link(2) is atomic across
// POSIX filesystems, which is what made it the classic lockfile primitive.)
async function acquire(lockPath, token) {
  const temp = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, token);
  try {
    await link(temp, lockPath);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

const GUARD_STALE_MS = 5_000;

// A caller with DEFAULT `withLock` options must be able to outlast a guard
// left behind by a reclaimer that crashed between `open(guard, 'wx')` and
// `unlink(guard)` (see `reclaim` below). Until that guard passes
// GUARD_STALE_MS, every other racer's `reclaim()` call returns `false` and
// the outer retry loop just sleeps — so the default retry budget
// (DEFAULT_RETRIES * DEFAULT_DELAY_MS) has to comfortably clear
// GUARD_STALE_MS, not just approach it: the caller also needs attempts left
// over, after the guard goes stale, to actually unlink it, re-check the
// underlying lock, and acquire.
//
//   INVARIANT: DEFAULT_RETRIES * DEFAULT_DELAY_MS > GUARD_STALE_MS
//
// Enforced below at module load, not just in a comment, so a future edit to
// either side of this can't silently reintroduce a lock that is
// "recoverable" only on paper (see Task 8 Finding 1: 100 * 20ms = 2000ms
// budget vs a 5000ms guard is a caller that gives up while the lock is
// still fully reclaimable).
const DEFAULT_RETRIES = 600;
const DEFAULT_DELAY_MS = 20;   // 600 * 20ms = 12_000ms: ~2.4x GUARD_STALE_MS.

if (DEFAULT_RETRIES * DEFAULT_DELAY_MS <= GUARD_STALE_MS) {
  throw new Error(
    `lock.js: default acquisition budget (${DEFAULT_RETRIES * DEFAULT_DELAY_MS}ms) ` +
    `must exceed GUARD_STALE_MS (${GUARD_STALE_MS}ms), or a default-options caller ` +
    'can never outlast a crashed guard-holder'
  );
}

// RECLAIMING A STALE LOCK IS THE HARD PART, and the obvious implementation is
// wrong. ohai's — check staleness, then unlink, then create — lets two hooks into
// the critical section at once:
//
//   A: reads the stale lock, decides "stale"
//   B: reads the same stale lock, decides "stale"
//   A: unlinks it, creates its own, starts working
//   B: unlinks A'S LIVE LOCK, creates its own, starts working
//
// Both then read-modify-write agents.json, and one session's record silently
// vanishes from the bus. claude-code runs tool calls in parallel, so concurrent
// PreToolUse hooks are routine, not exotic.
//
// POSIX has no atomic compare-and-unlink, so the decision and the removal must be
// SERIALIZED. That is what the guard is for. Two rules make it correct:
//
//   1. Re-read the lock UNDER the guard. The snapshot that said "stale" may be
//      seconds old; by now a live holder may own it.
//   2. A MISSING lock is NOT a stale lock. It has nothing to reclaim — return and
//      race for it honestly. Unlinking a path that is already empty is how the
//      original bug survives the guard: between "it's gone" and `unlink()`, a
//      legitimate holder acquires, and you delete *their* lock.
//
// Returns whether the lock path is now free to race for.
async function reclaim(lockPath, staleMs, now, isAlive) {
  const guard = `${lockPath}.reclaim`;

  let handle;
  try {
    handle = await open(guard, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Someone else is reclaiming. Back off — unless they died holding the guard,
    // which would otherwise wedge the bus forever. The guard is held for two
    // syscalls, so anything older than seconds is a corpse.
    const info = await stat(guard).catch(() => null);
    if (info && now() - info.mtimeMs > GUARD_STALE_MS) await unlink(guard).catch(() => {});
    return false;
  }

  try {
    const info = await stat(lockPath).catch(() => null);
    if (info === null) return true;                    // rule 2: nothing to reclaim

    const text = await readFile(lockPath, 'utf8').catch(() => null);
    if (text === null) return true;

    // rule 1: a LIVE holder — leave it alone and wait our turn.
    if (!isStaleText(text, info.mtimeMs, staleMs, now, isAlive)) return false;

    // Safe: the file existed continuously from the stat above to here, so nobody
    // could have acquired it (open 'wx' would have failed), and its dead owner
    // cannot have released it. The only thing at this path is the corpse we read.
    await unlink(lockPath).catch(() => {});
    return true;
  } finally {
    await handle.close();
    await unlink(guard).catch(() => {});
  }
}

export async function withLock(lockPath, fn, opts = {}) {
  const {
    // ~12s of patience (600 x 20ms) — sized to clear GUARD_STALE_MS with room
    // to spare (see the invariant above `DEFAULT_RETRIES`), not to bound the
    // critical section itself. It gets consumed waiting out a DEAD holder, not
    // a live one.
    //
    // WHAT IS ACTUALLY IN THE CRITICAL SECTION (src/bus/transaction.js, commit):
    // the identity resolve, the ASSET RESOLVE (familiar-theme's assetsFor),
    // and two atomic writes. `git` is the one thing deliberately kept out — it
    // spawns up to two subprocesses on every single tool call, and serializing
    // every hook on the machine behind a process spawn is a real cost for no
    // protection, since it reads no shared state.
    //
    // THIS USED TO SAY "THE SPRITE BAKE", and budgeted the lock against a warm
    // cache, a cold cache and a content hash per member. There is no bake and no
    // cache: the baker was deleted, and familiar-theme's assets.js says so in its
    // first paragraph — the sprites are static, committed and scheme-independent, so
    // nothing decodes, nothing re-encodes, nothing is written. What is left of it
    // is assetsFor(): lstat()/realpath() probes that prove every sprite the intent
    // names is really on disk, and build the paths that go on the bus.
    //
    // The asset resolve IS in the lock, and stays there — the surviving half of the
    // old argument, and it survives unchanged. It is the price of failure atomicity:
    // the intent has to be fully earned — every sprite path proven to exist — before
    // agents.json is allowed to move, or a resolve that throws leaves a record on the
    // bus that nothing can resolve, and every subsequent transaction for every
    // session throws on it. Hoisting it out of the lock would mean resolving against
    // an `agents` snapshot read outside it, which is a race, not a saving.
    //
    // No new number is claimed here, because none was measured. What can be said
    // without measuring is that the critical section is now STRICTLY SMALLER than
    // the one the 10s staleMs below was sized against: the decode-and-encode work
    // was removed and nothing was added in its place. Whatever headroom that budget
    // had, it still has, and more.
    retries = DEFAULT_RETRIES,
    delayMs = DEFAULT_DELAY_MS,
    // Comfortably over the critical section above — a few hundred stat()s at worst,
    // against ten seconds — so a lock this old means a dead holder, not a slow one.
    staleMs = 10_000,
    now = () => Date.now(),
    isAlive = defaultIsAlive,
    sleep = defaultSleep,
  } = opts;

  await mkdir(dirname(lockPath), { recursive: true });

  // Unique per-acquisition identity: lets the finally block verify it still
  // owns the lock before deleting it, instead of unlinking whatever is there.
  const token = mintToken();

  let acquired = false;
  for (let attempt = 0; attempt <= retries && !acquired; attempt++) {
    acquired = await acquire(lockPath, token);
    if (acquired) break;
    // Staleness is decided INSIDE reclaim, under its guard — never out here,
    // where the answer would be a snapshot that goes out of date before we act.
    const free = await reclaim(lockPath, staleMs, now, isAlive);
    if (!free) await sleep(delayMs);
  }

  if (!acquired) throw new Error(`could not acquire lock: ${lockPath}`);

  try {
    return await fn();
  } finally {
    // Only unlink if we still own it — a reclaimer may have taken over while
    // our critical section ran past staleMs.
    try {
      const current = await readFile(lockPath, 'utf8');
      if (current.trim() === token) await unlink(lockPath);
    } catch {
      // Already gone or owned by someone else. Cleanup must never throw.
    }
  }
}
