import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESCRIPTOR, TINY_PNG, writePack } from './helpers/fixture.js';

const BIN = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const run = (...args) => spawnSync('node', [BIN, ...args], { encoding: 'utf8' });

test('theme validate on a conforming pack prints the summary and exits 0', (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = run('theme', 'validate', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate-fixture/);
  assert.match(r.stdout, /Gate Fixture/);
  assert.match(r.stdout, /1 member; default member solo/);
  assert.match(r.stdout, /roles default \(solo\)/);
  assert.match(r.stdout, /world none/);
  assert.match(r.stdout, /conforms to spec-version 2/);
});

// The smallest legal world: one 1x1 locale image, `home` required, one place each.
function writeWorldPack() {
  const descriptor = DESCRIPTOR.replace('members:', [
    'world:',
    '  asset-root: world',
    '  size: [1, 1]',
    '  locales:',
    '    home: { image: home.png, places: [[0, 0]] }',
    '    closed: { image: closed.png, places: [[0, 0], [0, 0]] }',
    'members:',
  ].join('\n'));
  const dir = writePack({ descriptor });
  mkdirSync(join(dir, 'world'));
  for (const name of ['home', 'closed']) writeFileSync(join(dir, 'world', `${name}.png`), TINY_PNG());
  return dir;
}

test('theme validate --json reports roles, the default member and no world', (t) => {
  const dir = writePack({ descriptor: DESCRIPTOR.replace(
    'members:',
    'members:\n  - id: second\n    label: Second\n    roles: [reviewer]\n    persona: second\n'
      + '    asset-root: sprites/second\n    animation: { kind: static }\n    poses:\n'
      + '      idle: i\n      working: w\n      needs-input: n\n      needs-approval: a\n'
      + '      error: e\n      done: d',
  ) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'sprites', 'second'));
  for (const state of ['idle', 'working', 'needs-input', 'needs-approval', 'error', 'done']) {
    writeFileSync(join(dir, 'sprites', 'second', `${state}.png`), TINY_PNG());
  }
  const r = run('--json', 'theme', 'validate', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    id: 'gate-fixture', label: 'Gate Fixture', members: 2, roles: ['default', 'reviewer'],
    defaultMember: 'solo', world: null, specVersion: 2,
  });
});

test('theme validate names each world locale with its place count', (t) => {
  const dir = writeWorldPack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const json = run('--json', 'theme', 'validate', dir);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).world, {
    locales: [{ name: 'home', places: 1 }, { name: 'closed', places: 2 }],
  });
  const text = run('theme', 'validate', dir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /world home \(1 place\), closed \(2 places\)/);
});

test('theme validate on a broken pack prints the gate error and exits 1', (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sprites', 'solo', 'idle.png'), Buffer.from('junk'));
  const r = run('theme', 'validate', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /idle\.png/);
});

test('theme validate with no directory prints usage and exits 2', () => {
  const r = run('theme', 'validate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /theme validate/);
});

test('theme validate accepts a working checkout with clutter beside the pack', (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync('../../elsewhere/.worktrees', join(dir, '.worktrees'));
  mkdirSync(join(dir, '.superpowers'));
  symlinkSync('/etc/hostname', join(dir, '.superpowers', 'link'));
  const r = run('theme', 'validate', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate-fixture/);
});
