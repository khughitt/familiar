// Real installer inside a suite worker, launched with fake hook redirections by
// test-runner.test.js. Fixture setup alone cannot isolate these production calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadThemePack } from 'familiar-theme';
import { applyCodexProjectSync, configText, planCodexProjectForPath } from '../../src/install/codex.js';
import { preloadedThemes } from '../helpers/themes.js';
import { initRepo } from './git-worktree.mjs';

const root = initRepo(mkdtempSync(join(tmpdir(), 'installer-')));
const theme = await loadThemePack(new URL('./theme-roles', import.meta.url).pathname);
const member = { themeId: theme.id, memberId: 'alpha' };
const planned = await planCodexProjectForPath({
  path: root, pinned: false, catalog: { identities: [] },
  themes: preloadedThemes({ [theme.id]: theme }), member,
});
assert.equal(planned.target, join(root, '.codex', 'config.toml'));
applyCodexProjectSync({ configs: [planned.config], excludes: [planned.exclude] });
assert.equal(readFileSync(planned.target, 'utf8'), configText(member));
