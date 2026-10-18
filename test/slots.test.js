import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SLOT_COUNT, assertSlot } from 'familiar-theme';
import { SLOTS, slotSpec, GREY_SLOT, nearestSlotForHue, slotForColor } from '../src/protocol/slot-hues.js';

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
    writeFileSync(join(root, 'color.js'), readFileSync(join(REPO, 'src/protocol/color.js')));
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

test('nearestSlotForHue wraps the circle and ties to the lower slot', () => {
  assert.equal(nearestSlotForHue(31), 0);     // 22 and 40 tie
  assert.equal(nearestSlotForHue(192), 5);    // 172 and 212 tie
  assert.equal(nearestSlotForHue(6), 0);      // 350 and 22 tie across 0°
  assert.equal(nearestSlotForHue(5.9), 10);
  assert.equal(nearestSlotForHue(6.1), 0);
  assert.equal(nearestSlotForHue(359), 10);
});

test('slotForColor sends low chroma to the grey slot', () => {
  assert.equal(slotForColor('#808080'), GREY_SLOT);
  assert.equal(slotForColor('#776558'), 11);
  assert.equal(slotForColor('#72638f'), 8);   // muted, still chromatic
  assert.throws(() => slotForColor('#BC8369'), /not a #rrggbb colour/);
});

// The spec's appendix: every registered colour on 2026-10-17 and its slot.
const REGISTERED = [
  ['#7995cd', 6], ['#d2647a', 10], ['#0ba880', 5], ['#70882e', 3], ['#776558', 11],
  ['#bc8369', 0], ['#db49af', 9], ['#cf6305', 0], ['#993ec8', 8], ['#2f9fb1', 5],
  ['#786cfe', 7], ['#a95479', 10], ['#d063e5', 9], ['#947782', 11], ['#d72633', 10],
  ['#058dfa', 6], ['#c72583', 9], ['#859982', 11], ['#72638f', 8], ['#317d01', 3],
  ['#9e83eb', 7], ['#8d6803', 1], ['#6671c6', 7], ['#0b6eae', 6], ['#2cab36', 4],
  ['#9c65bc', 8], ['#25786d', 5], ['#ff5e4a', 0], ['#aa8c0e', 2], ['#a8523a', 0],
  ['#2f63e1', 6], ['#fd538f', 10], ['#b780ad', 9],
];
test('slotForColor reproduces the spec appendix', () => {
  for (const [hex, slot] of REGISTERED) assert.equal(slotForColor(hex), slot, hex);
});
