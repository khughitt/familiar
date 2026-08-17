// Real child-process worker for the cross-process lock exclusion tests
// (test/lock-multiprocess.test.js). Each invocation acquires the lock some
// number of times, and on every acquisition does a genuine
// read-delay-increment-write against a SHARED COUNTER FILE — not shared
// memory, so a broken lock shows up as a lost update in the file, the same
// way a broken lock would lose an update to agents.json in production.
//
// argv: lockPath counterPath iterations retries delayMs
import { readFile, writeFile } from 'node:fs/promises';
import { withLock } from '../../src/bus/lock.js';

const [, , lockPath, counterPath, iterationsArg, retriesArg, delayMsArg] = process.argv;

const iterations = Number.parseInt(iterationsArg, 10);
const retries = Number.parseInt(retriesArg, 10);
const delayMs = Number.parseInt(delayMsArg, 10);

async function readCounter() {
  try {
    return Number.parseInt(await readFile(counterPath, 'utf8'), 10);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function run() {
  for (let i = 0; i < iterations; i += 1) {
    await withLock(lockPath, async () => {
      const current = await readCounter();
      // Widen the race window: a broken lock needs time inside the critical
      // section for a second process to slip in and clobber this read.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(counterPath, String(current + 1));
    }, { retries, delayMs });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
