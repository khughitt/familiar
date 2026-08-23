import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProcessOps,
  parseDarwinRow,
  normalizeDarwinTty,
  runDarwinPs,
  parseStat,
  isAlive,
  startTimeOf,
} from '../src/bus/proc.js';

const requiresLinuxProc = process.platform !== 'linux' ? 'requires Linux /proc' : false;

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
    pid: 4242, ppid: 4200, comm: 'my (weird) proc', tty: true, starttime: 987654,
  });
});

test('Linux records normalize controlling terminal presence', () => {
  assert.equal(parseStat(statLine({ ttyNr: 34816 })).tty, true);
  assert.equal(parseStat(statLine({ ttyNr: 0 })).tty, null);
});

test('Darwin ps keeps comm last and canonicalizes tty', () => {
  assert.deepEqual(parseDarwinRow(
    '77266 77264 ttys000 Sat Aug 22 23:24:46 2026 /Applications/Some App/claude'
  ), {
    pid: 77266,
    ppid: 77264,
    comm: 'claude',
    tty: 'ttys000',
    starttime: Date.parse('Sat Aug 22 23:24:46 2026') / 1000,
  });
});

test('Darwin tty accepts full and abbreviated ptys only', () => {
  assert.equal(normalizeDarwinTty('??'), null);
  assert.equal(normalizeDarwinTty('ttys003'), 'ttys003');
  assert.equal(normalizeDarwinTty('s003'), 'ttys003');
  for (const raw of ['console', '../ttys003', 'ttys003/x', '/dev/ttys003']) {
    assert.throws(() => normalizeDarwinTty(raw), /unsafe Darwin tty/);
  }
});

test('Darwin rows reject malformed identities, dates, and commands', () => {
  for (const row of [
    '0 1 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node',
    '20 -1 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node',
    '9007199254740992 1 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node',
    '20 9007199254740992 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node',
    '20 1 ?? not-a-date /usr/bin/node',
    '20 1 ?? Tue Feb 31 23:24:46 2026 /usr/bin/node',
    '20 1 ?? Sat Aug 22 24:24:46 2026 /usr/bin/node',
    '20 1 ?? Sat Aug 22 23:60:46 2026 /usr/bin/node',
    '20 1 ?? Sat Aug 22 23:24:60 2026 /usr/bin/node',
    '20 1 ?? Sun Aug 22 23:24:46 2026 /usr/bin/node',
    '20 1 ?? Sat Aug 22 23:24:46 2026    ',
  ]) {
    assert.throws(() => parseDarwinRow(row), /Darwin ps: malformed row/);
  }
});

test('one Darwin snapshot serves ancestry, start time, and liveness', () => {
  let spawns = 0;
  const ops = createProcessOps({
    platform: 'darwin',
    runPs: () => {
      spawns++;
      return [
        '30 20 ?? Sat Aug 22 23:24:47 2026 /usr/bin/node',
        '20 10 ttys003 Sat Aug 22 23:24:46 2026 /opt/bin/claude',
        '10 1 ttys003 Sat Aug 22 23:00:00 2026 /bin/zsh',
      ].join('\n');
    },
    kill: () => {},
  });
  const chain = ops.ancestors(30);
  assert.deepEqual(chain.map((record) => record.pid), [30, 20, 10]);
  assert.equal(ops.startTimeOf(20), chain[1].starttime);
  assert.equal(ops.isAlive(20, { starttime: chain[1].starttime }), true);
  assert.equal(spawns, 1);
});

test('Darwin fresh reads target one pid with the strict row parser', () => {
  let args;
  const ops = createProcessOps({
    platform: 'darwin',
    runPs: (given) => {
      args = given;
      return '20 1 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node';
    },
  });
  assert.deepEqual(ops.freshRecordOf(20), {
    pid: 20,
    ppid: 1,
    comm: 'node',
    tty: null,
    starttime: Date.parse('Sat Aug 22 23:24:46 2026') / 1000,
  });
  assert.deepEqual(args, ['-p', '20', '-o', 'pid=,ppid=,tty=,lstart=,comm=']);
});

test('Darwin lock liveness caches by exact pid and start time', () => {
  let reads = 0;
  const ops = createProcessOps({
    platform: 'darwin',
    runPs: () => {
      reads++;
      return '20 1 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node';
    },
    kill: () => {},
  });
  const starttime = Date.parse('Sat Aug 22 23:24:46 2026') / 1000;
  assert.equal(ops.lockHolderAlive(20, { starttime }), true);
  assert.equal(ops.lockHolderAlive(20, { starttime }), true);
  assert.equal(ops.lockHolderAlive(20, { starttime: starttime + 1 }), false);
  assert.equal(reads, 2);
});

test('Darwin lock liveness rejects an absent pid but preserves an unverifiable live lock', () => {
  let reads = 0;
  const absent = createProcessOps({
    platform: 'darwin',
    runPs: () => { reads++; return ''; },
    kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
  });
  assert.equal(absent.lockHolderAlive(20, { starttime: 123 }), false);
  assert.equal(reads, 0);

  const unreadable = createProcessOps({
    platform: 'darwin',
    runPs: () => { throw new Error('denied'); },
    kill: () => {},
  });
  assert.equal(unreadable.lockHolderAlive(20, { starttime: 123 }), true);
});

test('Darwin process identity fails closed when missing or mismatched', () => {
  const ops = createProcessOps({
    platform: 'darwin',
    runPs: () => '20 1 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node',
    kill: () => {},
  });
  const starttime = Date.parse('Sat Aug 22 23:24:46 2026') / 1000;
  assert.equal(ops.isAlive(20), false);
  assert.equal(ops.isAlive(20, { starttime: starttime + 1 }), false);
  assert.equal(ops.isAlive(999, { starttime }), false);
});

test('Darwin liveness treats EPERM as existing and other kill errors as absent', () => {
  const runPs = () => '20 1 ?? Sat Aug 22 23:24:46 2026 /usr/bin/node';
  const starttime = Date.parse('Sat Aug 22 23:24:46 2026') / 1000;
  const denied = createProcessOps({
    platform: 'darwin', runPs,
    kill: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; },
  });
  const absent = createProcessOps({
    platform: 'darwin', runPs,
    kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
  });
  assert.equal(denied.isAlive(20, { starttime }), true);
  assert.equal(absent.isAlive(20, { starttime }), false);
});

test('Darwin empty ps output and unsupported platforms fail explicitly', () => {
  const ops = createProcessOps({ platform: 'darwin', runPs: () => '' });
  assert.throws(() => ops.recordOf(1), /Darwin ps: malformed output/);
  assert.throws(() => createProcessOps({ platform: 'win32' }), /unsupported process platform: win32/);
});

test('Darwin ps maps spawn, signal, and nonzero failures to named errors', () => {
  for (const [result, message] of [
    [{ error: new Error('missing') }, /Darwin ps: spawn failed: missing/],
    [{ signal: 'SIGKILL' }, /Darwin ps: terminated by signal SIGKILL/],
    [{ signal: null, status: 7 }, /Darwin ps: exited with status 7/],
  ]) {
    assert.throws(() => runDarwinPs([], () => result), message);
  }
});

test('Darwin ps uses the fixed binary, arguments, locale, and returns stdout', () => {
  let call;
  const output = runDarwinPs(['-axo', 'fields'], (...args) => {
    call = args;
    return { signal: null, status: 0, stdout: 'rows' };
  });
  assert.equal(output, 'rows');
  assert.equal(call[0], '/bin/ps');
  assert.deepEqual(call[1], ['-axo', 'fields']);
  assert.equal(call[2].encoding, 'utf8');
  assert.equal(call[2].env.LC_ALL, 'C');
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
  const ops = createProcessOps({ platform: 'linux' });
  assert.deepEqual(
    ops.ancestors(500, { readStat }).map((p) => p.comm),
    ['node', 'zsh', 'claude']
  );
});

test('a vanished ancestor truncates the chain rather than throwing', () => {
  const readStat = (pid) => (pid === 500 ? '500 (node) S 999 0 0 0 0 0 0 0 0 0 0 0 0 0' : null);
  const ops = createProcessOps({ platform: 'linux' });
  assert.deepEqual(ops.ancestors(500, { readStat }).map((p) => p.pid), [500]);
});

test('Linux fresh start-time reads once through the call-time seam', () => {
  let reads = 0;
  const ops = createProcessOps({ platform: 'linux' });
  assert.equal(ops.freshStartTimeOf(4242, {
    readStat: () => { reads++; return statLine(); },
  }), 987654);
  assert.equal(reads, 1);
});

test('Linux lock liveness reads once through the call-time seam', () => {
  let reads = 0;
  const ops = createProcessOps({ platform: 'linux', kill: () => {} });
  assert.equal(ops.lockHolderAlive(4242, {
    starttime: 111,
    readStat: () => { reads++; return statLine(); },
  }), false);
  assert.equal(reads, 1);
});

// --- A PID IS NOT AN IDENTITY ----------------------------------------------
//
// agents.json survives reboots. `kill(pid, 0)` is perfectly true for a RECYCLED
// pid that now belongs to something else entirely, so a stale record was "alive"
// forever and could never be reaped — a record with `pid: 1` survived every
// prune there has ever been. starttime is what settles it.

test('isAlive is true for THIS process — with its real starttime, read from real /proc', {
  skip: requiresLinuxProc,
}, () => {
  // No injected readStat: the real /proc, this real process, its real starttime.
  const mine = startTimeOf(process.pid);
  assert.ok(Number.isInteger(mine), 'this process must have a readable starttime');
  assert.equal(isAlive(process.pid, { starttime: mine }), true);
});

test('isAlive is false for an impossible pid', () => {
  const ops = createProcessOps({ platform: 'linux' });
  assert.equal(ops.isAlive(0x7fffffff, { starttime: 123 }), false);
});

test('a RECYCLED pid is a different process, and is NOT alive — kill(pid, 0) cannot see this', {
  skip: requiresLinuxProc,
}, () => {
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
  const ops = createProcessOps({ platform: 'linux', kill: () => {} });
  assert.equal(ops.isAlive(process.pid), false);
  assert.equal(ops.isAlive(process.pid, { starttime: null }), false);
});

test('a pid recycled into ANOTHER USER\'S process is caught too — EPERM is not proof of identity', () => {
  // kill(pid, 0) throws EPERM for a live process owned by someone else, which the
  // old check read as "alive" and stopped there. /proc/<pid>/stat stays
  // world-readable, so the starttime comparison still runs — and still says no.
  const readStat = () => '1 (systemd) S 0 1 1 0 -1 4194560 100 0 0 0 1 2 3 4 20 0 1 0 5';
  const kill = () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; };
  const ops = createProcessOps({ platform: 'linux', kill });
  assert.equal(ops.isAlive(1, { starttime: 999, readStat }), false, 'pid 1 exists; it is not our agent');
  assert.equal(ops.isAlive(1, { starttime: 5, readStat }), true, 'pid 1 IS the process the record names');
});
