import { readFileSync } from 'node:fs';

// `comm` (field 2) is wrapped in parens and may itself contain spaces and
// parens, so split after the LAST ')'. Field order after comm:
// state(3) ppid(4) pgrp(5) session(6) tty_nr(7) ... starttime(22).
// `after` is zero-indexed from field 3, so field N is after[N - 3].
const FIELD = (n) => n - 3;

export function parseStat(text) {
  if (!text) return null;
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return null;

  const pid = Number.parseInt(text.slice(0, open).trim(), 10);
  const comm = text.slice(open + 1, close);
  const after = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number.parseInt(after[FIELD(4)], 10);
  const ttyNr = Number.parseInt(after[FIELD(7)], 10);

  if (![pid, ppid, ttyNr].every(Number.isInteger)) return null;

  // THE PROCESS'S IDENTITY, not just its name. A pid is a slot, and the kernel
  // hands the same slot out again; starttime (clock ticks since boot) is what
  // makes "pid 4242" mean one particular process rather than the next one to
  // land on that number. Kept OPTIONAL — null when the field is absent — so
  // parseStat stays a parser and the policy about a missing starttime lives in
  // one place (isAlive).
  const raw = Number.parseInt(after[FIELD(22)], 10);
  const starttime = Number.isInteger(raw) ? raw : null;

  return { pid, comm, ppid, ttyNr, starttime };
}

const defaultReadStat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;   // the process exited between listing and reading
  }
};

// Self first, walking up to pid 1. A vanished ancestor truncates the chain
// rather than throwing: /proc is a race by construction.
export function ancestors(pid, { readStat = defaultReadStat } = {}) {
  const chain = [];
  const seen = new Set();
  let current = pid;
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    const stat = parseStat(readStat(current));
    if (!stat) break;
    chain.push(stat);
    current = stat.ppid;
  }
  return chain;
}

// The starttime of a process, for stamping onto the record that claims it.
export function startTimeOf(pid, { readStat = defaultReadStat } = {}) {
  return parseStat(readStat(pid))?.starttime ?? null;
}

// "Is SOMETHING using this pid?" — and nothing more. This is the whole of what
// kill(pid, 0) can tell you, and the reason it is not enough on its own: it
// cannot distinguish the process you meant from whatever recycled its number.
// Exported separately so the two callers with genuinely different questions do
// not have to share one answer.
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';   // exists, owned by someone else
  }
}

// A PID IS NOT AN IDENTITY. agents.json survives reboots, and `kill(pid, 0)` is
// perfectly true for a RECYCLED pid now belonging to something else entirely —
// so a stale record could be "alive" forever and never be reaped. A record
// with `pid: 1` survived every prune there has ever been.
//
// starttime settles it: same pid, different starttime, different process. Evict.
//
// A record with NO starttime (written before the field existed) is UNVERIFIABLE,
// and unverifiable is exactly the class of record this bug is made of — the one
// that outlives its process. So it is treated as DEAD. That is safe because it is
// self-healing and costs nothing: a genuinely live session rewrites its own record
// on its very next hook (PreToolUse fires on every tool call), with a starttime,
// and is simply back. A dead one is finally gone.
export function isAlive(pid, { starttime = null, readStat = defaultReadStat } = {}) {
  if (!pidExists(pid)) return false;
  if (!Number.isInteger(starttime)) return false;   // unverifiable — see above

  // EPERM above means the pid exists but is another user's. /proc/<pid>/stat is
  // world-readable, so the comparison still works — which is the point: a pid
  // recycled INTO another user's process is precisely the case kill(pid, 0)
  // cannot see.
  return startTimeOf(pid, { readStat }) === starttime;
}
