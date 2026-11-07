import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertHexColor } from '../protocol/color.js';

export const TASKS_TIMEOUT_MS = 2_000;
// `root` is the registered root `tasks resolve` names: where the project's family file
// lives (src/bus/family.js), never the checkout, which may be a worktree (spec §5.3).
export const NO_PROJECT = Object.freeze({
  prefix: null, color: null, root: null, warnings: Object.freeze([]),
});

export async function lookupProjectColor(dir, {
  exec = promisify(execFile), timeoutMs = TASKS_TIMEOUT_MS,
} = {}) {
  if (dir === null) return NO_PROJECT;
  const fault = (message) => new Error(`tasks resolve ${dir}: ${message}`);
  let stdout;
  try {
    ({ stdout } = await exec('tasks', ['resolve', '--json', dir], {
      timeout: timeoutMs, killSignal: 'SIGKILL',
    }));
  } catch (error) {
    if (error.killed === true || error.signal === 'SIGKILL') {
      throw Object.assign(fault(`timed out after ${timeoutMs}ms`), { code: 'FAMILIAR_TASKS_TIMEOUT' });
    }
    if (error.code === 'ENOENT') return NO_PROJECT;
    const detail = (error.stderr?.trim() || error.stdout?.trim())
      ?.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
    throw fault(`exited ${error.code}${detail ? `: ${detail}` : ''}`);
  }

  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw fault('not JSON');
  }
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw fault('expected an object');
  }
  if (!Array.isArray(response.results)) throw fault('results must be an array');
  if (response.results.length !== 1) {
    throw fault(`expected one result, got ${response.results.length}`);
  }
  const { warnings } = response;
  if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== 'string')) {
    throw fault('warnings must be an array of strings');
  }
  const result = response.results[0];
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw fault('expected a result object');
  }
  if (result.status === 'unregistered') return { prefix: null, color: null, root: null, warnings };
  if (result.status !== 'resolved') throw fault(`status ${JSON.stringify(result.status)}`);
  if (typeof result.prefix !== 'string' || result.prefix === '') {
    throw fault('resolved project must have a non-empty prefix');
  }
  if (typeof result.root !== 'string' || result.root === '') {
    throw fault('resolved project must have a non-empty root');
  }
  const { prefix, root } = result;
  if (!Object.hasOwn(result, 'color')) return { prefix, color: null, root, warnings };
  try {
    assertHexColor(result.color);
  } catch (error) {
    throw fault(error.message);
  }
  return { prefix, color: result.color, root, warnings: [] };
}
