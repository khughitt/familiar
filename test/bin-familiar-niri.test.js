import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/familiar-niri', import.meta.url));

test('familiar-niri rejects trailing arguments', () => {
  const result = spawnSync(process.execPath, [bin, 'sync', 'unexpected'], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'usage: familiar-niri <sync | watch>\n');
});
