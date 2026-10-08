// The hook benchmark's CLI wrapper: `node bench-hook-cli.mjs <measured bin> <args...>`.
//
// Like tty-familiar.mjs it runs a real `familiar` in-process, with two differences. Every
// module is resolved from the MEASURED bin, never from this file's checkout: importing this
// checkout's proc.js would patch a different module instance from the one a detached baseline
// checkout loads. And it instruments the real execFile, so the benchmark can count and time
// the hook's Git children without changing what they return.
//
// The agent lookup is the one thing faked: the parent (the benchmark worker) stands in for a
// `claude` process with a terminal, so the hook resolves a live, stable owner. Test machinery
// only; production launchers and adapters are untouched.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { realpathSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const bin = realpathSync(process.argv[2]);
const args = process.argv.slice(3);
const binUrl = pathToFileURL(bin);

const { defaultProcessOps } = await import(new URL('../src/bus/proc.js', binUrl));
const parent = defaultProcessOps.recordOf(process.ppid);
defaultProcessOps.ancestors = () => [
  defaultProcessOps.recordOf(process.pid), { ...parent, comm: 'claude', tty: true },
];

// Children are tracked so a cancelled wrapper reaps what it started; Git runs are recorded
// for the benchmark. The promisified form keeps execFile's own stdout/stderr/error shape.
const children = new Set();
const gitRuns = [];
const childProcess = createRequire(import.meta.url)('node:child_process');
const realExecFile = childProcess.execFile;
const realPromised = realExecFile[promisify.custom];

function own(child) {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function execFile(...callArgs) {
  return own(realExecFile.apply(this, callArgs));
}
execFile[promisify.custom] = (file, argv, options) => {
  const started = performance.now();
  const promise = realPromised(file, argv, options);
  own(promise.child);
  const settle = (exit, signal) => {
    if (basename(String(file)) !== 'git') return;
    gitRuns.push({
      args: Array.isArray(argv) ? [...argv] : [],
      ms: performance.now() - started,
      exit,
      signal,
    });
  };
  promise.then(() => settle(0, null), (error) => settle(error.code ?? null, error.signal ?? null));
  return promise;
};
childProcess.execFile = execFile;
syncBuiltinESMExports();

let interrupted = false;
for (const [name, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.on(name, async () => {
    interrupted = true;
    await Promise.all([...children].map((child) => new Promise((resolve) => {
      child.once('close', resolve);
      child.kill('SIGKILL');
    })));
    process.exit(code);
  });
}

// Flushed only on a clean exit: an interrupted sample has no metrics to be mistaken for valid.
process.on('exit', () => {
  if (!interrupted && process.env.BENCH_GIT_LOG) {
    writeFileSync(process.env.BENCH_GIT_LOG, JSON.stringify(gitRuns));
  }
});

process.argv = [process.execPath, bin, ...args];
await import(binUrl.href);
