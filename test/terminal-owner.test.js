import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../src/bus/store.js';
import { terminalOwnerPaths, decideClaim, withTerminal, pruneTerminalOwners } from '../src/render/term/terminal-owner.js';
import { transmitLockOptions } from '../src/render/term/ledger.js';

const terminal = { pid: 4242, starttime: 123 };
const lockOptions = transmitLockOptions({ ownerAlive: () => true, startTimeOf: () => 1 });
const setup = (t) => {
  const transmitDir = mkdtempSync(join(tmpdir(), 'terminal-owner-'));
  t.after(() => rmSync(transmitDir, { recursive: true, force: true }));
  return transmitDir;
};

test('claims require a strictly newer sequence, while settle requires the recorded session', () => {
  for (const [current, claim, expected] of [
    [null, { sessionId: 'A', seq: 1 }, 'own'],
    [null, { sessionId: 'A', seq: 0 }, 'own'],
    [{ sessionId: 'A', seq: -2 }, { sessionId: 'B', seq: -1 }, 'own'],
    [{ sessionId: 'A', seq: 10 }, { sessionId: 'A', seq: 11 }, 'own'],
    [{ sessionId: 'A', seq: 10 }, { sessionId: 'B', seq: 11 }, 'own'],
    [{ sessionId: 'A', seq: 10 }, { sessionId: 'A', seq: 10 }, 'superseded'],
    [{ sessionId: 'A', seq: 10 }, { sessionId: 'B', seq: 10 }, 'superseded'],
    [{ sessionId: 'A', seq: 10 }, { sessionId: 'A', seq: 9 }, 'superseded'],
    [null, { sessionId: 'A', seq: null }, 'superseded'],
    [{ sessionId: 'A', seq: 10 }, { sessionId: 'B', seq: null }, 'superseded'],
    [{ sessionId: 'A', seq: 10 }, { sessionId: 'A', seq: null }, 'own'],
  ]) assert.equal(decideClaim(current, claim), expected);
});

test('the sequence never decreases', async (t) => {
  const transmitDir = setup(t);
  const { entryPath, lockPath } = terminalOwnerPaths(transmitDir, terminal);
  assert.equal(entryPath, join(transmitDir, 'terminals', '4242-123.json'));
  assert.equal(lockPath, join(transmitDir, 'terminals', '4242-123.lock'));
  const run = (sessionId, seq, fn) => withTerminal({ transmitDir, terminal, sessionId, seq, lockOptions }, fn);
  await run('B', 40, async () => {
    assert.deepEqual(await readJson(entryPath), { sessionId: 'B', seq: 40 }, 'ownership is published before the section');
  });
  let called = 0;
  for (const [id, seq] of [['B', 20], ['A', 30], ['B', 40]]) {
    assert.deepEqual(await run(id, seq, () => { called += 1; }), { kind: 'superseded', reason: 'terminal' });
  }
  assert.equal(called, 0);
  assert.deepEqual(await readJson(entryPath), { sessionId: 'B', seq: 40 });
});

test('settle proceeds only for the recorded owner without changing its sequence', async (t) => {
  const transmitDir = setup(t);
  const run = (sessionId, seq, fn) => withTerminal({ transmitDir, terminal, sessionId, seq, lockOptions }, fn);
  let called = 0;
  assert.deepEqual(await run('A', null, () => { called += 1; }), { kind: 'superseded', reason: 'terminal' });
  await run('B', 40, () => {});
  assert.deepEqual(await run('A', null, () => { called += 1; }), { kind: 'superseded', reason: 'terminal' });
  assert.equal(await run('B', null, () => { called += 1; return 'settled'; }), 'settled');
  assert.equal(called, 1);
  assert.deepEqual(await readJson(terminalOwnerPaths(transmitDir, terminal).entryPath), { sessionId: 'B', seq: 40 });
});

test('pruneTerminalOwners removes a dead owner and keeps a live one', async (t) => {
  const transmitDir = setup(t);
  const dead = terminalOwnerPaths(transmitDir, { pid: 10, starttime: 100 }).entryPath;
  const live = terminalOwnerPaths(transmitDir, { pid: 20, starttime: 200 }).entryPath;
  await writeJsonAtomic(dead, { sessionId: 'A', seq: 1 });
  await writeJsonAtomic(live, { sessionId: 'B', seq: 2 });
  const asked = [];
  const result = await pruneTerminalOwners({
    transmitDir,
    ownerAlive: (pid, { starttime }) => { asked.push([pid, starttime]); return pid === 20; },
  });
  assert.deepEqual(result, { removed: ['10-100'] });
  assert.deepEqual(asked.sort((a, b) => a[0] - b[0]), [[10, 100], [20, 200]]);
  assert.equal(await readJson(dead), null);
  assert.deepEqual(await readJson(live), { sessionId: 'B', seq: 2 });
});

test('missing terminal ownership directory is nothing to prune', async (t) => {
  assert.deepEqual(await pruneTerminalOwners({ transmitDir: setup(t), ownerAlive: () => false }), { removed: [] });
});


test('terminal paths reject handles that could escape the ownership directory', () => {
  for (const handle of [
    { pid: '../42', starttime: 1 }, { pid: 42, starttime: '../1' },
    { pid: 0, starttime: 1 }, { pid: 42, starttime: null },
  ]) assert.throws(() => terminalOwnerPaths('/transmit', handle), /pid and starttime/);
  for (const seq of [undefined, 1.5, NaN]) {
    assert.throws(() => decideClaim(null, { sessionId: 'A', seq }), /seq/);
  }
});
