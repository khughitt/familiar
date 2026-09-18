import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLedgers } from '../src/render/term/ledger-prune.js';
import { fileLedger, ledgerPaths, ledgerName, stamp } from '../src/render/term/ledger.js';

const setup = async () => {
  const transmitDir = join(mkdtempSync(join(tmpdir(), 'prune-')), 'transmit');
  const write = async (sessionId, owner, extra = {}) => {
    const { entryPath } = ledgerPaths(transmitDir, sessionId);
    await fileLedger(entryPath).write(stamp({ held: null, ...extra }, { seq: 1, owner }));
    return entryPath;
  };
  return { transmitDir, write };
};

test('only sessions absent from the agents snapshot are candidates, and only dead ones are removed', async () => {
  const { transmitDir, write } = await setup();
  const live = await write('live', { pid: 1, starttime: 1 });
  const ended = await write('ended-alive', { pid: 2, starttime: 2 }, { ended: true });
  const dead = await write('ended-dead', { pid: 3, starttime: 3 }, { ended: true });
  const asked = [];
  const result = await pruneLedgers({
    transmitDir,
    agents: { live: { pid: 1, starttime: 1 } },
    ownerAlive: (pid, { starttime }) => { asked.push(pid); return pid !== 3; },
    startTimeOf: () => 1,
  });
  assert.deepEqual(asked.sort(), [2, 3], 'the live session was never asked about');
  assert.deepEqual(result.removed, [ledgerName('ended-dead')]);
  assert.ok(existsSync(live) && existsSync(ended) && !existsSync(dead));
});

test('a candidate whose lock is busy is skipped this pass, not removed', async () => {
  const { transmitDir, write } = await setup();
  const path = await write('busy', { pid: 9, starttime: 9 });
  const result = await pruneLedgers({
    transmitDir, agents: {}, ownerAlive: () => false, startTimeOf: () => 1,
    lockWith: async () => { throw new Error('could not acquire lock'); },
  });
  assert.deepEqual(result, { removed: [], skipped: [ledgerName('busy')] });
  assert.ok(existsSync(path));
});

test('a missing transmit dir is nothing to prune', async () => {
  assert.deepEqual(await pruneLedgers({ transmitDir: '/nonexistent/transmit', agents: {}, ownerAlive: () => false, startTimeOf: () => 1 }), { removed: [], skipped: [] });
});
