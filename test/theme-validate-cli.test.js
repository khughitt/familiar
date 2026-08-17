import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePack } from './helpers/fixture.js';

const BIN = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const run = (...args) => spawnSync('node', [BIN, ...args], { encoding: 'utf8' });

test('theme validate on a conforming pack prints the summary and exits 0', (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = run('theme', 'validate', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate-fixture/);
  assert.match(r.stdout, /Gate Fixture/);
  assert.match(r.stdout, /1 member/);
  assert.match(r.stdout, /12\/12 slots/);
});

test('theme validate on a broken pack prints the gate error and exits 1', (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sprites', 'solo', 'idle.png'), Buffer.from('junk'));
  const r = run('theme', 'validate', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /idle\.png/);
});

test('theme validate with no directory prints usage and exits 1', () => {
  const r = run('theme', 'validate');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /theme validate/);
});
