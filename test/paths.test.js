import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/bus/paths.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// themesDir was the one path in this module NOT env-overridable, despite the
// module's own comment promising "every path is env-overridable so tests can
// run against a temp dir". The engine ships no art, so any test (or real
// deployment) that needs a themes root other than the repo's own must be able
// to say so without touching the developer's real state — exactly the reason
// FAMILIAR_CONFIG_DIR and FAMILIAR_STATE_DIR already exist.
test('themesDir defaults to the repo-root themes directory', () => {
  const { themesDir } = paths({});
  assert.equal(themesDir, join(REPO, 'themes'));
});

test('FAMILIAR_THEMES_DIR overrides the shipped themes root, like its siblings', () => {
  const { themesDir } = paths({ FAMILIAR_THEMES_DIR: '/fixture/themes' });
  assert.equal(themesDir, '/fixture/themes');
});
