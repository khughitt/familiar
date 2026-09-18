import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  ledgerName, ledgerPaths, fileLedger, memoryLedger, stamp, inherit,
  transmitLockOptions, EMPTY_ENTRY, TRANSMIT_LOCK_RETRIES,
} from '../src/render/term/ledger.js';

const OWNER = { pid: 4242, starttime: 987654 };

test('ledgerName is one path component inside transmit/, whatever the session id says', () => {
  const dir = '/state/transmit';
  for (const id of ['../agents', '/etc/passwd', 'a\0b', '..', 'x'.repeat(300), 'plain-id_1']) {
    const name = ledgerName(id);
    assert.doesNotMatch(name, /[/\\\0]/, `${JSON.stringify(id)} -> ${name}`);
    assert.ok(name.length <= 40 + 1 + 16);
    const { entryPath, lockPath } = ledgerPaths(dir, id);
    assert.equal(dirname(entryPath), dir);
    assert.equal(dirname(lockPath), dir);
    assert.notEqual(resolve(entryPath), '/state/agents.json');
    assert.notEqual(resolve(entryPath), '/state/intent.json');
    assert.ok(resolve(entryPath).startsWith(`${dir}/`));
  }
});

test('ledgerName keeps distinct ids distinct after sanitising and is readable', () => {
  assert.notEqual(ledgerName('a/b'), ledgerName('a_b'));
  assert.match(ledgerName('session-42'), /^session-42-[0-9a-f]{16}$/);
  assert.throws(() => ledgerName(''), TypeError);
  assert.throws(() => ledgerName(undefined), TypeError);
});

test('fileLedger reads EMPTY_ENTRY for a missing file and round-trips a write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const ledger = fileLedger(join(dir, 'transmit', 'x.json'));
  assert.deepEqual(await ledger.read(), EMPTY_ENTRY);
  const entry = stamp({ held: { transport: 'direct' } }, { seq: 3, owner: OWNER });
  await ledger.write(entry);
  assert.deepEqual(await ledger.read(), entry);
  await ledger.remove();
  assert.deepEqual(await ledger.read(), EMPTY_ENTRY);
  await ledger.remove();
});

test('stamp puts the owner identity and the seq on every entry', () => {
  assert.deepEqual(stamp({}, { seq: 9, owner: OWNER }), { seq: 9, pid: 4242, starttime: 987654, held: null, ended: false });
  assert.deepEqual(stamp({ held: null, ended: true }, { seq: 9, owner: OWNER }), { seq: 9, pid: 4242, starttime: 987654, held: null, ended: true });
});

test('inherit carries held only across the same owner', () => {
  const held = { transport: 'direct', capability: 'kitty-animation', id: 1, intent: { state: 'working' } };
  const entry = stamp({ held }, { seq: 1, owner: OWNER });
  assert.equal(inherit(entry, OWNER), held);
  assert.equal(inherit(entry, { pid: 4242, starttime: 1 }), null, 'same pid, new incarnation');
  assert.equal(inherit(entry, { pid: 5, starttime: 987654 }), null);
  assert.equal(inherit(EMPTY_ENTRY, OWNER), null);
});

test('transmitLockOptions never reclaims by age and memoizes liveness for a second', () => {
  let clock = 0;
  let calls = 0;
  const options = transmitLockOptions({ ownerAlive: () => { calls += 1; return true; }, startTimeOf: () => 1, now: () => clock });
  assert.equal(options.staleMs, Infinity);
  assert.equal(options.retries, TRANSMIT_LOCK_RETRIES);
  for (let i = 0; i < 50; i += 1) options.isAlive(7, { starttime: 1 });
  assert.equal(calls, 1);
  clock = 1000;
  options.isAlive(7, { starttime: 1 });
  assert.equal(calls, 2);
});

test('memoryLedger records every write for tests', async () => {
  const ledger = memoryLedger();
  assert.deepEqual(await ledger.read(), EMPTY_ENTRY);
  await ledger.write({ seq: 1 });
  await ledger.write({ seq: 2 });
  assert.deepEqual(ledger.writes.map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(ledger.entry, { seq: 2 });
});
