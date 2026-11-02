import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, open, realpath } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAMILY_FILE_MAX_BYTES, lookupFamily } from '../src/bus/family.js';

// A registered root (and, for the escape cases, a directory outside it) in the OS temp dir.
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-family-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  mkdirSync(root);
  return { dir, root };
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

const fs = { lstat, open, realpath };

test('the bound is 64 KiB', () => {
  assert.equal(FAMILY_FILE_MAX_BYTES, 65_536);
});

test('tools/family.toml names the family', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'tools', 'family.toml'), 'name = "guild"\n');
  assert.equal(await lookupFamily(root, fs), 'guild');
});

test('without tools/family.toml, family.toml at the root names it', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'family.toml'), 'name = "verifiably"\n');
  assert.equal(await lookupFamily(root, fs), 'verifiably');
});

test('tools/family.toml wins over family.toml, which is then never read', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'tools', 'family.toml'), 'name = "guild"\n');
  write(join(root, 'family.toml'), 'not toml at all [[[\n');
  assert.equal(await lookupFamily(root, fs), 'guild');
});

test('neither file is no family', async (t) => {
  const { root } = scratch(t);
  assert.equal(await lookupFamily(root, fs), null);
});

test('the default fs functions read the real filesystem', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'family.toml'), 'name = "guild"\n');
  assert.equal(await lookupFamily(root), 'guild');
});

test('a tools directory symlinked out of the root is refused', async (t) => {
  const { dir, root } = scratch(t);
  write(join(dir, 'outside', 'family.toml'), 'name = "guild"\n');
  symlinkSync(join(dir, 'outside'), join(root, 'tools'));
  await assert.rejects(lookupFamily(root, fs), (error) => {
    assert.match(error.message, /^family\.toml at .*\/root\/tools\/family\.toml: /);
    assert.match(error.message, /resolves outside/);
    return true;
  });
});

test('a family file that is itself a symlink is refused, even to a file inside the root', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'real.toml'), 'name = "guild"\n');
  symlinkSync(join(root, 'real.toml'), join(root, 'family.toml'));
  await assert.rejects(lookupFamily(root, fs), /family\.toml at .*\/root\/family\.toml: is a symlink/);
});

test('a family file that is a directory is refused', async (t) => {
  const { root } = scratch(t);
  mkdirSync(join(root, 'family.toml'));
  await assert.rejects(lookupFamily(root, fs), /family\.toml at .*: is not a regular file/);
});

test('a name that is not an id is refused', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'family.toml'), 'name = "Guild"\n');
  await assert.rejects(lookupFamily(root, fs), (error) => {
    assert.match(error.message, /^family\.toml at .*\/root\/family\.toml: /);
    assert.match(error.message, /family "Guild" is invalid/);
    return true;
  });
  for (const bad of ['', 'guild-', 'a--b', 'guild/x', 'gu ild']) {
    write(join(root, 'family.toml'), `name = ${JSON.stringify(bad)}\n`);
    await assert.rejects(lookupFamily(root, fs), new RegExp(`family ${JSON.stringify(bad)} is invalid`));
  }
});

test('a name that is not a string, or no name, is refused', async (t) => {
  const { root } = scratch(t);
  for (const text of ['name = [1]\n', 'name = 1\n', 'other = "guild"\n', '']) {
    write(join(root, 'family.toml'), text);
    await assert.rejects(lookupFamily(root, fs), /family\.toml at .*: name must be an id/);
  }
});

test('an oversized family file is refused', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'family.toml'), `name = "guild"\n${'#'.repeat(70 * 1024)}\n`);
  await assert.rejects(lookupFamily(root, fs), /family\.toml at .*: is more than 65536 bytes/);
});

// The lstat size is a pre-check; the read itself is what bounds what is held. A file
// that grows after lstat is refused by the read, not parsed whole.
test('the read is bounded even when lstat under-reports the size', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'family.toml'), `name = "guild"\n${'#'.repeat(200)}\n`);
  const shrinking = async (path) => Object.assign(await lstat(path), { size: 1 });
  await assert.rejects(lookupFamily(root, { ...fs, lstat: shrinking, maxBytes: 100 }),
    /family\.toml at .*: is more than 100 bytes/);
  assert.equal(await lookupFamily(root, { ...fs, maxBytes: 4096 }), 'guild');
});

test('a family file that cannot be parsed is refused on one line', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'family.toml'), 'name = "guild\n');
  await assert.rejects(lookupFamily(root, fs), (error) => {
    assert.match(error.message, /^family\.toml at .*\/root\/family\.toml: cannot be parsed/);
    assert.doesNotMatch(error.message, /\n/);
    return true;
  });
});

test('an unreadable family file is an error naming it, not an absent one', async (t) => {
  const { root } = scratch(t);
  write(join(root, 'family.toml'), 'name = "guild"\n');
  const denied = async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  await assert.rejects(lookupFamily(root, { ...fs, open: denied }),
    /^Error: family\.toml at .*\/root\/family\.toml: EACCES: permission denied$/);
});
