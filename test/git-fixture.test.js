import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureGitEnv, git, seedRepo } from './fixtures/git-worktree.mjs';

test('Git fixtures inherit neither hook redirections nor host config and credentials', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-git-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unrelated = join(root, 'unrelated');
  const config = join(root, 'host.gitconfig');
  writeFileSync(config, '[fixture]\n  marker = host\n');
  const poison = {
    GIT_DIR: join(unrelated, '.git'), GIT_WORK_TREE: unrelated,
    GIT_INDEX_FILE: join(unrelated, '.git', 'index'),
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fixture.marker', GIT_CONFIG_VALUE_0: 'hook',
    FIXTURE_SECRET: 'fake-credential', XDG_CONFIG_HOME: root,
  };
  const previous = new Map(Object.keys(poison).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, poison);

  const childEnv = fixtureGitEnv(root);
  assert.equal('FIXTURE_SECRET' in childEnv, false);
  assert.equal('XDG_CONFIG_HOME' in childEnv, false);
  assert.equal('GIT_DIR' in childEnv, false);
  assert.equal('GIT_CONFIG_COUNT' in childEnv, false);
  assert.equal(childEnv.HOME, root);
  assert.equal(childEnv.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(childEnv.GIT_CONFIG_NOSYSTEM, '1');

  seedRepo(unrelated);
  const before = readFileSync(join(unrelated, '.git', 'config'), 'utf8');
  const fixture = seedRepo(join(root, 'fixture'));
  git(fixture, ['remote', 'add', 'origin', 'https://example.invalid/fixture.git']);
  assert.equal(git(fixture, ['rev-parse', '--show-toplevel']), fixture);
  assert.equal(git(fixture, ['rev-parse', '--absolute-git-dir']), join(fixture, '.git'));
  assert.equal(git(fixture, ['config', '--global', '--list']), '');
  assert.equal(git(unrelated, ['remote']), '');
  assert.equal(readFileSync(join(unrelated, '.git', 'config'), 'utf8'), before);
  assert.equal(readFileSync(config, 'utf8'), '[fixture]\n  marker = host\n');
});
