import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextSeq } from '../src/bus/seq.js';
import { readJson } from '../src/bus/store.js';

const statePaths = () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'seq-'));
  return { stateDir, seqPath: join(stateDir, 'events.seq'), transmitDir: join(stateDir, 'transmit') };
};

test('the counter starts at 1 and increments across sessions', async () => {
  const paths = statePaths();
  assert.equal(await nextSeq(paths), 1);
  assert.equal(await nextSeq(paths), 2);
  assert.deepEqual(await readJson(paths.seqPath), { seq: 2 });
});

test('a missing counter is seeded above every ledger it finds, so no ledger can outrank it', async () => {
  const paths = statePaths();
  mkdirSync(paths.transmitDir);
  writeFileSync(join(paths.transmitDir, 'a-0123456789abcdef.json'), JSON.stringify({ seq: 100, pid: 1, starttime: 1, held: null, ended: false }));
  writeFileSync(join(paths.transmitDir, 'b-0123456789abcdef.json'), JSON.stringify({ seq: 7, pid: 2, starttime: 1, held: null, ended: true }));
  writeFileSync(join(paths.transmitDir, 'not-a-ledger.lock'), 'x');
  assert.equal(await nextSeq(paths), 101);
});

test('a corrupt counter is an error, not a restart', async () => {
  const paths = statePaths();
  writeFileSync(paths.seqPath, '{');
  await assert.rejects(nextSeq(paths), /corrupt JSON/);
});
