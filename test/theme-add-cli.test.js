import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, cpSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESCRIPTOR, writePack } from './helpers/fixture.js';

const BIN = fileURLToPath(new URL('../bin/familiar', import.meta.url));
// Built key by key, never from process.env: a failing case's output cannot echo a
// credential the developer's environment holds.
const scratchEnv = () => {
  const cfg = mkdtempSync(join(tmpdir(), 'cli-add-'));
  // FAMILIAR_THEMES_DIR points the shipped root away from the repo so the
  // listing under test is exactly the scratch state.
  return {
    PATH: process.env.PATH, HOME: cfg, FAMILIAR_CONFIG_DIR: cfg,
    FAMILIAR_STATE_DIR: join(cfg, 'state'),
    FAMILIAR_THEMES_DIR: join(cfg, 'no-shipped-themes'),
  };
};
const run = (env, ...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });

test('theme add installs a local pack and prints the activation hint', () => {
  const env = scratchEnv();
  const source = writePack();
  const r = run(env, 'theme', 'add', source);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed theme 'gate-fixture' \(1 members\) at /);
  assert.match(r.stdout, /activate with: set "theme: gate-fixture"/);
  const list = run(env, 'theme', 'list');
  assert.match(list.stdout, /gate-fixture/);
  assert.match(list.stdout, /validated \d{4}-\d{2}-\d{2} from /);
  assert.equal(list.stdout.includes(`from ${source}`), true);
});

test('theme add omits the activation hint when the installed theme is active', () => {
  const env = scratchEnv();
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: gate-fixture\n');
  const r = run(env, 'theme', 'add', writePack());
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /activate with:/);
});

test('theme add validates config before installing anything', () => {
  const env = scratchEnv();
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'motion: sideways\n');
  const r = run(env, 'theme', 'add', writePack());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /motion must be full, reduced, or off/);
  assert.doesNotMatch(r.stdout, /installed theme/);
  assert.equal(existsSync(join(env.FAMILIAR_CONFIG_DIR, 'themes')), false);
  assert.equal(existsSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts')), false);
});

test('theme add rejects a non-https transport with the rule', () => {
  const r = run(scratchEnv(), 'theme', 'add', 'http://example.test/r');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTPS URLs or local directories/);
});

test('theme add with no source prints usage and exits 2', () => {
  const r = run(scratchEnv(), 'theme', 'add');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /theme add/);
});

test('theme add accepts one positional and no flag but --replace', () => {
  for (const args of [
    ['theme', 'add', writePack(), 'extra'],
    ['theme', 'add', '--force', writePack()],
    ['theme', 'add', '--replace=yes', writePack()],
  ]) {
    const r = run(scratchEnv(), ...args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /theme add/);
  }
});

test('theme list reports a manual install as never validated', () => {
  const env = scratchEnv();
  const manual = join(env.FAMILIAR_CONFIG_DIR, 'themes', 'gate-fixture');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  cpSync(writePack(), manual, { recursive: true });
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /never validated \(manual install\)/);
});

test('theme list reports an invalid receipt with its reason', () => {
  const env = scratchEnv();
  const manual = join(env.FAMILIAR_CONFIG_DIR, 'themes', 'gate-fixture');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  cpSync(writePack(), manual, { recursive: true });
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts'), { recursive: true });
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts', 'gate-fixture.json'), '{broken');
  const r = run(env, 'theme', 'list');
  assert.match(r.stdout, /invalid receipt at .*gate-fixture\.json/);
  assert.match(r.stdout, /remove it and reinstall the theme/);
});

test('theme list sanitizes corrupt-receipt diagnostics', () => {
  const env = scratchEnv();
  const manual = join(env.FAMILIAR_CONFIG_DIR, 'themes', 'gate-fixture');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  cpSync(writePack(), manual, { recursive: true });
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts'), { recursive: true });
  writeFileSync(
    join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts', 'gate-fixture.json'),
    '{"x":\x1b]0;pwned\x07}'
  );
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /invalid receipt at .*gate-fixture\.json/);
  assert.doesNotMatch(r.stdout, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
  assert.match(r.stdout, /remove it and reinstall the theme/);
});

test('theme list never validates or prints credentials from a receipt', () => {
  const env = scratchEnv();
  const manual = join(env.FAMILIAR_CONFIG_DIR, 'themes', 'gate-fixture');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  cpSync(writePack(), manual, { recursive: true });
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts'), { recursive: true });
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts', 'gate-fixture.json'), JSON.stringify({
    id: 'gate-fixture',
    source: {
      kind: 'https',
      url: 'https://user:secret@example.test/repo',
      commit: 'a'.repeat(40),
    },
    installedAt: '2026-08-18T12:00:00Z',
  }));
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /invalid receipt/);
  assert.doesNotMatch(r.stdout, /validated|https:\/\/user|secret/);
});

test('theme list sanitizes receipt provenance into one inert terminal line', () => {
  const env = scratchEnv();
  const manual = join(env.FAMILIAR_CONFIG_DIR, 'themes', 'gate-fixture');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  cpSync(writePack(), manual, { recursive: true });
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts'), { recursive: true });
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'theme-receipts', 'gate-fixture.json'), JSON.stringify({
    id: 'gate-fixture',
    source: { kind: 'local', path: '/tmp/safe\x1b]0;pwned\x07\n  injected-row' },
    installedAt: '2026-08-18T12:00:00Z',
  }));
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /validated 2026-08-18 from \/tmp\/safe\?]0;pwned\?/);
  assert.doesNotMatch(r.stdout, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
  assert.doesNotMatch(r.stdout, /injected-row/);
});

test('theme list surfaces occupied staging neutrally, and empty staging not at all', () => {
  const env = scratchEnv();
  const staging = join(env.FAMILIAR_CONFIG_DIR, 'themes', '.staging');
  mkdirSync(staging, { recursive: true });
  const quiet = run(env, 'theme', 'list');
  assert.equal(/staging/.test(quiet.stdout), false);
  mkdirSync(join(staging, 'run-dead'));
  const loud = run(env, 'theme', 'list');
  assert.match(loud.stdout, /theme add staging present — another add may be running/);
});

test('theme list names a non-directory staging path and its removal', () => {
  const env = scratchEnv();
  const staging = join(env.FAMILIAR_CONFIG_DIR, 'themes', '.staging');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  writeFileSync(staging, 'blocked');
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes(`${staging} is not a directory — remove it`), true);
});

test('theme list does not append receipt notes to shipped rows', () => {
  const env = scratchEnv();
  const shipped = join(env.FAMILIAR_CONFIG_DIR, 'shipped', 'gate-fixture');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'shipped'), { recursive: true });
  cpSync(writePack(), shipped, { recursive: true });
  env.FAMILIAR_THEMES_DIR = join(env.FAMILIAR_CONFIG_DIR, 'shipped');
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /validated|receipt|manual install/);
});

test('theme family help lists add', () => {
  const r = run(scratchEnv(), 'theme');
  assert.match(r.stdout + r.stderr, /add SOURCE/);
});

// A user install as `theme add` leaves it, without going through the CLI.
function installUser(env, dirName = 'gate-fixture', descriptor = DESCRIPTOR) {
  const dir = join(env.FAMILIAR_CONFIG_DIR, 'themes', dirName);
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  cpSync(writePack({ descriptor }), dir, { recursive: true });
  return dir;
}

test('theme add --replace installs over an installed theme', () => {
  const env = scratchEnv();
  const first = writePack();
  assert.equal(run(env, 'theme', 'add', first).status, 0);
  const again = run(env, 'theme', 'add', first);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already installed .* remove it first/);
  const second = writePack({ descriptor: DESCRIPTOR.replace('label: Gate Fixture', 'label: Gate Fixture Two') });
  const r = run(env, 'theme', 'add', '--replace', second);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed theme 'gate-fixture' \(1 members\) at /);
  const list = run(env, 'theme', 'list');
  assert.match(list.stdout, /Gate Fixture Two/);
  assert.equal(list.stdout.includes(`from ${second}`), true);
});

test('theme remove takes the pack and its receipt, and says which it found', () => {
  const env = scratchEnv();
  assert.equal(run(env, 'theme', 'add', writePack()).status, 0);
  const r = run(env, 'theme', 'remove', 'gate-fixture');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "removed theme 'gate-fixture' (pack and receipt)\n");
  assert.equal(existsSync(join(env.FAMILIAR_CONFIG_DIR, 'themes', 'gate-fixture')), false);

  installUser(env);
  const json = run(env, '--json', 'theme', 'remove', 'gate-fixture');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { id: 'gate-fixture', removed: { pack: true, receipt: false } });

  const missing = run(env, 'theme', 'remove', 'gate-fixture');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /theme 'gate-fixture' is not installed/);
});

test('theme remove takes exactly one id', () => {
  for (const args of [['theme', 'remove'], ['theme', 'remove', 'a', 'b']]) {
    const r = run(scratchEnv(), ...args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /theme remove/);
  }
});

test('theme list names a surviving replacement backup', () => {
  const env = scratchEnv();
  installUser(env, 'other-fixture', DESCRIPTOR.replace('id: gate-fixture', 'id: other-fixture'));
  const backup = join(env.FAMILIAR_CONFIG_DIR, 'themes', '.replace-backup', 'gate-fixture-2026-11-02T12:00:00.000Z');
  mkdirSync(join(backup, 'pack'), { recursive: true });
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes(`replacement backup of 'gate-fixture' at ${backup} — restore or remove it`), true);
  assert.doesNotMatch(r.stdout, /^ {2}\.replace-backup/m);
});

test('theme list --json marks a families: theme active', () => {
  const env = scratchEnv();
  installUser(env);
  installUser(env, 'other-fixture', DESCRIPTOR.replace('id: gate-fixture', 'id: other-fixture'));
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nfamilies:\n  guild: gate-fixture\n');
  const r = run(env, '--json', 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((row) => [row.id, row.active]),
    [['gate-fixture', true], ['other-fixture', false]]);
  const pretty = run(env, 'theme', 'list');
  assert.match(pretty.stdout, /^ {2}gate-fixture *active /m);
  assert.doesNotMatch(pretty.stdout, /^ {2}other-fixture *active /m);
});

test('theme add --json reports a families: theme as active', () => {
  const env = scratchEnv();
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'families:\n  guild: gate-fixture\n');
  const r = run(env, '--json', 'theme', 'add', writePack());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).active, true);
  assert.doesNotMatch(run(env, 'theme', 'add', '--replace', writePack()).stdout, /activate with:/);
});

// Ruling 11 at the listing: a renamed directory renders nothing, so it lists as a fault.
test('theme list reports a pack whose id differs from its directory as faulty', () => {
  const env = scratchEnv();
  installUser(env, 'renamed');
  const message = 'pack id "gate-fixture" does not match its directory';
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`renamed .*— unreadable: ${message}`));
  const json = run(env, '--json', 'theme', 'list');
  assert.equal(JSON.parse(json.stdout)[0].error, message);
  assert.equal(JSON.parse(json.stdout)[0].label, null);
});

test('theme list names a .replace-backup that is not a directory', () => {
  const env = scratchEnv();
  const root = join(env.FAMILIAR_CONFIG_DIR, 'themes', '.replace-backup');
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  writeFileSync(root, 'blocked');
  const r = run(env, 'theme', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes(`${root} is not a directory — remove it`), true);
});
