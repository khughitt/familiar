import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/familiar-noctalia', import.meta.url));

// bin/familiar-noctalia reads noctalia's settings.json relative to the real
// homedir(), which on POSIX consults $HOME. Pointing HOME at a fresh temp
// directory isolates both the noctalia settings it reads AND the
// ~/.config/familiar/scheme.json it writes, without needing any env var this
// integration doesn't otherwise have.
function fakeHome() {
  return mkdtempSync(join(tmpdir(), 'familiar-noctalia-home-'));
}

function writeNoctaliaSettings(home, settings) {
  const dir = join(home, '.config', 'noctalia');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
}

function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

test('scheme-sync reads noctalia darkMode:true and writes a dark scheme.json', () => {
  const home = fakeHome();
  writeNoctaliaSettings(home, { colorSchemes: { darkMode: true } });

  const result = run(home, ['scheme-sync']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'dark\n');

  const written = JSON.parse(readFileSync(join(home, '.config', 'familiar', 'scheme.json'), 'utf8'));
  assert.deepEqual(written, { mode: 'dark', satScale: 1.0 });
});

test('scheme-sync reads noctalia darkMode:false and writes a light scheme.json', () => {
  const home = fakeHome();
  writeNoctaliaSettings(home, { colorSchemes: { darkMode: false } });

  const result = run(home, ['scheme-sync']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'light\n');

  const written = JSON.parse(readFileSync(join(home, '.config', 'familiar', 'scheme.json'), 'utf8'));
  assert.deepEqual(written, { mode: 'light', satScale: 1.0 });
});

// THE HARD REQUIREMENT: no silent dark default. If noctalia's settings don't
// have a boolean colorSchemes.darkMode — key missing, renamed, moved, or
// merely not a boolean — familiar-noctalia must throw loudly rather than
// guess. A crash the user notices beats a wrong-but-quiet default every time.
test('scheme-sync throws when colorSchemes.darkMode is absent, rather than defaulting to dark', () => {
  const home = fakeHome();
  writeNoctaliaSettings(home, { colorSchemes: {} });

  const result = run(home, ['scheme-sync']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /colorSchemes\.darkMode/);
});

test('scheme-sync throws when colorSchemes.darkMode is not a boolean', () => {
  const home = fakeHome();
  writeNoctaliaSettings(home, { colorSchemes: { darkMode: 'yes' } });

  const result = run(home, ['scheme-sync']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /colorSchemes\.darkMode/);
});

test('scheme-sync throws when noctalia settings.json does not exist at all', () => {
  const home = fakeHome();

  const result = run(home, ['scheme-sync']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('an unknown command prints usage to stderr and exits non-zero', () => {
  const home = fakeHome();
  const result = run(home, ['bogus']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: familiar-noctalia <scheme-sync \| dnd>/);
});

// A test-owned fake noctalia on PATH, with an environment built key by key.
function fakeNoctalia(output, status = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-noctalia-bin-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'answer'), output);
  writeFileSync(join(dir, 'bin', 'noctalia'), `#!/bin/sh\ncat '${join(dir, 'answer')}'\nexit ${status}\n`, { mode: 0o755 });
  return { HOME: dir, PATH: `${join(dir, 'bin')}:/usr/bin:/bin` };
}
const runEnv = (env, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });

test('dnd prints the validated live status', () => {
  for (const status of ['on', 'off']) {
    const result = runEnv(fakeNoctalia(`${status}\n`), ['dnd']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${status}\n`);
  }
});

test('dnd reports an unusable answer as unknown and exits 1', () => {
  for (const [output, status] of [['maybe\n', 0], ['', 3]]) {
    const result = runEnv(fakeNoctalia(output, status), ['dnd']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /do not disturb status unavailable/);
  }
});
