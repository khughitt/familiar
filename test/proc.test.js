import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStat, ancestors, isAlive, startTimeOf } from '../src/bus/proc.js';

// A real /proc/<pid>/stat line, fields 3..22 in order, so field 22 (starttime)
// lands where the parser looks for it. Anything shorter is a truncated fixture,
// not a stat line — and parseStat says so by reporting starttime: null.
const statLine = (over = {}) => {
  const f = {
    pid: 4242, comm: 'claude', state: 'S', ppid: 4200, pgrp: 4242, session: 4242,
    ttyNr: 34816, tpgid: 4242, flags: 4194304, minflt: 100, cminflt: 0, majflt: 0,
    cmajflt: 0, utime: 1, stime: 2, cutime: 3, cstime: 4, priority: 20, nice: 0,
    numThreads: 1, itrealvalue: 0, starttime: 987654,
    ...over,
  };
  return [
    f.pid, `(${f.comm})`, f.state, f.ppid, f.pgrp, f.session, f.ttyNr, f.tpgid,
    f.flags, f.minflt, f.cminflt, f.majflt, f.cmajflt, f.utime, f.stime, f.cutime,
    f.cstime, f.priority, f.nice, f.numThreads, f.itrealvalue, f.starttime,
  ].join(' ');
};

test('parses a comm containing spaces and parentheses', () => {
  assert.deepEqual(parseStat(statLine({ comm: 'my (weird) proc' })), {
    pid: 4242, comm: 'my (weird) proc', ppid: 4200, ttyNr: 34816, starttime: 987654,
  });
});

test('parses starttime — field 22, the thing that makes a pid an identity', () => {
  assert.equal(parseStat(statLine({ starttime: 1234567 })).starttime, 1234567);
  // A line too short to carry field 22 is not an error; it simply has no
  // starttime, and isAlive is where that means something.
  assert.equal(parseStat('500 (node) S 400 0 0 0 0').starttime, null);
});

test('returns null on garbage rather than a half-built record', () => {
  assert.equal(parseStat(''), null);
  assert.equal(parseStat('nonsense'), null);
});

test('walks the ancestor chain, self first, and stops at pid 1', () => {
  const table = {
    500: '500 (node) S 400 0 0 0 0 0 0 0 0 0 0 0 0 0',
    400: '400 (zsh) S 300 0 0 0 0 0 0 0 0 0 0 0 0 0',
    300: '300 (claude) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0',
  };
  const readStat = (pid) => table[pid] ?? null;
  assert.deepEqual(
    ancestors(500, { readStat }).map((p) => p.comm),
    ['node', 'zsh', 'claude']
  );
});

test('a vanished ancestor truncates the chain rather than throwing', () => {
  const readStat = (pid) => (pid === 500 ? '500 (node) S 999 0 0 0 0 0 0 0 0 0 0 0 0 0' : null);
  assert.deepEqual(ancestors(500, { readStat }).map((p) => p.pid), [500]);
});

// --- A PID IS NOT AN IDENTITY ----------------------------------------------
//
// agents.json survives reboots. `kill(pid, 0)` is perfectly true for a RECYCLED
// pid that now belongs to something else entirely, so a stale record was "alive"
// forever and could never be reaped — a record with `pid: 1` survived every
// prune there has ever been. starttime is what settles it.

test('isAlive is true for THIS process — with its real starttime, read from real /proc', () => {
  // No injected readStat: the real /proc, this real process, its real starttime.
  const mine = startTimeOf(process.pid);
  assert.ok(Number.isInteger(mine), 'this process must have a readable starttime');
  assert.equal(isAlive(process.pid, { starttime: mine }), true);
});

test('isAlive is false for an impossible pid', () => {
  assert.equal(isAlive(0x7fffffff, { starttime: 123 }), false);
});

test('a RECYCLED pid is a different process, and is NOT alive — kill(pid, 0) cannot see this', () => {
  // The pid is live (it is ours, so process.kill(pid, 0) returns cleanly), but the
  // process wearing it now started at a different time than the record claims.
  // This is the phantom: without starttime it is "alive" forever.
  const mine = startTimeOf(process.pid);
  assert.equal(isAlive(process.pid, { starttime: mine + 1 }), false);
  assert.equal(isAlive(1, { starttime: 999_999_999 }), false, 'the `pid: 1` phantom');
});

test('a record with NO starttime is unverifiable, and unverifiable is treated as dead', () => {
  // Written before the field existed. It is exactly the class of record this bug
  // is made of — the one that outlives its process — and there is no way to tell
  // it apart from one that does not. Self-healing: a genuinely live session
  // rewrites its own record, with a starttime, on its very next hook.
  assert.equal(isAlive(process.pid), false);
  assert.equal(isAlive(process.pid, { starttime: null }), false);
});

test('a pid recycled into ANOTHER USER\'S process is caught too — EPERM is not proof of identity', () => {
  // kill(pid, 0) throws EPERM for a live process owned by someone else, which the
  // old check read as "alive" and stopped there. /proc/<pid>/stat stays
  // world-readable, so the starttime comparison still runs — and still says no.
  const readStat = () => '1 (systemd) S 0 1 1 0 -1 4194560 100 0 0 0 1 2 3 4 20 0 1 0 5';
  assert.equal(isAlive(1, { starttime: 999, readStat }), false, 'pid 1 exists; it is not our agent');
  assert.equal(isAlive(1, { starttime: 5, readStat }), true, 'pid 1 IS the process the record names');
});
