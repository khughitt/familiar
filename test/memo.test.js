import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoizeFor } from '../src/bus/memo.js';

test('memoizeFor answers from the cache inside the window and asks again after it', () => {
  let clock = 0;
  const answers = [true, false];
  let calls = 0;
  const alive = memoizeFor((pid, { starttime }) => { calls += 1; return answers.shift(); }, 1000, { now: () => clock });
  for (let i = 0; i < 50; i += 1) assert.equal(alive(7, { starttime: 1 }), true);
  assert.equal(calls, 1, 'fifty attempts inside one second cost one liveness call');
  clock = 1000;
  assert.equal(alive(7, { starttime: 1 }), false);
  assert.equal(calls, 2);
});

test('memoizeFor keys on pid AND starttime', () => {
  let calls = 0;
  const alive = memoizeFor(() => { calls += 1; return true; }, 1000, { now: () => 0 });
  alive(7, { starttime: 1 });
  alive(7, { starttime: 2 });
  assert.equal(calls, 2);
});
