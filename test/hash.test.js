import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a32 } from '../src/protocol/hash.js';

test('matches the canonical FNV-1a 32-bit vectors', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('foobar'), 0xbf9cf968);
});

test('hashes UTF-8 bytes, not UTF-16 code units', () => {
  // 'é' is two bytes in UTF-8; a UTF-16 implementation would differ.
  assert.equal(fnv1a32('é'), 0x1e9de8c1);
});

test('is unsigned — a key with the high bit set must not come back negative', () => {
  // 'zzz' hashes to 0xa7b0389d. A signed implementation returns -1481458019 here,
  // which would make autoSlot() produce a negative slot. `>= 0` on any old key is
  // vacuous — `>>> 0` cannot be negative — so pin the value.
  assert.equal(fnv1a32('zzz'), 0xa7b0389d);
  assert.ok(fnv1a32('zzz') > 0x7fffffff);
});
