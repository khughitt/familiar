#!/usr/bin/env node
import {
  lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAlive, startTimeOf } from '../src/bus/proc.js';

const OWNER = '.familiar-suite-owner.json';
const OWNER_KIND = 'familiar-test-suite';
const SUITE_LEASE = '\0familiar-test-suite';
const STAGING_PREFIX = '.familiar-suite-';

const ownerBytes = (pidNamespace, pid, starttime) => Buffer.from(`${JSON.stringify({
  version: 2,
  kind: OWNER_KIND,
  pidNamespace,
  worker: { pid, starttime },
}, null, 2)}\n`);

const pidNamespaceOf = () => readlinkSync('/proc/self/ns/pid');

export function acquireSuiteLease(name = SUITE_LEASE, { create = createServer } = {}) {
  return new Promise((resolveLease, rejectLease) => {
    const lease = create();
    const onError = (error) => rejectLease(error.code === 'EADDRINUSE'
      ? new Error('test runner: another suite is already running')
      : new Error(`test runner: cannot acquire suite lease: ${error.message}`));
    lease.once('error', onError);
    lease.listen(name, () => {
      lease.off('error', onError);
      resolveLease(lease);
    });
  });
}

const releaseSuiteLease = (lease) => new Promise((resolveClose, rejectClose) => {
  lease.close((error) => error ? rejectClose(error) : resolveClose());
});

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === keys.slice().sort().join('\0');
}

function ownerIdentity(path, { lstat, realpath, readFile }) {
  const owner = join(path, OWNER);
  let stat;
  try {
    stat = lstat(owner);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`test runner: cannot inspect owner ${owner}: ${error.message}`);
  }
  if (!stat.isFile() || stat.nlink !== 1 || realpath(owner) !== owner) {
    throw new Error(`test runner: unsafe owner ${owner}`);
  }
  let record;
  try {
    record = JSON.parse(readFile(owner, 'utf8'));
  } catch (error) {
    throw new Error(`test runner: malformed owner ${owner}: ${error.message}`);
  }
  if (!exactKeys(record, ['version', 'kind', 'pidNamespace', 'worker'])
      || record.version !== 2 || record.kind !== OWNER_KIND
      || typeof record.pidNamespace !== 'string' || record.pidNamespace === ''
      || !exactKeys(record.worker, ['pid', 'starttime'])
      || !Number.isInteger(record.worker.pid) || record.worker.pid <= 0
      || !Number.isInteger(record.worker.starttime) || record.worker.starttime < 0) {
    throw new Error(`test runner: invalid owner ${owner}`);
  }
  return record;
}

export function reapSuiteRoots(tempRoot, {
  readdir = readdirSync, lstat = lstatSync, realpath = realpathSync,
  readFile = readFileSync, rm = rmSync, isAlive: alive = isAlive,
  pidNamespace = pidNamespaceOf,
} = {}) {
  const canonicalTemp = realpath(tempRoot);
  const currentNamespace = pidNamespace();
  for (const entry of readdir(canonicalTemp, { withFileTypes: true })) {
    const staging = entry.name.startsWith(STAGING_PREFIX);
    if (!staging && !entry.name.startsWith('familiar-suite-')) continue;
    const path = join(canonicalTemp, entry.name);
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) throw new Error(`test runner: unsafe suite root ${path}`);
      continue;
    }
    if (realpath(path) !== path) throw new Error(`test runner: unsafe suite root ${path}`);
    if (staging) {
      rm(path, { recursive: true, force: true });
      continue;
    }
    const owner = ownerIdentity(path, { lstat, realpath, readFile });
    if (owner && owner.pidNamespace === currentNamespace
        && !alive(owner.worker.pid, { starttime: owner.worker.starttime })) {
      rm(path, { recursive: true, force: true });
    }
  }
}

export function testInventory(root = process.cwd()) {
  const files = readdirSync(join(root, 'test'))
    .filter((name) => name.endsWith('.test.js')).sort()
    .map((name) => `test/${name}`);
  for (const integration of readdirSync(join(root, 'integrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    files.push(...readdirSync(join(root, 'integrations', integration))
      .filter((name) => name.endsWith('.test.mjs')).sort()
      .map((name) => `integrations/${integration}/${name}`));
  }
  return files;
}

export function testFiles(root = process.cwd(), mode = 'fast') {
  if (!['fast', 'slow'].includes(mode)) throw new Error(`unknown test mode: ${mode}`);
  return testInventory(root).filter((name) =>
    mode === 'slow' ? name.endsWith('.slow.test.js') || name.endsWith('.slow.test.mjs')
      : !name.endsWith('.slow.test.js') && !name.endsWith('.slow.test.mjs'));
}

export async function runSuite(files, {
  tmpdir: getTmpdir = tmpdir, mkdtemp = mkdtempSync, spawn: spawnChild = spawn,
  rm = rmSync, realpath = realpathSync, rename = renameSync, reap = reapSuiteRoots,
  startTime = startTimeOf, writeFile = writeFileSync, processEvents = process,
  readdir = readdirSync, lstat = lstatSync, readFile = readFileSync,
  isAlive: alive = isAlive, pidNamespace = pidNamespaceOf, pid = process.pid,
  acquireLease = acquireSuiteLease, releaseLease = releaseSuiteLease,
} = {}) {
  if (files.length === 0) throw new Error('no test files selected');
  const lease = await acquireLease();
  const handlers = new Map();
  let staging;
  let scratch;
  try {
    const canonicalTmp = realpath(getTmpdir());
    reap(canonicalTmp, {
      readdir, lstat, realpath, readFile, rm, isAlive: alive, pidNamespace,
    });
    const namespace = pidNamespace();
    const parentStarttime = startTime(pid);
    if (!Number.isInteger(parentStarttime)) {
      throw new Error(`test runner: cannot identify runner ${pid}`);
    }
    staging = mkdtemp(join(canonicalTmp, STAGING_PREFIX));
    writeFile(join(staging, OWNER), ownerBytes(namespace, pid, parentStarttime), { flag: 'wx' });
    scratch = join(canonicalTmp, basename(staging).slice(1));
    rename(staging, scratch);
    staging = undefined;

    const child = spawnChild('/bin/sh', [
      '-c', 'read -r ready <&3 || exit 1; exec 3<&-; exec "$@"', 'familiar-test-worker',
      process.execPath, '--test', ...files,
    ], {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      env: { ...process.env, TMPDIR: scratch },
    });
    const spawned = new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    const closed = new Promise((resolveClose, rejectClose) => {
      child.once('error', rejectClose);
      child.once('close', (code) => resolveClose(code ?? 1));
    });
    closed.catch(() => {});
    await spawned;
    const starttime = startTime(child.pid);
    if (!Number.isInteger(starttime)) {
      child.kill('SIGTERM');
      await closed;
      throw new Error(`test runner: cannot identify worker ${child.pid}`);
    }
    const nextOwner = join(scratch, `${OWNER}.next`);
    writeFile(nextOwner, ownerBytes(namespace, child.pid, starttime), { flag: 'wx' });
    rename(nextOwner, join(scratch, OWNER));
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      processEvents.on(signal, handler);
    }
    child.stdio[3].end('ready\n');
    return await closed;
  } finally {
    for (const [signal, handler] of handlers) processEvents.off(signal, handler);
    if (scratch) rm(scratch, { recursive: true, force: true });
    if (staging) rm(staging, { recursive: true, force: true });
    await releaseLease(lease);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [mode = 'fast', ...extra] = process.argv.slice(2);
  if (extra.length) {
    throw new Error('usage: test-runner.mjs [fast | slow]');
  }
  process.exitCode = await runSuite(testFiles(process.cwd(), mode));
}
