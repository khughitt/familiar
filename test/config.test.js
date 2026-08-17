import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadTone, themeDirFor } from '../src/config.js';

const paths = {
  configPath: '/cfg/config.yaml',
  schemePath: '/cfg/scheme.json',
  themesDir: '/repo/themes',
  userThemesDir: '/cfg/themes',
};

// A real config dir on disk, for the tests below that inject NOTHING.
function realPaths() {
  const configDir = mkdtempSync(join(tmpdir(), 'familiar-cfg-'));
  const themesDir = mkdtempSync(join(tmpdir(), 'familiar-shipped-'));
  return {
    configDir,
    configPath: join(configDir, 'config.yaml'),
    schemePath: join(configDir, 'scheme.json'),
    themesDir,
    userThemesDir: join(configDir, 'themes'),
  };
}

test('config names the active theme', async () => {
  const readFile = async () => 'theme: cats\n';
  assert.deepEqual(await loadConfig({ paths, readFile }), { themeId: 'cats', motionPolicy: 'full' });
});

test('a missing config defaults to the cats theme — the one that ships', async () => {
  const readFile = async () => { throw Object.assign(new Error(''), { code: 'ENOENT' }); };
  assert.deepEqual(await loadConfig({ paths, readFile }), { themeId: 'cats', motionPolicy: 'full' });
});

test('each motion policy round-trips from config', async () => {
  for (const motionPolicy of ['full', 'reduced', 'off']) {
    const readFile = async () => `motion: ${motionPolicy}\n`;
    assert.deepEqual(
      await loadConfig({ paths, readFile }),
      { themeId: 'cats', motionPolicy },
    );
  }
});

test('an unknown motion policy is rejected with the valid choices', async () => {
  const readFile = async () => 'motion: wobble\n';
  await assert.rejects(
    loadConfig({ paths, readFile }),
    /config\.yaml: motion.*full.*reduced.*off/,
  );
});

// KILLS: any broken production `readFile` default — a stub returning `''`, the
// wrong path, a swallowed error. Every other loadConfig test injects `readFile`,
// so none of them reads a byte off disk.
//
// THE THEME ID MUST NOT BE THE DEFAULT ONE, and that is the whole test. `parse('')
// ?? {}` is `{}`, `data.theme ?? DEFAULT_THEME` is then `cats` — exactly what a
// working read of a `theme: cats` config would also return. A test written on the
// default id cannot tell a working read from a read that returns nothing, so a
// user who writes `theme: dogs` would silently get `cats`: a silent fallback, in a
// project whose rule is fail early.
test('the DEFAULT readFile() reads the real config.yaml — no injection', async () => {
  const real = realPaths();
  writeFileSync(real.configPath, 'theme: dogs\n');
  assert.deepEqual(await loadConfig({ paths: real }), { themeId: 'dogs', motionPolicy: 'full' });
});

test('a user theme shadows a shipped one of the same name', () => {
  // Otherwise ~/.config/familiar/themes/<id> is a directory that silently does
  // nothing, and the "themes are user-authorable" claim is decoration.
  assert.equal(themeDirFor(paths, 'cats', { exists: () => false }), '/repo/themes/cats');
  assert.equal(
    themeDirFor(paths, 'cats', { exists: (p) => p === '/cfg/themes/cats' }),
    '/cfg/themes/cats'
  );
});

// KILLS: `{ exists = () => false }` AND `{ exists = () => true }`. Every other
// call site in this file injects `exists`, so the PRODUCTION default is invisible
// to all of them — and a wrong default silently disables user-theme shadowing,
// which src/config.js:23-25 calls "the whole of themes are user-authorable".
//
// BOTH HALVES ARE LOAD-BEARING, and neither alone is enough: with `() => false`
// the shipped half still passes (no user dir exists in a stock test environment,
// so the right answer comes back for the wrong reason), and with `() => true` the
// user half still passes. Only the pair pins the default to the real filesystem.
test('the DEFAULT exists() reads the real filesystem — no injection', () => {
  const real = realPaths();
  mkdirSync(join(real.userThemesDir, 'dogs'), { recursive: true });

  // it exists on disk -> the USER's dir shadows the shipped one
  assert.equal(themeDirFor(real, 'dogs'), join(real.userThemesDir, 'dogs'));
  // it does not -> the SHIPPED dir, and no error
  assert.equal(themeDirFor(real, 'cats'), join(real.themesDir, 'cats'));
});

test('a theme id that escapes the themes directory is rejected, not joined', () => {
  // themeDirFor('../../../../etc') resolved to /etc — join() collapses "..", so
  // an id from the user's config.yaml chose a directory outside the themes dir
  // entirely. Self-inflicted, but a path join must never leave the directory it
  // names, whoever typed the input.
  assert.throws(
    () => themeDirFor(paths, '../../../../etc', { exists: () => false }),
    /config\.yaml: theme "\.\.\/\.\.\/\.\.\/\.\.\/etc" is invalid/
  );
  // ...and the escape is not merely blocked at the shadowing check: it is
  // rejected before either candidate path is built.
  assert.throws(
    () => themeDirFor(paths, '../../../../etc', { exists: () => true }),
    /config\.yaml: theme "\.\.\/\.\.\/\.\.\/\.\.\/etc" is invalid/
  );
});

test('the scheme tone is an INPUT — the core never asks a bar what the scheme is', async () => {
  const readFile = async () => '{"mode":"light","satScale":0.9}';
  assert.deepEqual(await loadTone({ paths, readFile }), { mode: 'light', satScale: 0.9 });
});

test('a missing scheme.json names the portable command that writes it', async () => {
  // NOT "run familiar-noctalia": src/ may not know a bar exists (the seam test
  // greps for the name). The portable binary can always write this itself, which
  // is what makes the core runnable on a bare terminal with no bar at all.
  const readFile = async () => { throw Object.assign(new Error(''), { code: 'ENOENT' }); };
  await assert.rejects(loadTone({ paths, readFile }), /familiar scheme set dark/);
});

test('a malformed scheme is an error, not a silent dark default', async () => {
  const readFile = async () => '{"mode":"sepia","satScale":1}';
  await assert.rejects(loadTone({ paths, readFile }), /SchemeTone\.mode/);
});
