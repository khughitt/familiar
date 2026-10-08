// Real-Git fixtures for worktree tests and the hook benchmark. Commands use argv, a bounded
// timeout and a command-local hooks path; the environment drops every inherited GIT_* binding
// and the system/global config, so a developer's Git setup cannot change a fixture.
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';

export function fixtureGitEnv(over = {}) {
  const env = { ...process.env, ...over };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

// Only the final LF is removed: a path may itself end in a newline or a space.
export function git(root, args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', env: fixtureGitEnv(),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
}

export function seedRepo(root, { gitDir = null } = {}) {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main',
    ...(gitDir === null ? [] : ['--separate-git-dir', gitDir])]);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '--allow-empty', '-m', 'fixture']);
  return realpathSync(root);
}

export const addWorktree = (main, target) => {
  git(main, ['worktree', 'add', '-q', '--detach', target]);
  return realpathSync(target);
};
