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

const DARWIN_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

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
  const starttime = Date.parse(match[4]) / 1000;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0
      || !Number.isInteger(starttime) || match[5].trim() === '') {
    throw new Error(`Darwin ps: malformed row ${JSON.stringify(line)}`);
  }
  return {
    pid,
    ppid,
    comm: basename(match[5]),
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

const runDarwinPs = (args) => {
  const result = spawnSync('/bin/ps', args, {
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

export function createProcessOps({
  platform = process.platform,
  readStat = defaultReadStat,
  runPs = runDarwinPs,
  kill = defaultKill,
} = {}) {
  if (platform === 'linux') {
    const recordOf = (pid, { readStat: read = readStat } = {}) => parseStat(read(pid));
    const startTimeOf = (pid, options) => recordOf(pid, options)?.starttime ?? null;
    return {
      recordOf,
      ancestors: (pid, options) => walkAncestors(pid, (current) => recordOf(current, options)),
      startTimeOf,
      pidExists: (pid) => exists(pid, kill),
      isAlive(pid, { starttime = null, readStat: read = readStat } = {}) {
        return exists(pid, kill)
          && Number.isInteger(starttime)
          && startTimeOf(pid, { readStat: read }) === starttime;
      },
    };
  }

  if (platform === 'darwin') {
    let snapshot;
    const records = () => {
      if (!snapshot) {
        const output = runPs(['-axo', 'pid=,ppid=,tty=,lstart=,comm=']);
        if (typeof output !== 'string' || output.trim() === '') {
          throw new Error('Darwin ps: malformed output');
        }
        snapshot = new Map(output.trimEnd().split('\n').map(parseDarwinRow).map((record) => [record.pid, record]));
      }
      return snapshot;
    };
    const recordOf = (pid) => records().get(pid) ?? null;
    const startTimeOf = (pid) => recordOf(pid)?.starttime ?? null;
    return {
      recordOf,
      ancestors: (pid) => walkAncestors(pid, recordOf),
      startTimeOf,
      pidExists: (pid) => exists(pid, kill),
      isAlive(pid, { starttime = null } = {}) {
        return exists(pid, kill)
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
export const isAlive = (...args) => defaultProcessOps.isAlive(...args);
export const pidExists = (...args) => defaultProcessOps.pidExists(...args);
