import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reporterArgs } from '../tools/test-runner.mjs';

const SAMPLE = `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
test('a passing test', () => {});
test('a printing test', () => { console.log('printed by a test'); });
test('a skipped test', { skip: 'not on this host' }, () => {});
test('a todo test', { todo: true }, () => {});
describe('a suite', () => {
  test('a passing child', () => {});
  test('a failing child', () => { throw new Error('child boom'); });
});
test('a failing test', () => { assert.equal(1, 2); });
`;

function report(t, source) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-quiet-reporter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sample.test.mjs'), source);
  return spawnSync(process.execPath, ['--test', ...reporterArgs({}), 'sample.test.mjs'], {
    cwd: dir, encoding: 'utf8', timeout: 30_000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir },
  });
}

test('a red run prints failures in full, skips, todos, test output and totals, but no passes', (t) => {
  const result = report(t, SAMPLE);
  assert.equal(result.status, 1, result.stderr);
  const out = result.stdout;
  for (const quiet of ['a passing test', 'a passing child', 'a printing test']) {
    assert.doesNotMatch(out, new RegExp(quiet), `${quiet} is left out`);
  }
  assert.match(out, /printed by a test/);
  assert.match(out, /a skipped test .*# not on this host/);
  assert.match(out, /a todo test .*# TODO/);
  assert.match(out, /^ℹ tests 7$/m, 'tools/tt counts the closing totals');
  assert.match(out, /^ℹ fail 2$/m);
  const recap = out.slice(out.indexOf('failing tests:'));
  assert.match(recap, /test at sample\.test\.mjs:9:3\n✖ a failing child[\s\S]*child boom/);
  assert.match(recap, /test at sample\.test\.mjs:11:1\n✖ a failing test[\s\S]*1 !== 2/);
});

test('a green run prints only its totals', (t) => {
  const result = report(t, "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split('\n').map((line) => line.split(' ').slice(0, 2).join(' ')), [
    'ℹ tests', 'ℹ suites', 'ℹ pass', 'ℹ fail', 'ℹ cancelled', 'ℹ skipped', 'ℹ todo', 'ℹ duration_ms',
  ]);
});
