import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from './queue.js';
import { createWindow } from './window.js';

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

// The `await null` inside the `run` functions below is LOAD-BEARING, and a type checker will tell
// you it is a no-op. It is a no-op to the TYPE and not to the SCHEDULE: it yields a microtask, which
// is the only way an unserialized queue could interleave its jobs and be caught doing it. Delete it
// and these tests keep passing against a queue that runs everything concurrently.

test('jobs run in enqueue order, one at a time', async () => {
  const seen = [];
  const q = createQueue({ run: async (e) => { await null; seen.push(e); }, report: () => {} });
  q.push('session.busy');
  q.push('permission.pending');
  await q.push('session.idle');
  assert.deepEqual(seen, ['session.busy', 'permission.pending', 'session.idle']);
});

// THE RACE THIS MODULE EXISTS TO CLOSE, and the one a reviewer should look hardest at.
//
// The window's three sets are MUTABLE and SHARED. A job that computed the level when it RAN would
// read them as they are THEN -- so a burst of events collapses onto whatever the sets happen to
// say once the queue drains, and every intermediate state is silently lost. Below, the sets end
// up EMPTY (the permission was answered, the session went idle), so a run-time fold would report
// `session.idle` four times and never once say `permission.pending` -- the window would never ask
// for the approval it was waiting on.
//
// The fix is that the fold happens SYNCHRONOUSLY in the handler and only the resulting STRING is
// enqueued. This test is what proves it.
test('the level is captured when the event arrives, not when the job runs', async () => {
  const seen = [];
  const g = gate();
  const q = createQueue({ run: async (e) => { seen.push(e); await g.p; }, report: () => {} });
  const w = createWindow();

  // exactly what plugin.js's handler does: fold, then enqueue the already-decided string
  const handle = (event) => { w.apply(event); return q.push(w.level()); };

  handle({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } });
  handle({ type: 'permission.asked', properties: { id: 'r1', sessionID: 's1' } });
  handle({ type: 'permission.replied', properties: { permissionID: 'r1' } });
  const last = handle({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } });

  assert.equal(w.level(), 'session.idle');   // the sets are drained by the time anything runs
  g.open();
  await last;

  assert.deepEqual(seen, ['session.busy', 'permission.pending', 'session.busy', 'session.idle']);
});

test('a job that rejects is reported, naming the event and the reason', async () => {
  const reported = [];
  const q = createQueue({
    run: async (e) => { if (e === 'session.busy') throw new Error('spawn EAGAIN'); },
    report: (m) => reported.push(m),
  });
  await q.push('session.busy');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /session\.busy/);
  assert.match(reported[0], /spawn EAGAIN/);
});

// A queue that stops on the first failure fails SILENTLY AND PERMANENTLY: one EAGAIN and the
// window's cat freezes on whatever it last said, for the rest of the session, with nothing on
// screen to say so.
test('a failure does not poison the queue — later events still run, in order', async () => {
  const seen = [];
  const q = createQueue({
    run: async (e) => { seen.push(e); if (e === 'session.busy') throw new Error('boom'); },
    report: () => {},
  });
  q.push('session.busy');
  q.push('permission.pending');
  await q.push('session.idle');
  assert.deepEqual(seen, ['session.busy', 'permission.pending', 'session.idle']);
});

// A failed event is SKIPPED, never retried. A retry would land out of order, which is the one
// thing the queue exists to prevent -- and a stale `working` re-landing after a `done` is a worse
// lie than a missed transition. Since the plugin does not deduplicate, the NEXT opencode event
// re-asserts the truth anyway: a dropped transition is self-healing, a reordered one is not.
test('a failed event is skipped, not retried', async () => {
  const seen = [];
  const q = createQueue({
    run: async (e) => { seen.push(e); throw new Error('always fails'); },
    report: () => {},
  });
  await q.push('session.busy');
  assert.deepEqual(seen, ['session.busy']);   // once. not twice, not forever.
});

test('dispose runs last', async () => {
  const seen = [];
  const q = createQueue({ run: async (e) => { await null; seen.push(e); }, report: () => {} });
  q.push('session.busy');
  q.push('session.idle');
  await q.close('dispose');
  assert.deepEqual(seen, ['session.busy', 'session.idle', 'dispose']);
});

// Its whole purpose is to take the record off the bus and reset the terminal. A window that skips
// cleanup because an earlier spawn failed leaves a stranded bus record and terminal state the
// user has to fix by hand.
test('dispose runs even if every job before it failed', async () => {
  const seen = [];
  const q = createQueue({
    run: async (e) => { seen.push(e); if (e !== 'dispose') throw new Error('boom'); },
    report: () => {},
  });
  q.push('session.busy');
  q.push('permission.pending');
  await q.close('dispose');
  assert.deepEqual(seen, ['session.busy', 'permission.pending', 'dispose']);
});

test('nothing may be enqueued after dispose', async () => {
  const q = createQueue({ run: async () => {}, report: () => {} });
  await q.close('dispose');
  assert.throws(() => q.push('session.busy'), /closed/);
});

// THE REPORTER IS INSIDE THE JOB, SO THE REPORTER CAN POISON THE QUEUE.
//
// `report` appends to familiar's opencode error log, a file that can itself fail. If it throws --
// or returns a rejecting promise -- and it is not isolated, that rejection becomes the tail, every
// later job stops, and DISPOSE NEVER RUNS. The record is stranded on the bus and the terminal
// stays tinted. The failure would be hiding inside the very thing whose job is to report failures,
// and it would surface exactly when it hurts most: at shutdown.
test('a reporter that throws does not stop the queue', async () => {
  const seen = [];
  const q = createQueue({
    run: async (e) => { seen.push(e); if (e === 'session.busy') throw new Error('boom'); },
    report: () => { throw new Error('the toast itself failed'); },
  });
  q.push('session.busy');       // fails -> report() is called -> report() throws
  await q.push('session.idle'); // must still run
  assert.deepEqual(seen, ['session.busy', 'session.idle']);
});

test('a reporter that REJECTS does not stop the queue, and dispose still runs', async () => {
  const seen = [];
  const q = createQueue({
    run: async (e) => { seen.push(e); if (e !== 'dispose') throw new Error('boom'); },
    report: async () => { throw new Error('toast rejected during teardown'); },
  });
  q.push('session.busy');
  await q.close('dispose');
  assert.deepEqual(seen, ['session.busy', 'dispose']);
});
