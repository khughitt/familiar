// The detached refresher: it runs `tasks` and flow-state off the render path and leaves a
// per-(task, worktree) cache stamped with the mtimes of the two files a stage depends on.
// Every subprocess here is a shell fake in a test-owned dir, run with an env built key by key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { REFRESH_TIMEOUT_MS, parkStorePath, refreshStage } from '../src/render/term/stagerefresh.js';
import {
  LOCK_STALE_MS, REFRESHER_PATH, cachePaths, lockHeld, mtimeStamp, readStage,
} from '../src/render/term/stagecache.js';
import { importGraph } from './fixtures/import-graph.mjs';

const ID = 'fam-8f0f2b';
const FAKE = (root, name) => `#!/bin/sh
printf '%s|%s|%s\\n' "${name} $*" "$(pwd)" "\${TASKS_FORMAT-unset}" >> '${root}/log'
case "$*" in
  "where --json") key=where ;;
  "show ${ID} --json") key=show ;;
  "list --parked --json") key=list ;;
  "${ID} --json --no-git") key=flow ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
r='${root}/resp'
[ -f "$r/$key.hook" ] && . "$r/$key.hook"
[ -f "$r/$key.json" ] && cat "$r/$key.json"
code=0
[ -f "$r/$key.code" ] && read code < "$r/$key.code"
exit "$code"
`;

// A fixture: fake `tasks` on PATH, fake flow-state where the refresher looks by default,
// a records dir, a worktree and a session cwd.
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stagerefresh-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const state = join(root, 'state');
  const flowDir = join(home, '.agents', 'bin');
  const records = join(root, 'records');
  const tasksDir = join(records, 'tasks');
  const worktree = join(root, 'worktree');
  const cwd = join(root, 'cwd');
  const stateDir = join(root, 'familiar-state');
  for (const d of [bin, flowDir, tasksDir, worktree, cwd, join(root, 'resp'), state]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'tasks'), FAKE(root, 'tasks'));
  chmodSync(join(bin, 'tasks'), 0o755);
  writeFileSync(join(flowDir, 'flow-state'), FAKE(root, 'flow-state'));
  chmodSync(join(flowDir, 'flow-state'), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_STATE_HOME: state };
  const parkStore = join(state, 'tasks', 'claims', 'fam.toml');
  const respond = (key, { json, code, hook } = {}) => {
    if (json !== undefined) writeFileSync(join(root, 'resp', `${key}.json`), typeof json === 'string' ? json : JSON.stringify(json));
    if (code !== undefined) writeFileSync(join(root, 'resp', `${key}.code`), `${code}\n`);
    if (hook !== undefined) writeFileSync(join(root, 'resp', `${key}.hook`), `${hook}\n`);
  };
  const log = () => (existsSync(join(root, 'log')) ? readFileSync(join(root, 'log'), 'utf8').trim().split('\n') : []);
  // The happy defaults: a doing task, nothing parked, flow says designed.
  respond('where', { json: { project: { prefix: 'fam', records }, holds_records: true, warnings: [] } });
  respond('show', { json: { task: { id: ID, status: 'doing' } } });
  respond('list', { json: { tasks: [] } });
  respond('flow', { json: { state: 'designed' } });
  const refresh = (over = {}) => refreshStage({ taskId: ID, worktree, cwd, stateDir, env, ...over });
  return { root, bin, home, state, records, tasksDir, worktree, cwd, stateDir, env, parkStore, respond, log, refresh };
}

const assertNoSources = (cache) => assert.deepEqual(
  [cache.tasksDir, cache.parkStore, cache.tasksDirMtimeNs, cache.parkStoreMtimeNs], [null, null, null, null],
  JSON.stringify(cache),
);

const writeStore = (path, mtimeSec) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# claims\n');
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
};

test('the constants are the spec\'s', () => {
  assert.equal(REFRESH_TIMEOUT_MS, 5000);
  assert.equal(LOCK_STALE_MS, 30_000);
  assert.equal(REFRESHER_PATH, fileURLToPath(new URL('../src/render/term/stagerefresh.js', import.meta.url)));
});

test('parkStorePath follows tasks\' rule', () => {
  assert.equal(parkStorePath('fam', { XDG_STATE_HOME: '/x', HOME: '/h' }), '/x/tasks/claims/fam.toml');
  assert.equal(parkStorePath('fam', { XDG_STATE_HOME: '', HOME: '/h' }), 'tasks/claims/fam.toml');
  assert.equal(parkStorePath('fam', { HOME: '/h' }), '/h/.local/state/tasks/claims/fam.toml');
  assert.throws(() => parkStorePath('fam', {}), /^Error: neither XDG_STATE_HOME nor HOME is set$/);
});

test('mtimeStamp is a nanosecond string, null only for a missing file', (t) => {
  const f = fixture(t);
  const p = join(f.root, 'stamped');
  assert.equal(mtimeStamp(p), null);
  writeFileSync(p, '');
  assert.match(mtimeStamp(p), /^\d+$/);
  assert.throws(() => mtimeStamp(join(p, 'under-a-file')), { code: 'ENOTDIR' });
});

test('cachePaths names the file for the task and a hash of its worktree', () => {
  const a = cachePaths('/s', ID, '/w/one');
  assert.match(a.file, new RegExp(`^/s/statusline/tasks/${ID}\\.[0-9a-f]{12}\\.json$`));
  assert.equal(a.lock, a.file.replace(/\.json$/, '.lock'));
  assert.notEqual(cachePaths('/s', ID, '/w/two').file, a.file);
  for (const bad of ['../etc-8f0f2b', 'fam', 'Fam-8f0f2b', 'fam-8f0f2', 'fam/x-8f0f2b', '']) {
    assert.throws(() => cachePaths('/s', bad, '/w/one'), /task id/);
  }
});

test('lockHeld: a fresh lock naming a live pid is held; stale, dead or missing is not', (t) => {
  const f = fixture(t);
  const lock = join(f.root, 'x.lock');
  const now = Date.now();
  const alive = () => true;
  assert.equal(lockHeld(lock, now, alive), false);
  writeFileSync(lock, JSON.stringify({ pid: 1234, at: new Date(now - 1000).toISOString() }));
  assert.equal(lockHeld(lock, now, alive), true);
  assert.equal(lockHeld(lock, now, () => false), false);
  assert.equal(lockHeld(lock, now + LOCK_STALE_MS + 1000, alive), false);
  assert.equal(lockHeld(lock, now - LOCK_STALE_MS - 2000, alive), false, 'a lock from the far future is broken too');
});

test('the stamps are taken before any read', async (t) => {
  const f = fixture(t);
  writeStore(f.parkStore);
  f.respond('show', { hook: `touch '${join(f.tasksDir, 'written-during-refresh.md')}'` });
  const cache = await f.refresh();
  assert.equal(cache.tasksDir, f.tasksDir);
  assert.equal(cache.parkStore, f.parkStore);
  assert.notEqual(cache.tasksDirMtimeNs, mtimeStamp(f.tasksDir));
  assert.equal(cache.parkStoreMtimeNs, mtimeStamp(f.parkStore));
  assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: 'designed', fault: null });
  const written = JSON.parse(readFileSync(cachePaths(f.stateDir, ID, f.worktree).file, 'utf8'));
  assert.deepEqual(written, cache);
  assert.deepEqual(Object.keys(cache).sort(), [
    'fault', 'parkStore', 'parkStoreMtimeNs', 'refreshedAt', 'stage', 'taskId', 'tasksDir', 'tasksDirMtimeNs', 'worktree',
  ]);
  assert.equal(cache.taskId, ID);
  assert.equal(cache.worktree, f.worktree);
});

test('a missing park store stamps null', async (t) => {
  const f = fixture(t);
  const cache = await f.refresh();
  assert.equal(cache.parkStore, f.parkStore);
  assert.equal(cache.parkStoreMtimeNs, null);
  assert.equal(cache.stage, 'designed');
});

// Review M2: an empty XDG_STATE_HOME (or a relative HOME) gives tasks a relative store path,
// which tasks resolves in its run directory. The refresher records it resolved there, so the
// render, running in another directory, stats the same file and agrees the cache is fresh.
test('a relative park store is recorded resolved against the run directory', async (t) => {
  const f = fixture(t);
  const cases = [
    ['an empty XDG_STATE_HOME', { PATH: f.env.PATH, HOME: f.home, XDG_STATE_HOME: '' }, ['tasks', 'claims', 'fam.toml']],
    ['a relative HOME', { PATH: f.env.PATH, HOME: 'rel-home' }, ['rel-home', '.local', 'state', 'tasks', 'claims', 'fam.toml']],
  ];
  for (const [label, env, parts] of cases) {
    for (const runDir of [f.worktree, f.cwd]) {
      if (runDir === f.cwd) rmSync(f.worktree, { recursive: true, force: true });
      const store = join(runDir, ...parts);
      writeStore(store);
      const cache = await f.refresh({ env });
      assert.equal(cache.parkStore, store, `${label}, run in ${runDir}`);
      assert.equal(cache.parkStoreMtimeNs, mtimeStamp(store), label);
      const spawns = [];
      const out = readStage({
        stateDir: f.stateDir, task: { id: ID, others: 0, worktree: f.worktree }, cwd: f.cwd,
        now: Date.parse(cache.refreshedAt), spawnRefresher: (a) => spawns.push(a), pidAlive: () => true,
      });
      assert.deepEqual(out, { stage: cache.stage, fault: null }, label);
      assert.deepEqual(spawns, [], `${label}: the render agrees the cache is fresh`);
    }
    mkdirSync(f.worktree, { recursive: true });
  }
});

test('a park comes from list --parked', async (t) => {
  const f = fixture(t);
  const at = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  f.respond('list', { json: { tasks: [
    { id: 'fam-000000', park: { at, next_step: 'x', waiting_on: 'user' } },
    { id: ID, park: { at, next_step: 'y', waiting_on: 'agent', reason: 'review' } },
  ] } });
  writeStore(f.parkStore);
  const cache = await f.refresh();
  assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: 'parked: review', fault: null });
});

test('a park newer than the predicted store is a fault, and still shows', async (t) => {
  const f = fixture(t);
  const atSec = Math.floor(Date.now() / 1000) - 60;
  const at = new Date(atSec * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  f.respond('list', { json: { tasks: [{ id: ID, park: { at, next_step: 'y', waiting_on: 'agent', reason: 'review' } }] } });
  writeStore(f.parkStore, atSec - 10);
  let cache = await f.refresh();
  assert.equal(cache.stage, 'parked: review');
  assert.match(cache.fault, /^park store: .* tasks may have moved it$/);
  assert.equal(cache.fault, `park store: ${f.parkStore} is older than ${ID}'s park; tasks may have moved it`);
  rmSync(f.parkStore);
  cache = await f.refresh();
  assert.equal(cache.stage, 'parked: review');
  assert.match(cache.fault, /^park store: .* tasks may have moved it$/);
});

test('flow-state runs from the worktree with TASKS_FORMAT=json and --no-git', async (t) => {
  const f = fixture(t);
  await f.refresh();
  const lines = f.log();
  assert.deepEqual(lines, [
    `tasks where --json|${f.worktree}|unset`,
    `tasks show ${ID} --json|${f.worktree}|unset`,
    `tasks list --parked --json|${f.worktree}|unset`,
    `flow-state ${ID} --json --no-git|${f.worktree}|json`,
  ]);
});

test('an explicit flowStatePath is used, and a missing one gives the tasks status', async (t) => {
  const f = fixture(t);
  const cache = await f.refresh({ flowStatePath: join(f.root, 'no-such-flow-state') });
  assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: 'doing', fault: null });
  assert.equal(f.log().some((l) => l.startsWith('flow-state')), false);
});

test('a gone worktree falls back to cwd', async (t) => {
  const f = fixture(t);
  rmSync(f.worktree, { recursive: true });
  const cache = await f.refresh();
  assert.ok(f.log().length > 0);
  for (const line of f.log()) assert.equal(line.split('|')[1], f.cwd);
  assert.equal(cache.worktree, f.worktree, 'the cache keeps the key, not the run directory');
});

test('a failed where writes a cache without source paths', async (t) => {
  const f = fixture(t);
  f.respond('where', { code: 1 });
  const cache = await f.refresh();
  assert.equal(cache.tasksDir, null);
  assert.equal(cache.parkStore, null);
  assert.equal(cache.tasksDirMtimeNs, null);
  assert.equal(cache.parkStoreMtimeNs, null);
  assert.equal(cache.stage, '—');
  assert.match(cache.fault, /tasks where/);
  assert.ok(existsSync(cachePaths(f.stateDir, ID, f.worktree).file));
});

test('wrong-shaped tasks JSON is a tasks fault', async (t) => {
  const cases = [
    ['where', 'not json'],
    ['where', { project: { prefix: 'fam' } }],
    ['where', { project: { records: '/r', prefix: 'a/b' } }],
    ['show', { task: { id: ID, status: 7 } }],
    ['show', { task: null }],
    ['list', { tasks: {} }],
    ['list', { tasks: [{ id: ID, park: 'yes' }] }],
    ['list', { tasks: [{ id: ID, park: { reason: 'review' } }] }],
    ['list', { tasks: [{ id: ID, park: { at: '2026-11-01T00:00:00Z', reason: { why: 'review' } } }] }],
    ['list', { tasks: [{ id: ID, park: { at: '2026-11-01T00:00:00Z', reason: null } }] }],
    ['list', { tasks: [{ id: ID, park: { at: '2026-11-01T00:00:00Z', waiting_on: 5 } }] }],
  ];
  for (const [key, json] of cases) {
    const f = fixture(t);
    writeStore(f.parkStore);
    f.respond(key, { json });
    const cache = await f.refresh();
    assert.equal(cache.stage, '—', `${key}: ${JSON.stringify(json)}`);
    assert.match(cache.fault, new RegExp(`^tasks ${key === 'list' ? 'list --parked' : key}: `), cache.fault);
    assertNoSources(cache);
  }
});

test('a failing show is a tasks fault and runs neither list nor flow-state', async (t) => {
  const f = fixture(t);
  f.respond('show', { code: 2 });
  const cache = await f.refresh();
  assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: '—', fault: 'tasks show: exited 2' });
  assert.equal(f.log().length, 2);
  assertNoSources(cache);
});

test('every tasks fault writes the cache without source paths, so the 30 s retry covers it', async (t) => {
  const f = fixture(t);
  writeStore(f.parkStore);
  f.respond('list', { hook: 'exec sleep 10' });
  const cache = await f.refresh({ timeoutMs: 200 });
  assert.match(cache.fault, /^tasks list --parked: timed out/);
  assertNoSources(cache);
  assertNoSources(JSON.parse(readFileSync(cachePaths(f.stateDir, ID, f.worktree).file, 'utf8')));
});

test('with no HOME and no flowStatePath, flow-state is missing, never a relative path', async (t) => {
  const f = fixture(t);
  // A repository-controlled script where a relative .agents/bin/flow-state would resolve.
  const planted = join(f.worktree, '.agents', 'bin', 'flow-state');
  const marker = join(f.root, 'planted-ran');
  mkdirSync(dirname(planted), { recursive: true });
  writeFileSync(planted, `#!/bin/sh\ntouch '${marker}'\necho '{"state":"closed"}'\n`);
  chmodSync(planted, 0o755);
  const env = { PATH: f.env.PATH, XDG_STATE_HOME: f.state };
  for (const cwd of [f.worktree, f.root]) {
    const cache = await refreshStage({ taskId: ID, worktree: f.worktree, cwd, stateDir: f.stateDir, env });
    assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: 'doing', fault: null });
  }
  assert.equal(existsSync(marker), false);
  assert.equal(f.log().some((l) => l.startsWith('flow-state')), false);
});

test('an unexpected error after the lock writes a failed cache and releases the lock', async (t) => {
  const f = fixture(t);
  const { file, lock } = cachePaths(f.stateDir, ID, f.worktree);
  const boom = () => { throw new Error('boom'); };
  let cache = await f.refresh({ run: boom });
  assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: '—', fault: 'refresh: boom' });
  assertNoSources(cache);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), cache);
  assert.equal(existsSync(lock), false);
  // A stat that fails with something other than ENOENT: records is a file, so tasks/ is ENOTDIR.
  const recordsFile = join(f.root, 'records-is-a-file');
  writeFileSync(recordsFile, '');
  f.respond('where', { json: { project: { prefix: 'fam', records: recordsFile } } });
  cache = await f.refresh();
  assert.equal(cache.stage, '—');
  assert.match(cache.fault, /^refresh: .*ENOTDIR/);
  assertNoSources(cache);
  assert.equal(existsSync(lock), false);
});

test('a worktree under a file (ENOTDIR) falls back to cwd, as a gone one does', async (t) => {
  const f = fixture(t);
  const file = join(f.root, 'plain-file');
  writeFileSync(file, '');
  const worktree = join(file, 'wt');
  const cache = await f.refresh({ worktree });
  assert.equal(cache.stage, 'designed');
  for (const line of f.log()) assert.equal(line.split('|')[1], f.cwd);
});

test('a failed cache write rejects and still releases the lock', async (t) => {
  const f = fixture(t);
  const { file, lock } = cachePaths(f.stateDir, ID, f.worktree);
  mkdirSync(file, { recursive: true });   // rename over a directory fails
  await assert.rejects(f.refresh(), /EISDIR|ENOTEMPTY|EEXIST/);
  assert.equal(existsSync(lock), false);
});

test('a failing flow-state is gate? with a fault; a park wins over it', async (t) => {
  const f = fixture(t);
  f.respond('flow', { code: 1 });
  let cache = await f.refresh();
  assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: 'gate?', fault: 'flow-state: exited 1' });
  const at = new Date(Date.now() - 60_000).toISOString();
  f.respond('list', { json: { tasks: [{ id: ID, park: { at, waiting_on: 'user' } }] } });
  writeStore(f.parkStore);
  cache = await f.refresh();
  assert.deepEqual({ stage: cache.stage, fault: cache.fault }, { stage: 'parked: you', fault: null });
});

test('the cache is named for the task and its worktree', async (t) => {
  const f = fixture(t);
  const other = join(f.root, 'worktree-two');
  mkdirSync(other);
  await f.refresh();
  await f.refresh({ worktree: other });
  const one = cachePaths(f.stateDir, ID, f.worktree).file;
  const two = cachePaths(f.stateDir, ID, other).file;
  assert.notEqual(one, two);
  assert.equal(JSON.parse(readFileSync(one, 'utf8')).worktree, f.worktree);
  assert.equal(JSON.parse(readFileSync(two, 'utf8')).worktree, other);
});

test('a held lock runs nothing', async (t) => {
  const f = fixture(t);
  const { lock, file } = cachePaths(f.stateDir, ID, f.worktree);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  assert.equal(await f.refresh(), null);
  assert.deepEqual(f.log(), []);
  assert.equal(existsSync(file), false);
  assert.ok(existsSync(lock), 'another refresher\'s lock is left alone');
});

test('a lock older than LOCK_STALE_MS or naming a dead pid is broken', async (t) => {
  const f = fixture(t);
  const { lock } = cachePaths(f.stateDir, ID, f.worktree);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString() }));
  assert.equal((await f.refresh()).stage, 'designed');
  assert.equal(existsSync(lock), false);
  const dead = spawnSync('/bin/true', [], { env: { PATH: '/usr/bin:/bin' } }).pid;
  writeFileSync(lock, JSON.stringify({ pid: dead, at: new Date().toISOString() }));
  assert.equal((await f.refresh()).stage, 'designed');
  assert.equal(existsSync(lock), false);
});

test('a hanging tasks is killed', async (t) => {
  const f = fixture(t);
  f.respond('where', { hook: 'exec sleep 10' });
  const started = Date.now();
  const cache = await f.refresh({ timeoutMs: 200 });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(cache.stage, '—');
  assert.match(cache.fault, /timed out/);
});

test('the lock is released after a failure', async (t) => {
  const f = fixture(t);
  const { lock } = cachePaths(f.stateDir, ID, f.worktree);
  f.respond('where', { code: 1 });
  await f.refresh();
  assert.equal(existsSync(lock), false);
  const run = () => { throw new Error('boom'); };
  assert.equal((await f.refresh({ run })).fault, 'refresh: boom');
  assert.equal(existsSync(lock), false);
});

test('the script entry refreshes and prints nothing', (t) => {
  const f = fixture(t);
  const env = { PATH: f.env.PATH, HOME: f.home, XDG_STATE_HOME: f.state, FAMILIAR_STATE_DIR: f.stateDir };
  const r = spawnSync(process.execPath, [REFRESHER_PATH, ID, f.worktree, f.cwd], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  const cache = JSON.parse(readFileSync(cachePaths(f.stateDir, ID, f.worktree).file, 'utf8'));
  assert.equal(cache.stage, 'designed');
  // A bad invocation still exits 0 and prints nothing: faults live in caches, not output.
  const bad = spawnSync(process.execPath, [REFRESHER_PATH, 'not-an-id'], { env, encoding: 'utf8' });
  assert.deepEqual([bad.status, bad.stdout, bad.stderr], [0, '', '']);
});

test('the refresher imports only builtins and relative modules', () => {
  const { files, bare } = importGraph(REFRESHER_PATH);
  // The walk reaches the render side's module, whose cache layout the refresher shares.
  const lean = fileURLToPath(new URL('../src/render/term/stagecache.js', import.meta.url));
  assert.ok(files.has(lean), [...files].join('\n'));
  assert.deepEqual(bare, []);
});
