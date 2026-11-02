#!/usr/bin/env node
// Host check, outside the suite's file pattern: does the installed `tasks` keep parks where
// the stage refresher predicts (parkStorePath), and does a refresh end to end show the park?
// The suite runs against a fake `tasks` by design and CI has no real one, so run this before
// merging a refresher change and after a tasks upgrade:
//
//   node test/host/tasks-park-store.mjs
//
// It runs the installed `tasks` in a fresh HOME, XDG_CONFIG_HOME and XDG_STATE_HOME with Git
// configuration off, so it never touches a real task store or the user's Git config.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { mtimeStamp, parkStorePath, refreshStage } from '../../src/render/term/stagerefresh.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-host-check-')));
const dir = (name) => {
  const p = join(base, name);
  mkdirSync(p);
  return p;
};
const inside = (parent, p) => {
  const rel = relative(parent, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Built key by key: PATH is the host's, to reach the installed tasks; nothing else inherited,
// so no GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE from a hook can redirect a write.
const env = {
  PATH: process.env.PATH,
  HOME: dir('home'),
  XDG_CONFIG_HOME: dir('config'),
  XDG_STATE_HOME: dir('state'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'familiar host check',
  GIT_AUTHOR_EMAIL: 'host-check@example.invalid',
  GIT_COMMITTER_NAME: 'familiar host check',
  GIT_COMMITTER_EMAIL: 'host-check@example.invalid',
  TASKS_SESSION: 'familiar-host-check',
  TASKS_OWNER: 'familiar-host-check',
  TASKS_FORMAT: 'json',
};
const project = dir('project');
const stateDir = dir('familiar-state');

const sh = (cmd, args) => execFileSync(cmd, args, {
  cwd: project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
});
const tasks = (...args) => sh('tasks', args);
const tasksJson = (...args) => JSON.parse(tasks(...args, '--json'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let code = 1;
try {
  sh('git', ['init', '--quiet']);
  const top = sh('git', ['rev-parse', '--show-toplevel']).trim();
  const gitDir = sh('git', ['rev-parse', '--absolute-git-dir']).trim();
  assert.equal(realpathSync(top), project, `git toplevel ${top} is not the fixture ${project}`);
  assert.ok(inside(project, realpathSync(gitDir)), `git dir ${gitDir} lies outside the fixture ${project}`);

  const version = tasks('--version').trim().replace(/^tasks\s+/, '');
  tasksJson('init', '--prefix', 'zz');
  const added = tasksJson('add', 'probe', '-p', '2');
  const taskId = added.task?.id ?? added.id;
  assert.match(String(taskId), /^zz-[0-9a-f]{6}$/, `tasks add printed no task id: ${JSON.stringify(added)}`);
  tasksJson('start', taskId);

  const store = parkStorePath('zz', env);
  assert.ok(inside(env.XDG_STATE_HOME, store), `predicted store ${store} is outside the isolated state dir`);
  const before = mtimeStamp(store);
  await sleep(1100);
  tasksJson('park', taskId, 'next', '--reason', 'review');
  assert.ok(existsSync(store), `tasks park wrote no store at ${store}`);
  assert.notEqual(mtimeStamp(store), before, `tasks park did not move ${store}`);

  const parked = tasksJson('list', '--parked');
  const entry = parked.tasks.find((t) => t.id === taskId);
  assert.equal(entry?.park?.reason, 'review', `list --parked: ${JSON.stringify(parked)}`);

  const cache = await refreshStage({ taskId, worktree: project, cwd: project, stateDir, env });
  assert.equal(cache?.stage, 'parked: review', `refresh: ${JSON.stringify(cache)}`);
  assert.equal(cache.fault, null, `refresh: ${JSON.stringify(cache)}`);
  assert.equal(cache.parkStore, store);

  console.log(`host check: tasks ${version} park store at ${store}: ok`);
  code = 0;
} catch (error) {
  console.error(`host check: failed: ${error.message.trim()}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(code);
