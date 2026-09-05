import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampFor, readStamp, STAMP_FILE, STAMP_VERSION } from '../src/install/pet-stamp.js';

const base = {
  themeId: 'cats', memberId: 'ginger',
  frame: { width: 192, height: 208, columns: 8, rows: 9 },
  motionPolicy: 'full', anchor: 'floor',
};
const sheet = (...bytes) => ({ ...base, sheet: Uint8Array.from(bytes) });

test('the same sheet stamps the same', () => {
  assert.equal(stampFor(sheet(1, 2, 3)).content, stampFor(sheet(1, 2, 3)).content);
  assert.equal(stampFor(sheet(1, 2, 3)).version, STAMP_VERSION);
});

test('any difference in the compiled sheet changes the stamp', () => {
  assert.notEqual(stampFor(sheet(1, 2, 3)).content, stampFor(sheet(1, 2, 4)).content);
  assert.notEqual(stampFor(sheet(1, 2)).content, stampFor(sheet(2, 1)).content);
});

test('the compiler contract is stamped alongside the sheet', () => {
  const full = stampFor(sheet(1));
  assert.notEqual(stampFor({ ...sheet(1), motionPolicy: 'reduced' }).content, full.content);
  assert.notEqual(stampFor({ ...sheet(1), anchor: 'center' }).content, full.content);
  assert.notEqual(
    stampFor({ ...sheet(1), frame: { ...base.frame, rows: 8 } }).content, full.content);
  assert.notEqual(stampFor({ ...sheet(1), themeId: 'dogs' }).content, full.content);
});

test('readStamp rejects anything it cannot fully trust', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-stamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (value) => writeFileSync(join(dir, STAMP_FILE),
    typeof value === 'string' ? value : JSON.stringify(value));

  assert.equal(readStamp(dir), null, 'absent');
  write('not json');
  assert.equal(readStamp(dir), null, 'unparseable');

  const good = stampFor(sheet(1));
  write({ ...good, version: STAMP_VERSION + 1 });
  assert.equal(readStamp(dir), null, 'a future version is not ours to interpret');

  for (const field of ['themeId', 'memberId', 'content', 'frame', 'motionPolicy', 'anchor']) {
    const partial = { ...good };
    delete partial[field];
    write(partial);
    assert.equal(readStamp(dir), null, `a stamp missing ${field} must be rejected`);
  }

  // TYPE-CHECKING IS NOT VALIDATION. Each of these is the right type and still
  // describes a pet that could not have been compiled.
  const invalid = [
    ['content', 42], ['content', 'nothex!!'], ['content', 'abc'],
    ['themeId', ''], ['memberId', ''], ['anchor', ''], ['anchor', 'middle'],
    ['motionPolicy', 'bogus'],
    ['motionPolicy', 'off'],          // a real policy, but nothing compiles under it
    ['frame', {}],
    ['frame', { ...good.frame, rows: 0 }],
    ['frame', { ...good.frame, width: -1 }],
    ['frame', { ...good.frame, columns: 1.5 }],
  ];
  for (const [field, value] of invalid) {
    write({ ...good, [field]: value });
    assert.equal(readStamp(dir), null,
      `a stamp with ${field} = ${JSON.stringify(value)} must be rejected`);
  }

  write(good);
  assert.equal(readStamp(dir).memberId, 'ginger');
});
