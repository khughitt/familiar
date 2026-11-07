// Real-Git fixtures for worktree tests. Commands use argv, a bounded
// timeout and a command-local hooks path; the environment drops every inherited GIT_* binding
// and the system/global config, so a developer's Git setup cannot change a fixture.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function fixtureGitEnv(home) {
  return {
    PATH: process.env.PATH, HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

// Only the final LF is removed: a path may itself end in a newline or a space.
export function git(root, args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', env: fixtureGitEnv(root),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
}

export function initRepo(root, { gitDir = null, branch = 'main' } = {}) {
  mkdirSync(root, { recursive: true });
  if (gitDir !== null) mkdirSync(dirname(gitDir), { recursive: true });
  git(root, ['init', '-q', '-b', branch,
    ...(gitDir === null ? [] : ['--separate-git-dir', gitDir])]);
  // Init is isolated; prove ownership before subsequent fixture writes.
  const physicalRoot = realpathSync(root);
  assert.equal(git(root, ['rev-parse', '--show-toplevel']), physicalRoot);
  assert.equal(git(root, ['rev-parse', '--absolute-git-dir']),
    gitDir === null ? join(physicalRoot, '.git') : realpathSync(gitDir));
  return physicalRoot;
}

export function seedRepo(root, options) {
  const physicalRoot = initRepo(root, options);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '--allow-empty', '-m', 'fixture']);
  return physicalRoot;
}

export const addWorktree = (main, target) => {
  git(main, ['worktree', 'add', '-q', '--detach', target]);
  return realpathSync(target);
};
