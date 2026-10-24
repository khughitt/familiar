// The pinned Luau development runtime is fetched by a script that verifies the
// official archive's SHA-256 before extracting anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/fetch-luau.mjs', import.meta.url));

test('an archive whose digest does not match the pin is refused before extraction', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-luau-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = join(dir, 'luau.zip');
  writeFileSync(archive, 'not the release');
  const dest = join(dir, 'out', 'luau');
  const result = spawnSync(process.execPath, [SCRIPT, '--archive', archive, '--dest', dest], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sha-256 mismatch/i);
  assert.equal(existsSync(dest), false);
});

test('unknown arguments are refused', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});
