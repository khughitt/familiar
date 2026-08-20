import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneDead } from '../src/bus/prune.js';
import { isAlive, startTimeOf } from '../src/bus/proc.js';

const agents = {
  live: { sessionId: 'live', pid: 100, starttime: 111, state: 'working' },
  dead: { sessionId: 'dead', pid: 200, starttime: 222, state: 'needs-input' },
};

test('drops records whose agent process is gone — portable, no compositor needed', () => {
  const kept = pruneDead(agents, { isAlive: (pid) => pid === 100 });
  assert.deepEqual(Object.keys(kept), ['live']);
});

test('does not mutate the input', () => {
  pruneDead(agents, { isAlive: () => false });
  assert.deepEqual(Object.keys(agents), ['live', 'dead']);
});

test('the record hands its STARTTIME to the liveness check, not just its pid', () => {
  const asked = [];
  pruneDead(agents, {
    isAlive: (pid, opts) => { asked.push([pid, opts?.starttime]); return true; },
  });
  // Without this, a recycled pid keeps a dead record on the bus forever, and
  // isAlive has no way to know.
  assert.deepEqual(asked, [[100, 111], [200, 222]]);
});

test('a record on a RECYCLED pid is pruned — against the REAL isAlive and real /proc', () => {
  // No stub. The pid is genuinely alive (it is this test process), so kill(pid, 0)
  // says "alive" and the old prune kept the record forever. The starttime says
  // otherwise, and it is right: this record does not name this process.
  const phantom = {
    stale: { sessionId: 'stale', pid: process.pid, starttime: startTimeOf(process.pid) + 1 },
    real: { sessionId: 'real', pid: process.pid, starttime: startTimeOf(process.pid) },
  };
  assert.deepEqual(Object.keys(pruneDead(phantom, { isAlive })), ['real']);
});

test('the `pid: 1` phantom, which survived every prune there has ever been, is pruned', () => {
  // NOT A HARDCODED STARTTIME. pid 1's is clock ticks since boot, which makes it a SMALL
  // INTEGER -- 5 on a workstation -- so any literal picked to mean "wrong" is a value some
  // machine genuinely has. A CI runner whose init started 42 ticks in judged this ghost
  // ALIVE and failed the suite: the literal was wrong, not the prune. Derived from the real
  // value, exactly as the recycled-pid test above derives its own, it cannot collide.
  const boot = startTimeOf(1);
  assert.ok(Number.isInteger(boot), 'no starttime for pid 1 — the assertion below proves nothing');
  const initd = { ghost: { sessionId: 'ghost', pid: 1, starttime: boot + 1 } };
  assert.deepEqual(pruneDead(initd, { isAlive }), {});
});
