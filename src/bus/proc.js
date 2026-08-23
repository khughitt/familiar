import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';

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

  const raw = Number.parseInt(after[FIELD(22)], 10);
  const starttime = Number.isInteger(raw) ? raw : null;
  return { pid, ppid, comm, tty: ttyNr === 0 ? null : true, starttime };
}

const DARWIN_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/;
const DARWIN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DARWIN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function normalizeDarwinTty(raw) {
  if (raw === '??') return null;
  const match = /^(?:tty)?s([0-9a-f]+)$/i.exec(raw);
  if (!match) throw new Error(`Darwin ps: unsafe Darwin tty ${JSON.stringify(raw)}`);
  return `ttys${match[1]}`;
}

export function parseDarwinRow(line) {
  const match = DARWIN_ROW.exec(line);
  if (!match) throw new Error(`Darwin ps: malformed row ${JSON.stringify(line)}`);
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const day = Number(match[6]);
  const hour = Number(match[7]);
  const minute = Number(match[8]);
  const second = Number(match[9]);
  const year = Number(match[10]);
  const month = DARWIN_MONTHS.indexOf(match[5]);
  const started = new Date(0);
  started.setFullYear(year, month, day);
  started.setHours(hour, minute, second, 0);
  const starttime = started.getTime() / 1000;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0
      || started.getFullYear() !== year || started.getMonth() !== month
      || started.getDate() !== day || started.getHours() !== hour
      || started.getMinutes() !== minute || started.getSeconds() !== second
      || DARWIN_WEEKDAYS[started.getDay()] !== match[4]
      || !Number.isInteger(starttime) || match[11].trim() === '') {
    throw new Error(`Darwin ps: malformed row ${JSON.stringify(line)}`);
  }
  return {
    pid,
    ppid,
    comm: basename(match[11]),
    tty: normalizeDarwinTty(match[3]),
    starttime,
  };
}

const defaultReadStat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
};

const defaultKill = (pid, signal) => process.kill(pid, signal);

export const runDarwinPs = (args, spawn = spawnSync) => {
  const result = spawn('/bin/ps', args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error) throw new Error(`Darwin ps: spawn failed: ${result.error.message}`);
  if (result.signal) throw new Error(`Darwin ps: terminated by signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`Darwin ps: exited with status ${result.status}`);
  return result.stdout;
};

const walkAncestors = (pid, recordOf) => {
  const chain = [];
  const seen = new Set();
  let current = pid;
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    const record = recordOf(current);
    if (!record) break;
    chain.push(record);
    current = record.ppid;
  }
  return chain;
};

const exists = (pid, kill) => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const cachedLockHolderAlive = (freshRecordOf, pidExists) => {
  const cache = new Map();
  return (pid, options = {}) => {
    const { starttime = null } = options;
    const key = `${pid}:${starttime}`;
    if (cache.has(key)) return cache.get(key);

    let alive = false;
    if (pidExists(pid)) {
      try {
        const record = freshRecordOf(pid, options);
        alive = !Number.isInteger(record?.starttime) || record.starttime === starttime;
      } catch {
        alive = true;
      }
    }
    cache.set(key, alive);
    return alive;
  };
};

export function createProcessOps({
  platform = process.platform,
  readStat = defaultReadStat,
  runPs = runDarwinPs,
  kill = defaultKill,
} = {}) {
  if (platform === 'linux') {
    const freshRecordOf = (pid, { readStat: read = readStat } = {}) => parseStat(read(pid));
    const recordOf = freshRecordOf;
    const freshStartTimeOf = (pid, options) => freshRecordOf(pid, options)?.starttime ?? null;
    const startTimeOf = freshStartTimeOf;
    const pidExists = (pid) => exists(pid, kill);
    const lockHolderAlive = cachedLockHolderAlive(freshRecordOf, pidExists);
    return {
      recordOf,
      ancestors: (pid, options) => walkAncestors(pid, (current) => recordOf(current, options)),
      startTimeOf,
      freshRecordOf,
      freshStartTimeOf,
      pidExists,
      lockHolderAlive,
      isAlive(pid, { starttime = null, readStat: read = readStat } = {}) {
        return pidExists(pid)
          && Number.isInteger(starttime)
          && startTimeOf(pid, { readStat: read }) === starttime;
      },
    };
  }

  if (platform === 'darwin') {
    // ONE BAD ROW MUST NOT DISABLE THE MACHINE. `-axo` returns EVERY process on the Mac, most of
    // them nothing to do with Familiar and some of them nothing to do with this user. Mapping a
    // strict parser across that table made Familiar's correctness depend on all several hundred
    // rows: one `tty console` row -- a real BSD tty name -- threw out of the map(), and every hook
    // on the machine then failed with a cosmetic exit-zero diagnostic and no cat.
    //
    // So each row is parsed on its own. A row that fails is remembered AGAINST ITS PID rather than
    // dropped, so asking about that specific process still raises the named error instead of
    // quietly answering "no such process" -- fail closed for the question we were asked, and stay
    // silent about questions nobody asked. A parseable row always wins over an unparseable one for
    // the same pid. A row too damaged to name a pid at all answers no question and is dropped.
    let snapshot;
    const records = () => {
      if (!snapshot) {
        const output = runPs(['-axo', 'pid=,ppid=,tty=,lstart=,comm=']);
        if (typeof output !== 'string' || output.trim() === '') {
          throw new Error('Darwin ps: malformed output');
        }
        snapshot = new Map();
        for (const line of output.trimEnd().split('\n')) {
          let record;
          try {
            record = parseDarwinRow(line);
          } catch (error) {
            const damaged = Number.parseInt(line, 10);
            if (Number.isSafeInteger(damaged) && damaged > 0 && !snapshot.has(damaged)) {
              snapshot.set(damaged, error);
            }
            continue;
          }
          snapshot.set(record.pid, record);
        }
      }
      return snapshot;
    };
    const recordOf = (pid) => {
      const found = records().get(pid) ?? null;
      if (found instanceof Error) throw found;
      return found;
    };
    const startTimeOf = (pid) => recordOf(pid)?.starttime ?? null;
    const freshRecordOf = (pid) => {
      const output = runPs(['-p', String(pid), '-o', 'pid=,ppid=,tty=,lstart=,comm=']);
      if (typeof output !== 'string' || output.trim() === '') return null;
      const lines = output.trimEnd().split('\n');
      if (lines.length !== 1) throw new Error('Darwin ps: malformed output');
      const record = parseDarwinRow(lines[0]);
      return record.pid === pid ? record : null;
    };
    const freshStartTimeOf = (pid) => freshRecordOf(pid)?.starttime ?? null;
    const pidExists = (pid) => exists(pid, kill);
    const lockHolderAlive = cachedLockHolderAlive(freshRecordOf, pidExists);
    return {
      recordOf,
      ancestors: (pid) => walkAncestors(pid, recordOf),
      startTimeOf,
      freshRecordOf,
      freshStartTimeOf,
      pidExists,
      lockHolderAlive,
      isAlive(pid, { starttime = null } = {}) {
        return pidExists(pid)
          && Number.isInteger(starttime)
          && startTimeOf(pid) === starttime;
      },
    };
  }

  throw new Error(`unsupported process platform: ${platform}`);
}

export const defaultProcessOps = createProcessOps();
export const ancestors = (...args) => defaultProcessOps.ancestors(...args);
export const recordOf = (...args) => defaultProcessOps.recordOf(...args);
export const startTimeOf = (...args) => defaultProcessOps.startTimeOf(...args);
export const freshRecordOf = (...args) => defaultProcessOps.freshRecordOf(...args);
export const freshStartTimeOf = (...args) => defaultProcessOps.freshStartTimeOf(...args);
export const isAlive = (...args) => defaultProcessOps.isAlive(...args);
export const lockHolderAlive = (...args) => defaultProcessOps.lockHolderAlive(...args);
export const pidExists = (...args) => defaultProcessOps.pidExists(...args);
