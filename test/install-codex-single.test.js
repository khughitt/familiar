import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadThemePack } from 'familiar-theme';
import {
  applyCodexProjectSync, configText, planCodexProjectForPath, planCodexProjectSync, MANAGED_CONFIG,
} from '../src/install/codex.js';
import { addWorktree, git, initRepo, seedRepo } from './fixtures/git-worktree.mjs';
import { preloadedThemes } from './helpers/themes.js';

const THEME = await loadThemePack(
  fileURLToPath(new URL('./fixtures/theme-roles', import.meta.url)));
const OTHER = await loadThemePack(
  fileURLToPath(new URL('./fixtures/theme-pack', import.meta.url)));
// The default theme alone, as the planner sees a config with no `families:`.
const THEMES = preloadedThemes({ 'roles-fixture': THEME });
const pair = (memberId, themeId = 'roles-fixture') => ({ themeId, memberId });

// `git rev-parse --show-toplevel` reports the PHYSICAL path, so resolve the root
// the way gitContext would rather than trusting the temp path we were handed.
function repo(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `familiar-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = initRepo(dir);
  git(root, ['remote', 'add', 'origin', `git@github.com:example/${name}.git`]);
  return root;
}

test('an unmanaged config in another project does not affect this one', async (t) => {
  const mine = repo(t, 'mine');
  const theirs = repo(t, 'theirs');
  mkdirSync(join(theirs, '.codex'), { recursive: true });
  writeFileSync(join(theirs, '.codex', 'config.toml'), 'hand written\n');

  const catalog = { identities: [{ path: theirs, slot: 3 }] };
  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog, themes: THEMES,
  });

  assert.ok(planned.config, 'this project plans normally');
  assert.deepEqual(planned.member, pair('alpha'), 'the default member');
  assert.match(planned.config.text, /^# Managed by Familiar\./);
  assert.match(planned.config.text, /pet = "custom:familiar-roles-fixture--alpha"\n$/);
});

test('a conflict in THIS project is returned, not thrown, and names only this project', async (t) => {
  const mine = repo(t, 'mine');
  mkdirSync(join(mine, '.codex'), { recursive: true });
  writeFileSync(join(mine, '.codex', 'config.toml'), 'hand written\n');

  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, themes: THEMES,
  });
  assert.equal(planned.conflict, join(mine, '.codex', 'config.toml'));
  assert.equal(planned.target, join(mine, '.codex', 'config.toml'));
  assert.equal(planned.config, undefined);
});

test('a pin for THIS path still wins, so narrowing the target did not narrow the inputs', async (t) => {
  const mine = repo(t, 'mine');
  const unpinned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, themes: THEMES,
  });
  const pinned = await planCodexProjectForPath({
    path: mine, pinned: true, catalog: { identities: [{ path: mine, slot: 7, members: { 'roles-fixture': 'beta' } }] }, themes: THEMES,
  });
  assert.deepEqual(unpinned.member, pair('alpha'), 'the default member');
  assert.deepEqual(pinned.member, pair('beta'), 'the pinned member');
});

test('a supplied member is used verbatim, and nothing is re-resolved', async (t) => {
  const mine = repo(t, 'mine');
  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, themes: THEMES, member: pair('beta'),
  });
  assert.deepEqual(planned.member, pair('beta'), "the caller's member wins over the default member");
  assert.match(planned.config.text, /pet = "custom:familiar-roles-fixture--beta"\n$/);
});

test('a target reached by two routes is planned once — dedupe covers every outcome', async (t) => {
  const mine = repo(t, 'mine');
  mkdirSync(join(mine, '.codex'), { recursive: true });
  writeFileSync(join(mine, '.codex', 'config.toml'), 'hand written\n');

  await assert.rejects(
    () => planCodexProjectSync({
      catalog: { identities: [{ path: mine, slot: 3 }] }, themes: THEMES, cwd: mine,
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
  const catalog = { identities: [{ path: main, slot: 7, members: { 'roles-fixture': 'beta' } }] };
  const plan = await planCodexProjectForPath({ path: tree, pinned: false,
    catalog, themes: THEMES });
  assert.deepEqual(plan.member, pair('beta'));
  assert.equal(plan.target, join(tree, '.codex/config.toml'));
  applyCodexProjectSync({ configs: [plan.config], excludes: [plan.exclude] });
  assert.equal(existsSync(join(main, '.codex/config.toml')), false);
  assert.match(readFileSync(plan.target, 'utf8'), /custom:familiar-roles-fixture--beta/);
  const mainExclude = resolve(main, git(main, ['rev-parse', '--git-path', 'info/exclude']));
  const treeExclude = resolve(tree, git(tree, ['rev-parse', '--git-path', 'info/exclude']));
  assert.equal(mainExclude, treeExclude);
  const again = await planCodexProjectForPath({ path: tree, pinned: false,
    catalog, themes: THEMES });
  applyCodexProjectSync({ configs: [again.config], excludes: [again.exclude] });
  assert.equal(readFileSync(mainExclude, 'utf8').split('\n')
    .filter((line) => line === '.codex/config.toml').length, 1);
});

test('a worktree path pin chooses its own pet without touching the main checkout', async (t) => {
  const { main, tree } = worktreeFixture(t);
  const catalog = { identities: [{ path: main, slot: 7, members: { 'roles-fixture': 'beta' } }, { path: tree, slot: 3 }] };
  const plan = await planCodexProjectForPath({ path: tree, pinned: false, catalog, themes: THEMES });
  assert.deepEqual(plan.member, pair('alpha'));
  applyCodexProjectSync({ configs: [plan.config], excludes: [plan.exclude] });
  assert.match(readFileSync(join(tree, '.codex/config.toml'), 'utf8'), /custom:familiar-roles-fixture--alpha/);
  assert.equal(existsSync(join(main, '.codex/config.toml')), false);
});

test('bulk sync plans the pinned main checkout and the current worktree, and no sibling', async (t) => {
  const { dir, main, tree } = worktreeFixture(t);
  const sibling = addWorktree(main, join(dir, 'sibling'));
  const catalog = { identities: [{ path: main, slot: 7, members: { 'roles-fixture': 'beta' } }] };
  const plan = await planCodexProjectSync({ catalog, themes: THEMES, cwd: tree });
  assert.deepEqual(plan.configs.map((c) => c.path),
    [join(main, '.codex/config.toml'), join(tree, '.codex/config.toml')]);
  assert.deepEqual(plan.configs.map((c) => c.text.match(/familiar-roles-fixture--(\w+)/)[1]), ['beta', 'beta']);
  assert.equal(plan.excludes.length, 1, 'one shared exclusion file for both checkouts');
  applyCodexProjectSync(plan);
  assert.equal(existsSync(join(sibling, '.codex/config.toml')), false);
});


test('the Codex sync keeps the pet whatever the colour and reports warnings', async (t) => {
  // A colour decides the slot, never the member: since spec-version 2 a member holds
  // roles, not slots, so two colours on two slots draw the same default member.
  const mine = repo(t, 'mine');
  const lookupProjectColor = async () => ({ prefix: 'api', color: '#317d01', root: null, warnings: [] });
  const plan = await planCodexProjectForPath({ path: mine, pinned: false,
    catalog: { identities: [] }, themes: THEMES, lookupProjectColor });
  assert.deepEqual(plan.member, pair('alpha'));
  assert.deepEqual(plan.warnings, []);
  const grey = await planCodexProjectForPath({ path: mine, pinned: false,
    catalog: { identities: [] }, themes: THEMES,
    lookupProjectColor: async () => ({ prefix: 'api', color: '#808080', root: null, warnings: [] }) });
  assert.deepEqual(grey.member, pair('alpha'), 'a neutral colour moves the slot, not the member');
  const warned = await planCodexProjectSync({
    catalog: { identities: [{ path: mine, slot: 7 }] }, themes: THEMES, cwd: mine,
    lookupProjectColor: async () => ({ prefix: null, color: null, root: null, warnings: ['w2', 'w1', 'w2'] }),
  });
  assert.deepEqual(warned.warnings, ['w2', 'w1']);
});

test('a supplied member is never looked up', async (t) => {
  const planned = await planCodexProjectForPath({ path: repo(t, 'mine'), pinned: false,
    catalog: { identities: [] }, themes: THEMES, member: pair('beta'),
    lookupProjectColor: async () => { throw new Error('unexpected lookup'); } });
  assert.deepEqual(planned.member, pair('beta'));
  assert.deepEqual(planned.warnings, []);
});

test('Codex tracked and conflicting config outcomes carry tasks warnings', async (t) => {
  const mine = repo(t, 'mine');
  const target = join(mine, '.codex/config.toml');
  mkdirSync(join(mine, '.codex'));
  writeFileSync(target, 'hand written\n');
  const options = { path: mine, pinned: false, catalog: { identities: [] }, themes: THEMES,
    lookupProjectColor: async () => ({ prefix: null, color: null, root: null, warnings: ['w'] }) };
  const conflict = await planCodexProjectForPath(options);
  assert.equal(conflict.conflict, target);
  assert.deepEqual(conflict.warnings, ['w']);
  git(mine, ['add', '-f', '.codex/config.toml']);
  const manual = await planCodexProjectForPath(options);
  assert.equal(manual.manual.path, target);
  assert.deepEqual(manual.warnings, ['w']);
});

test('Codex does not look up a missing path or a directory outside a repository', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-codex-no-repo-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { catalog: { identities: [] }, themes: THEMES,
    lookupProjectColor: async () => { throw new Error('unexpected lookup'); } };
  assert.deepEqual(await planCodexProjectForPath({ ...options, path: join(root, 'missing'), pinned: true }),
    { missing: join(root, 'missing') });
  const skip = await planCodexProjectForPath({ ...options, path: root, pinned: false });
  assert.equal(skip.skip.reason, 'not a Git repository');
  const pinned = await planCodexProjectForPath({ ...options, path: root, pinned: true });
  assert.ok(pinned.config);
  assert.deepEqual(pinned.warnings, []);
});

// --- v2 pet ids: the managed text names a (theme, member) pair ------------------------

const V1 = '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.\n'
  + '[tui]\npet = "custom:familiar-alpha"\n';

test('the managed config is the v2 text only', () => {
  assert.equal(configText(pair('alpha')),
    '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.\n'
      + '[tui]\npet = "custom:familiar-roles-fixture--alpha"\n');
  assert.equal(MANAGED_CONFIG.test(configText(pair('alpha'))), true);
  assert.equal(MANAGED_CONFIG.test(configText(pair('cats-ginger', 'forest'))), true);
  assert.equal(MANAGED_CONFIG.test(V1), false, 'the v1 text is not ours to rewrite');
  for (const id of ['a--b--c', 'a---b', '--b', 'a--', 'A--b']) {
    assert.equal(MANAGED_CONFIG.test(V1.replace('familiar-alpha', `familiar-${id}`)), false, id);
  }
});

test('a v1 managed file is a conflict like any unmanaged file', async (t) => {
  const mine = repo(t, 'mine');
  const target = join(mine, '.codex', 'config.toml');
  mkdirSync(join(mine, '.codex'));
  writeFileSync(target, V1);
  const planned = await planCodexProjectForPath({ path: mine, pinned: false,
    catalog: { identities: [] }, themes: THEMES,
    lookupProjectColor: async () => ({ prefix: null, color: null, root: null, warnings: [] }) });
  assert.equal(planned.conflict, target);
  assert.equal(planned.config, undefined);
  assert.equal(readFileSync(target, 'utf8'), V1);
});

// The repository's face: its family chooses the theme, and no role is ever applied.
test('an unsupplied member resolves with the directory\'s family and no role', async (t) => {
  const mine = repo(t, 'mine');
  const themes = preloadedThemes({ 'roles-fixture': THEME, fixture: OTHER },
    { themeId: 'roles-fixture', families: { guild: 'fixture' } });
  const families = [];
  const planned = await planCodexProjectForPath({ path: mine, pinned: false,
    catalog: { identities: [] }, themes,
    lookupProjectColor: async () => ({ prefix: 'api', color: null, root: mine, warnings: [] }),
    lookupFamily: async (root) => { families.push(root); return 'guild'; } });
  assert.deepEqual(families, [mine], 'the family is read at the registered root');
  assert.deepEqual(planned.member, pair('pip', 'fixture'));
  assert.match(planned.config.text, /pet = "custom:familiar-fixture--pip"\n$/);

  const unregistered = await planCodexProjectForPath({ path: mine, pinned: false,
    catalog: { identities: [] }, themes,
    lookupProjectColor: async () => ({ prefix: null, color: null, root: null, warnings: [] }),
    lookupFamily: async () => { throw new Error('an unregistered checkout has no family file'); } });
  assert.deepEqual(unregistered.member, pair('alpha'), 'no family draws the default theme');
});

test('a supplied member skips the family lookup too', async (t) => {
  const planned = await planCodexProjectForPath({ path: repo(t, 'mine'), pinned: false,
    catalog: { identities: [] }, themes: THEMES, member: pair('beta'),
    lookupProjectColor: async () => { throw new Error('unexpected lookup'); },
    lookupFamily: async () => { throw new Error('unexpected family lookup'); } });
  assert.deepEqual(planned.member, pair('beta'));
});

test('bulk sync resolves each target in its own family\'s theme', async (t) => {
  const mine = repo(t, 'mine');
  const theirs = repo(t, 'theirs');
  const themes = preloadedThemes({ 'roles-fixture': THEME, fixture: OTHER },
    { themeId: 'roles-fixture', families: { guild: 'fixture' } });
  const plan = await planCodexProjectSync({
    catalog: { identities: [{ path: theirs, slot: 3 }] }, themes, cwd: mine,
    lookupProjectColor: async (dir) => ({ prefix: null, color: null, root: dir, warnings: [] }),
    lookupFamily: async (root) => (root === mine ? 'guild' : null),
  });
  assert.deepEqual(plan.configs.map((c) => [c.path, c.text.match(/custom:(\S+)"/)[1]]), [
    [join(theirs, '.codex/config.toml'), 'familiar-roles-fixture--alpha'],
    [join(mine, '.codex/config.toml'), 'familiar-fixture--pip'],
  ]);
});
