import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SLOT_COUNT, assertSlot } from 'familiar-theme';
import { SLOTS, slotSpec } from '../src/protocol/slot-hues.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SLOT_HUES = join(REPO, 'src/protocol/slot-hues.js');

test('there are twelve canonical slots, in order', () => {
  assert.equal(SLOT_COUNT, 12);
  assert.equal(SLOTS.length, 12);
  assert.deepEqual(SLOTS.map((s) => s.slot), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('slot hue and saturation are the frozen values from the spec', () => {
  assert.deepEqual(slotSpec(0), { slot: 0, hue: 22, sat: 62 });
  assert.deepEqual(slotSpec(6), { slot: 6, hue: 212, sat: 55 });
  assert.deepEqual(slotSpec(11), { slot: 11, hue: 0, sat: 6 });
});

test('an out-of-range slot is an error, never clamped', () => {
  assert.throws(() => assertSlot(12), /slot out of range: 12/);
  assert.throws(() => assertSlot(-1), /slot out of range: -1/);
  assert.throws(() => assertSlot(1.5), /slot out of range: 1.5/);
});

test('the engine fails to LOAD when the hue table and the slot count disagree', async () => {
  // SLOT_COUNT was `SLOTS.length` before the contract/policy split. Now the count
  // is the contract's and the rows are the engine's, so the derivation is gone
  // and slot-hues.js's import-time throw is all that stands between them.
  //
  // NOT `assert.equal(SLOTS.length, SLOT_COUNT)`: that is a second copy of the
  // comparison the guard itself makes, and it passes with the guard deleted --
  // which leaves the load-time failure the spec asked for (§6) untested. So
  // mutate the module and prove the IMPORT rejects. The mutated copy has to live
  // inside the repo: slot-hues.js imports the bare specifier 'familiar-theme',
  // which only resolves from a path under the workspace root.
  const source = readFileSync(SLOT_HUES, 'utf8');
  const short = source.replace('  { slot: 11, hue: 0, sat: 6 },\n', '');
  assert.notEqual(short, source, 'the mutation removed no hue row — slot 11 was reshaped');
  const root = mkdtempSync(join(REPO, 'slots-guard-'));
  try {
    const mutated = join(root, 'slot-hues.js');
    writeFileSync(mutated, short);
    await assert.rejects(
      () => import(pathToFileURL(mutated).href),
      /slot-hues: 11 hue rows for 12 slots/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The unmutated module loaded at the top of this file, so the guard passes for
  // the real table by construction; this only pins the number it agreed on.
  assert.equal(SLOTS.length, SLOT_COUNT);
});
