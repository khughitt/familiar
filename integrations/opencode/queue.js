// SERIALISED, because fire-and-forget spawns RACE FOR FAMILIAR'S LOCK.
//
// Every event spawns a `familiar hook`, and every one of those takes the bus lock. Spawn them
// without waiting and the order they COMMIT is the order the kernel happened to schedule them --
// so a `working` can land after the `done` that followed it, and STAY there, and the cat lies
// until the next transition. The queue is not an optimisation. It is what makes the order on the
// bus the order that happened.
//
// `run` and `report` are arguments, not imports: this module does no I/O, so a test can hand it
// functions that resolve or reject on command and assert on ORDER, which is the only thing here
// worth asserting on.
//
// BOTH of them may be async, and BOTH of them may fail. See the double try/catch below -- the
// second one is not decoration.

export function createQueue({ run, report }) {
  // The tail is a promise that ALWAYS SETTLES -- see the catch below. That is the whole mechanism
  // by which a failure cannot poison the queue.
  let tail = Promise.resolve();
  let closed = false;

  // `event` is a STRING, already decided. It must not be a thunk that computes the level later:
  // the window's sets are mutable and shared, so a fold deferred to run-time reads them as they
  // are THEN, and a burst of events collapses onto the last one. The intermediate states -- the
  // `permission.pending` the user is actually waiting on -- would vanish. Fold in the handler,
  // enqueue the string. (queue.test.mjs proves this.)
  function push(event) {
    if (closed) throw new Error(`opencode: the queue is closed — refusing to enqueue ${event}`);

    tail = tail.then(async () => {
      try {
        await run(event);
      } catch (err) {
        // ISOLATED AT THE JOB BOUNDARY. A queue that stops on the first failure fails silently and
        // permanently: one EAGAIN and the cat freezes for the rest of the session with nothing on
        // screen to say so.
        //
        // SKIPPED, NOT RETRIED. A retry lands out of order, which is the one thing this queue
        // exists to prevent. And the plugin does not deduplicate, so the next opencode event
        // re-asserts the truth: a dropped transition is self-healing; a reordered one is not.
        try {
          // AND THE REPORTER IS ISOLATED TOO, which is not paranoia -- it is the same bug one level
          // in. `report` writes familiar's opencode error log, a file that can itself fail (a full
          // disk, a vanished dir). Let it throw (or reject -- hence the await) and its rejection
          // BECOMES THE TAIL: every later job stops, and dispose never runs. The bus record is
          // stranded and the terminal stays tinted, because the thing whose job is to report failures
          // failed. There is nowhere left to complain to, so we swallow it -- the alternative is
          // losing dispose, and dispose is the one job that must always run.
          await report(`familiar: opencode hook "${event}" failed — ${err?.message ?? err}`);
        } catch { /* the reporter itself is broken. Nothing to do but keep the queue alive. */ }
      }
    });

    return tail;
  }

  // dispose: queued LAST, and it runs even if every job before it failed -- which it does for
  // free, because every job settles. Its purpose is to take the record off the bus and reset the
  // terminal, and a window that skips that because an earlier spawn failed leaves a stranded bus
  // record and terminal state the user has to fix by hand.
  async function close(event) {
    if (closed) throw new Error('opencode: the queue is already closed');
    const done = push(event);
    closed = true;
    await done;
  }

  return { push, close };
}
