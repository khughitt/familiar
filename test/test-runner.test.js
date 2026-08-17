import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { testInventory } from '../tools/test-runner.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

test('inventory finds this test', () => {
  assert.ok(testInventory(REPO).includes('test/test-runner.test.js'));
});
