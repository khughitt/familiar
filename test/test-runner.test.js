import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pidNamespaceOf, runSuite, testInventory, withSuiteLease,
} from '../tools/test-runner.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

test('inventory finds this test', () => {
  assert.ok(testInventory(REPO).includes('test/test-runner.test.js'));
});

test('Darwin suite lease holds the existing file lock around its callback', async () => {
  const calls = [];
  const startTimeOf = () => 10;
  const lockHolderAlive = () => true;
  const value = await withSuiteLease(async () => 'ran', {
    platform: 'darwin',
    tmpdir: () => '/private/tmp',
    uid: () => 501,
    withLock: async (path, fn, options) => {
      calls.push({ path, options });
      return fn();
    },
    processOps: { startTimeOf, lockHolderAlive },
    lockOptions: { retries: 7, staleMs: 1 },
  });

  assert.equal(value, 'ran');
  assert.equal(calls[0].path, '/private/tmp/familiar-test-suite-501.lock');
  assert.equal(calls[0].options.retries, 7);
  assert.equal(calls[0].options.staleMs, Infinity);
  assert.equal(calls[0].options.startTimeOf, startTimeOf);
  assert.equal(calls[0].options.isAlive, lockHolderAlive);
});

test('Darwin suite lease reports acquisition failure without claiming a live suite', async () => {
  const acquisition = new Error('lock retry budget exhausted');
  await assert.rejects(
    withSuiteLease(async () => {}, {
      platform: 'darwin',
      withLock: async () => { throw acquisition; },
      processOps: { startTimeOf: () => 10, lockHolderAlive: () => true },
    }),
    (error) => {
      assert.equal(error.message, 'test runner: could not acquire suite lease');
      assert.equal(error.cause, acquisition);
      assert.doesNotMatch(error.message, /another suite|live/i);
      return true;
    }
  );
});

test('Darwin suite lease propagates callback errors unchanged', async () => {
  const callbackError = new Error('callback failed');
  await assert.rejects(
    withSuiteLease(async () => { throw callbackError; }, {
      platform: 'darwin',
      withLock: async (_path, fn) => fn(),
      processOps: { startTimeOf: () => 10, lockHolderAlive: () => true },
    }),
    (error) => error === callbackError
  );
});

test('Darwin suite lease reclaims a dead lock behind a crashed stale guard', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-suite-lease-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'familiar-test-suite-501.lock');
  writeFileSync(lockPath, '2147483647:10:dead');
  writeFileSync(`${lockPath}.reclaim`, '');
  const old = new Date(Date.now() - 6_000);
  utimesSync(`${lockPath}.reclaim`, old, old);

  let ran = false;
  await withSuiteLease(async () => { ran = true; }, {
    platform: 'darwin',
    tmpdir: () => dir,
    uid: () => 501,
    processOps: { startTimeOf: () => 10, lockHolderAlive: () => false },
  });

  assert.equal(ran, true);
});

test('Darwin suite lease refuses a held live lock with a generic error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-suite-lease-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'familiar-test-suite-501.lock');
  writeFileSync(lockPath, `${process.pid}:10:held`);

  await assert.rejects(
    withSuiteLease(async () => {}, {
      platform: 'darwin',
      tmpdir: () => dir,
      uid: () => 501,
      processOps: { startTimeOf: () => 10, lockHolderAlive: () => true },
      lockOptions: { retries: 1, delayMs: 0 },
    }),
    { message: 'test runner: could not acquire suite lease' }
  );
});

test('owner scope is explicit on every supported platform', () => {
  assert.equal(pidNamespaceOf({
    platform: 'linux',
    readlink: (path) => path === '/proc/self/ns/pid' ? 'pid:[42]' : null,
  }), 'pid:[42]');
  assert.equal(pidNamespaceOf({ platform: 'darwin' }), 'darwin-host');
  assert.throws(
    () => pidNamespaceOf({ platform: 'win32' }),
    /test runner: unsupported platform "win32"/
  );
});

test('runSuite reads a newly spawned worker identity outside the invocation snapshot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-suite-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const childPid = 4242;
  const startCalls = [];
  const freshCalls = [];
  const processOps = {
    startTimeOf(pid) {
      startCalls.push(pid);
      return pid === process.pid ? 100 : null;
    },
    freshStartTimeOf(pid) {
      freshCalls.push(pid);
      return pid === childPid ? 200 : null;
    },
    isAlive: () => true,
    lockHolderAlive: () => true,
  };
  const writes = [];
  const child = new EventEmitter();
  child.pid = childPid;
  child.kill = () => {};
  child.stdio = [null, null, null, {
    end() { queueMicrotask(() => child.emit('close', 0)); },
  }];
  const processEvents = new EventEmitter();

  const code = await runSuite(['test/fake.test.js'], {
    tmpdir: () => dir,
    reap: () => {},
    processOps,
    pidNamespace: () => 'darwin-host',
    processEvents,
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    writeFile(path, bytes, options) {
      writes.push({ path, bytes });
      writeFileSync(path, bytes, options);
    },
    suiteLease: async (fn, deps) => {
      assert.equal(deps.processOps, processOps);
      return fn();
    },
  });

  const workerOwner = JSON.parse(String(
    writes.find(({ path }) => path.endsWith('.familiar-suite-owner.json.next')).bytes
  ));
  assert.equal(code, 0);
  assert.deepEqual(startCalls, [process.pid]);
  assert.deepEqual(freshCalls, [childPid]);
  assert.deepEqual(workerOwner, {
    version: 2,
    kind: 'familiar-test-suite',
    pidNamespace: 'darwin-host',
    worker: { pid: childPid, starttime: 200 },
  });
});

test('runSuite terminates and settles a spawned worker when fresh identity lookup throws', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-suite-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identityError = new Error('targeted process read failed');
  let handshakeDestroyed = false;
  let killed = false;
  let settled = false;
  const child = new EventEmitter();
  child.pid = 4242;
  child.kill = (signal) => {
    assert.equal(signal, 'SIGTERM');
    killed = true;
    queueMicrotask(() => child.emit('close', null));
  };
  child.stdio = [null, null, null, {
    destroy() { handshakeDestroyed = true; },
  }];
  child.once('close', () => { settled = true; });

  await assert.rejects(
    runSuite(['test/fake.test.js'], {
      tmpdir: () => dir,
      reap: () => {},
      processOps: {
        startTimeOf: () => 100,
        freshStartTimeOf: () => { throw identityError; },
        isAlive: () => true,
        lockHolderAlive: () => true,
      },
      pidNamespace: () => 'darwin-host',
      processEvents: new EventEmitter(),
      spawn: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      suiteLease: async (fn) => fn(),
    }),
    (error) => error === identityError
  );

  assert.equal(handshakeDestroyed, true);
  assert.equal(killed, true);
  assert.equal(settled, true);
});
