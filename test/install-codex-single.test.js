import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadThemePack } from 'familiar-theme';
import {
  applyCodexProjectSync, planCodexProjectForPath, planCodexProjectSync,
} from '../src/install/codex.js';
import { addWorktree, git, seedRepo } from './fixtures/git-worktree.mjs';

const THEME = await loadThemePack(
  fileURLToPath(new URL('./fixtures/theme-slots', import.meta.url)));

// `git rev-parse --show-toplevel` reports the PHYSICAL path, so resolve the root
// the way gitContext would rather than trusting the temp path we were handed.
function repo(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `familiar-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin',
    `git@github.com:example/${name}.git`], { encoding: 'utf8' });
  return spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' }).stdout.trim();
}

test('an unmanaged config in another project does not affect this one', async (t) => {
  const mine = repo(t, 'mine');
  const theirs = repo(t, 'theirs');
  mkdirSync(join(theirs, '.codex'), { recursive: true });
  writeFileSync(join(theirs, '.codex', 'config.toml'), 'hand written\n');

  const catalog = { identities: [{ path: theirs, slot: 3 }] };
  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog, pack: THEME,
  });

  assert.ok(planned.config, 'this project plans normally');
  assert.equal(planned.member, 'alpha', 'slot 2 is in the alpha band');
  assert.match(planned.config.text, /^# Managed by Familiar\./);
  assert.match(planned.config.text, /pet = "custom:familiar-alpha"\n$/);
});

test('a conflict in THIS project is returned, not thrown, and names only this project', async (t) => {
  const mine = repo(t, 'mine');
  mkdirSync(join(mine, '.codex'), { recursive: true });
  writeFileSync(join(mine, '.codex', 'config.toml'), 'hand written\n');

  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, pack: THEME,
  });
  assert.equal(planned.conflict, join(mine, '.codex', 'config.toml'));
  assert.equal(planned.target, join(mine, '.codex', 'config.toml'));
  assert.equal(planned.config, undefined);
});

test('a pin for THIS path still wins, so narrowing the target did not narrow the inputs', async (t) => {
  const mine = repo(t, 'mine');
  const unpinned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, pack: THEME,
  });
  const pinned = await planCodexProjectForPath({
    path: mine, pinned: true, catalog: { identities: [{ path: mine, slot: 7 }] }, pack: THEME,
  });
  assert.equal(unpinned.member, 'alpha', 'hashed slot 2');
  assert.equal(pinned.member, 'beta', 'pinned slot 7');
});

test('a supplied member is used verbatim, and nothing is re-resolved', async (t) => {
  const mine = repo(t, 'mine');
  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, pack: THEME, member: 'gamma',
  });
  assert.equal(planned.member, 'gamma', "the caller's member wins over the hashed slot");
  assert.match(planned.config.text, /pet = "custom:familiar-gamma"\n$/);
});

test('a target reached by two routes is planned once — dedupe covers every outcome', async (t) => {
  const mine = repo(t, 'mine');
  mkdirSync(join(mine, '.codex'), { recursive: true });
  writeFileSync(join(mine, '.codex', 'config.toml'), 'hand written\n');

  await assert.rejects(
    () => planCodexProjectSync({
      catalog: { identities: [{ path: mine, slot: 3 }] }, pack: THEME, cwd: mine,
    }),
    (error) => {
      const mentions = error.message.split(', ').length;
      assert.equal(mentions, 1, `the same config must be reported once, got: ${error.message}`);
      return true;
    },
  );
});

// --- Worktrees: the pet follows the repository, the config stays per checkout ---
//
// A linked worktree inherits its repository's pin, but its Codex config is written in that
// worktree only; the Git exclusion lives in the repository-wide info/exclude, where one
// managed line covers every worktree.

function worktreeFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-worktree-sync-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = seedRepo(join(dir, 'api'));
  const tree = addWorktree(main, join(dir, 'fix-api'));
  return { dir, main, tree };
}

test('worktree config is local and Git exclusions are shared and idempotent', async (t) => {
  const { main, tree } = worktreeFixture(t);
  const catalog = { identities: [{ path: main, slot: 7 }] };
  const plan = await planCodexProjectForPath({ path: tree, pinned: false,
    catalog, pack: THEME });
  assert.equal(plan.member, 'beta');
  assert.equal(plan.target, join(tree, '.codex/config.toml'));
  applyCodexProjectSync({ configs: [plan.config], excludes: [plan.exclude] });
  assert.equal(existsSync(join(main, '.codex/config.toml')), false);
  assert.match(readFileSync(plan.target, 'utf8'), /custom:familiar-beta/);
  const mainExclude = resolve(main, git(main, ['rev-parse', '--git-path', 'info/exclude']));
  const treeExclude = resolve(tree, git(tree, ['rev-parse', '--git-path', 'info/exclude']));
  assert.equal(mainExclude, treeExclude);
  const again = await planCodexProjectForPath({ path: tree, pinned: false,
    catalog, pack: THEME });
  applyCodexProjectSync({ configs: [again.config], excludes: [again.exclude] });
  assert.equal(readFileSync(mainExclude, 'utf8').split('\n')
    .filter((line) => line === '.codex/config.toml').length, 1);
});

test('a worktree path pin chooses its own pet without touching the main checkout', async (t) => {
  const { main, tree } = worktreeFixture(t);
  const catalog = { identities: [{ path: main, slot: 7 }, { path: tree, slot: 3 }] };
  const plan = await planCodexProjectForPath({ path: tree, pinned: false, catalog, pack: THEME });
  assert.equal(plan.member, 'alpha');
  applyCodexProjectSync({ configs: [plan.config], excludes: [plan.exclude] });
  assert.match(readFileSync(join(tree, '.codex/config.toml'), 'utf8'), /custom:familiar-alpha/);
  assert.equal(existsSync(join(main, '.codex/config.toml')), false);
});

test('bulk sync plans the pinned main checkout and the current worktree, and no sibling', async (t) => {
  const { dir, main, tree } = worktreeFixture(t);
  const sibling = addWorktree(main, join(dir, 'sibling'));
  const catalog = { identities: [{ path: main, slot: 7 }] };
  const plan = await planCodexProjectSync({ catalog, pack: THEME, cwd: tree });
  assert.deepEqual(plan.configs.map((c) => c.path),
    [join(main, '.codex/config.toml'), join(tree, '.codex/config.toml')]);
  assert.deepEqual(plan.configs.map((c) => c.text.match(/familiar-(\w+)/)[1]), ['beta', 'beta']);
  assert.equal(plan.excludes.length, 1, 'one shared exclusion file for both checkouts');
  applyCodexProjectSync(plan);
  assert.equal(existsSync(join(sibling, '.codex/config.toml')), false);
});
