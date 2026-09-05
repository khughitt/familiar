import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampFor, readStamp, petUsable, STAMP_FILE, STAMP_VERSION } from '../src/install/pet-stamp.js';
import { SPRITESHEET_PATH } from '../src/render/codex/pets.js';

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

function pet(dir, id, { stamp = null, manifest = true, sheetFile = true } = {}) {
  const petDir = join(dir, id);
  mkdirSync(join(petDir, 'assets'), { recursive: true });
  if (sheetFile) writeFileSync(join(petDir, SPRITESHEET_PATH), 'png');
  if (manifest) writeFileSync(join(petDir, 'pet.json'), '{}');
  if (stamp) writeFileSync(join(petDir, STAMP_FILE), JSON.stringify(stamp));
  return petDir;
}

const pets = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the gate accepts a complete pet stamped for this theme and member', (t) => {
  const dir = pets(t);
  pet(dir, 'familiar-ginger', { stamp: stampFor(sheet(1)) });
  assert.deepEqual(petUsable({ petsDir: dir, themeId: 'cats', memberId: 'ginger' }), { ok: true });
});

test('the gate refuses every incomplete installation, and says which', (t) => {
  const dir = pets(t);
  const verdict = (memberId) => petUsable({ petsDir: dir, themeId: 'cats', memberId });

  assert.match(verdict('ginger').reason, /not installed/);

  pet(dir, 'familiar-tuxedo', { stamp: null });
  assert.match(verdict('tuxedo').reason, /no valid stamp/);

  // The manifest is what Codex reads to learn the pet's tracks. A sheet without
  // it is a pet Codex cannot use.
  pet(dir, 'familiar-persian', {
    stamp: stampFor({ ...sheet(1), memberId: 'persian' }), manifest: false });
  assert.match(verdict('persian').reason, /pet\.json/);

  pet(dir, 'familiar-tabby', {
    stamp: stampFor({ ...sheet(1), memberId: 'tabby' }), sheetFile: false });
  assert.match(verdict('tabby').reason, /spritesheet/);

  pet(dir, 'familiar-siamese', {
    stamp: stampFor({ ...sheet(1), themeId: 'dogs', memberId: 'siamese' }) });
  assert.match(verdict('siamese').reason, /theme "dogs"/);

  pet(dir, 'familiar-manx', { stamp: stampFor({ ...sheet(1), memberId: 'somebody-else' }) });
  assert.match(verdict('manx').reason, /member "somebody-else"/);

  for (const id of ['ginger', 'tuxedo', 'persian', 'tabby', 'siamese', 'manx']) {
    assert.equal(verdict(id).ok, false);
  }
});

test('a torn install — new sheet, stamp not yet published — is refused', (t) => {
  const dir = pets(t);
  pet(dir, 'familiar-ginger', { stamp: null });
  assert.equal(petUsable({ petsDir: dir, themeId: 'cats', memberId: 'ginger' }).ok, false);
});
