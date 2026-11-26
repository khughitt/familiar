// Runs many short, independent subprocesses a bounded number at a time, for a test that
// would otherwise wait on each in turn. Results come back in input order with spawnSync's
// fields (status, signal, stdout, stderr, and error when the spawn itself failed). Each
// child's stdin is empty, as spawnSync's is when it is given no input.
import { spawn } from 'node:child_process';

export async function spawnAll(jobs, { limit = 8 } = {}) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await spawnOne(jobs[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

function spawnOne({ command, args, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ status: null, signal: null, stdout, stderr, error }));
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
