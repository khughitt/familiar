// The stage refresher: run detached by the status line (`node stagerefresh.js <taskId>
// <worktree> <cwd>`), never on the render path and never typed by a person, so it is an
// internal script and not a `familiar` command. It runs `tasks` and flow's `flow-state`,
// picks the token with stageToken, and writes a per-(task, worktree) cache stamped with the
// mtimes of the two files the stage depends on: the task records dir and tasks' claim store,
// which holds parks. The render side re-stats those two and refreshes when either moves.
//
// It runs with no dependency preflight, so it imports node builtins and familiar's relative
// modules only (test/stagerefresh.test.js walks the graph).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../../bus/paths.js';
import { writeJsonAtomic } from '../../bus/store.js';
import { ABSENT } from './hud.js';
import { stageToken } from './stage.js';

export const REFRESH_TIMEOUT_MS = 5000;
export const LOCK_STALE_MS = 30_000;
export const REFRESHER_PATH = fileURLToPath(import.meta.url);

const TASK_ID = /^[a-z][a-z0-9-]*-[0-9a-f]{6}$/;
const PREFIX = /^[a-z][a-z0-9-]*$/;

// tasks' ClaimStore::path_with (tasks src/claims.rs): XDG_STATE_HOME when set, even empty
// (an empty base is PathBuf::from(""), a relative path), else $HOME/.local/state. This is
// tasks' private layout; the runtime guard below and test/host/tasks-park-store.mjs keep the
// prediction honest.
export function parkStorePath(prefix, env) {
  let base;
  if (env.XDG_STATE_HOME !== undefined) base = env.XDG_STATE_HOME;
  else if (env.HOME !== undefined) base = join(env.HOME, '.local', 'state');
  else throw new Error('neither XDG_STATE_HOME nor HOME is set');
  return join(base, 'tasks', 'claims', `${prefix}.toml`);
}

// Full precision, as a string: two writes within one millisecond must still differ.
export function mtimeStamp(path) {
  try {
    return statSync(path, { bigint: true }).mtimeNs.toString();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function cachePaths(stateDir, taskId, worktree) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new Error(`stage cache: not a task id: ${JSON.stringify(taskId)}`);
  }
  if (typeof worktree !== 'string' || worktree === '') {
    throw new Error(`stage cache: not a worktree path: ${JSON.stringify(worktree)}`);
  }
  const stem = join(stateDir, 'statusline', 'tasks',
    `${taskId}.${createHash('sha256').update(worktree).digest('hex').slice(0, 12)}`);
  return { file: `${stem}.json`, lock: `${stem}.lock` };
}

const defaultPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;   // alive, someone else's
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

// Held when it names a live pid and was taken within LOCK_STALE_MS of now, either way: a lock
// stamped far in the future (a clock step) would otherwise hold forever. A lock that does not
// parse yet (taken but not written) or no longer parses is judged by its file's mtime alone.
export function lockHeld(lockPath, now, pidAlive = defaultPidAlive) {
  let text;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  let lock = null;
  try {
    lock = JSON.parse(text);
  } catch {
    lock = null;
  }
  const at = typeof lock?.at === 'string' ? Date.parse(lock.at) : NaN;
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0 || Number.isNaN(at)) {
    let mtimeMs;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    return Math.abs(now - mtimeMs) <= LOCK_STALE_MS;
  }
  return Math.abs(now - at) <= LOCK_STALE_MS && pidAlive(lock.pid);
}

// Exclusive create. A held lock answers false; a broken one is removed and taken once more
// (losing that race to another refresher answers false too).
function takeLock(lockPath, now) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const content = `${JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, content, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (attempt > 0 || lockHeld(lockPath, now)) return false;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

// The production runner. Exit status, a timeout and a missing program are outcomes; any
// other spawn failure (a signal, EACCES) is an exit without a code.
function defaultRun(cmd, args, { cwd, env, timeoutMs }) {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, error: null };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    if (error.code === 'ENOENT') return { code: null, stdout: '', error: 'ENOENT' };
    if (error.code === 'ETIMEDOUT') return { code: null, stdout, error: 'ETIMEDOUT' };
    return { code: typeof error.status === 'number' ? error.status : null, stdout, error: null };
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

class TasksFault extends Error {}

// One `tasks` read: its parsed JSON, or a TasksFault naming the command (spec rule 2).
function tasksJson(run, label, args, opts, shape) {
  const r = run('tasks', args, opts);
  if (r.error === 'ENOENT') throw new TasksFault(`tasks ${label}: tasks is not installed`);
  if (r.error === 'ETIMEDOUT') throw new TasksFault(`tasks ${label}: timed out after ${opts.timeoutMs} ms`);
  if (r.code !== 0) throw new TasksFault(`tasks ${label}: exited ${r.code ?? 'without an exit code'}`);
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new TasksFault(`tasks ${label}: unparseable output`);
  }
  const value = shape(json);
  if (value === undefined) throw new TasksFault(`tasks ${label}: unexpected JSON shape`);
  return value;
}

const whereShape = (json) => {
  const p = json?.project;
  if (!isObject(p) || typeof p.records !== 'string' || !isAbsolute(p.records)) return undefined;
  if (typeof p.prefix !== 'string' || !PREFIX.test(p.prefix)) return undefined;
  return { records: p.records, prefix: p.prefix };
};

const showShape = (json) => (isObject(json?.task) && typeof json.task.status === 'string'
  ? json.task.status : undefined);

const parkShape = (taskId) => (json) => {
  if (!Array.isArray(json?.tasks)) return undefined;
  const entry = json.tasks.find((t) => isObject(t) && t.id === taskId);
  if (entry === undefined) return null;
  const park = entry.park;
  if (!isObject(park) || typeof park.at !== 'string' || Number.isNaN(Date.parse(park.at))) return undefined;
  // stageToken renders these: anything but a string or absence would print as `[object Object]`.
  for (const key of ['reason', 'waiting_on']) {
    if (key in park && typeof park[key] !== 'string') return undefined;
  }
  return park;
};

function flowResult(run, flowStatePath, taskId, opts) {
  if (flowStatePath === null) return { missing: true };
  const r = run(flowStatePath, [taskId, '--json', '--no-git'], { ...opts, env: { ...opts.env, TASKS_FORMAT: 'json' } });
  if (r.error === 'ENOENT') return { missing: true };
  if (r.error === 'ETIMEDOUT') return { timedOut: true };
  return { code: r.code, stdout: r.stdout };
}

// A worktree that is gone, or whose path now runs through a file (ENOTDIR, which
// throwIfNoEntry also answers undefined for), falls back to the session's cwd.
const isDir = (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

const NO_SOURCES = { tasksDir: null, tasksDirMtimeNs: null, parkStore: null, parkStoreMtimeNs: null };

export async function refreshStage({
  taskId, worktree, cwd, stateDir, env,
  // With no HOME there is no default: flow-state counts as missing (rule 6). A relative
  // `.agents/bin/flow-state` would resolve in the run directory, a repository's own tree.
  flowStatePath = env.HOME ? join(env.HOME, '.agents', 'bin', 'flow-state') : null,
  run = defaultRun, now = Date.now(), timeoutMs = REFRESH_TIMEOUT_MS,
}) {
  const { file, lock } = cachePaths(stateDir, taskId, worktree);
  if (!takeLock(lock, now)) return null;
  try {
    const cache = {
      taskId, worktree, ...NO_SOURCES, stage: ABSENT, fault: null, refreshedAt: new Date(now).toISOString(),
    };
    let token;
    try {
      const opts = { cwd: isDir(worktree) ? worktree : cwd, env, timeoutMs };
      const where = tasksJson(run, 'where', ['where', '--json'], opts, whereShape);
      let parkStore;
      try {
        parkStore = parkStorePath(where.prefix, env);
      } catch (error) {
        throw new TasksFault(`park store: ${error.message}`);
      }
      const tasksDir = join(where.records, 'tasks');
      // Both stamps before any other read: a write during the refresh leaves this cache stale.
      Object.assign(cache, {
        tasksDir, tasksDirMtimeNs: mtimeStamp(tasksDir), parkStore, parkStoreMtimeNs: mtimeStamp(parkStore),
      });
      const status = tasksJson(run, 'show', ['show', taskId, '--json'], opts, showShape);
      const park = tasksJson(run, 'list --parked', ['list', '--parked', '--json'], opts, parkShape(taskId));
      // A park wins over every flow-state outcome (rules 3-5), so flow-state runs only unparked.
      const flow = park ? null : flowResult(run, flowStatePath, taskId, opts);
      token = stageToken({ tasks: { status }, park, flow });
      if (park) {
        // tasks saves the store after it takes the park's time, so a store older than the
        // park (or none at all) means tasks keeps parks somewhere this path does not predict.
        const stamp = mtimeStamp(parkStore);
        if (stamp === null || Number(BigInt(stamp) / 1_000_000_000n) < Date.parse(park.at) / 1000) {
          token = { ...token, fault: `park store: ${parkStore} is older than ${taskId}'s park; tasks may have moved it` };
        }
      }
    } catch (error) {
      // Every failure drops the source paths and stamps, so the render side retries it after
      // its 30 s back-off instead of waiting for a source to move. A tasks read failure goes
      // through the precedence table (rule 2); anything else (a stat failing other than
      // ENOENT, a runner that throws) is recorded as a refresh fault with the same `—`.
      Object.assign(cache, NO_SOURCES);
      token = error instanceof TasksFault
        ? stageToken({ tasks: { fault: error.message }, park: null, flow: null })
        : { stage: ABSENT, fault: `refresh: ${error.message}` };
    }
    Object.assign(cache, { stage: token.stage, fault: token.fault });
    await writeJsonAtomic(file, cache);
    return cache;
  } finally {
    try {
      unlinkSync(lock);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

const isEntry = () => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(REFRESHER_PATH);
  } catch {
    return false;
  }
};

// Detached with stdio ignored: nothing to print to, and a fault belongs in the cache, where
// the status line reports it. Whatever happens, exit 0.
if (isEntry()) {
  const [taskId, worktree, cwd] = process.argv.slice(2);
  try {
    await refreshStage({ taskId, worktree, cwd, stateDir: paths(process.env).stateDir, env: process.env });
  } catch {
    // Nothing to report to: see above.
  }
  process.exit(0);
}
