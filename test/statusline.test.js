// The hook and the status line are two processes with no channel between them. They agree on
// exactly two things -- the image id and the cell box -- and if either disagrees the cat is
// cropped, or floats in a field of empty cells, or never appears. These are those two things.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boxFor, pngSize } from '../src/render/term/box.js';
import {
  DEFAULT_ROWS,
  loadThemePackSync,
  memberAssetDir,
  ROW_MIN,
  ROW_MAX,
} from 'familiar-theme';
import { compose, textLines, composeForIntent } from '../src/render/term/statusline.js';
import { imageIdFor } from '../src/render/term/placeholder.js';
import { crc32 } from 'familiar-theme';

const themeDir = fileURLToPath(new URL('../test/fixtures/theme-pack', import.meta.url));
const themePack = loadThemePackSync(themeDir);
const sprite = (member, state) =>
  readFileSync(join(memberAssetDir(themePack, member), `${state}.png`));

const withDimensions = (bytes, w, h) => {
  const png = Buffer.from(bytes);
  png.writeUInt32BE(w, 16);
  png.writeUInt32BE(h, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
};

const STATES = ['idle', 'working', 'needs-input', 'needs-approval', 'error', 'done'];

test('pngSize reads the IHDR — no decoder, no dependency', () => {
  const { w, h } = pngSize(sprite('pip', 'idle'));
  assert.ok(w > 0 && h > 0);
  // Every pose of a member shares one canvas (the art compiler bottom-anchors them onto it).
  for (const state of STATES) {
    assert.deepEqual(pngSize(sprite('pip', state)), { w, h }, `${state} is not on the shared canvas`);
  }
});

test('pngSize refuses something that is not a PNG rather than reading garbage as dimensions', () => {
  assert.throws(() => pngSize(Buffer.from('nope')), /not a PNG/);
});

test('pngSize refuses long non-PNG bytes instead of treating offsets 16-23 as dimensions', () => {
  assert.throws(
    () => pngSize(Buffer.from('this is not a PNG but is long')),
    /bad signature/,
  );
});

test('pngSize refuses a corrupt chunk CRC', () => {
  const png = Buffer.from(sprite('pip', 'idle'));
  const idat = png.indexOf(Buffer.from('IDAT'));
  assert.ok(idat >= 0);
  png[idat + 4] ^= 1;
  assert.throws(() => pngSize(png), /fails its CRC/);
});

test('pngSize refuses high-bit chunk-type bytes that the ASCII decoder aliases to IHDR', () => {
  const png = Buffer.from(sprite('pip', 'idle'));
  png.set([0xc9, 0xc8, 0xc4, 0xd2], 12);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  assert.throws(() => pngSize(png), /invalid chunk type.*c9 c8 c4 d2/i);
});

test('pngSize requires a terminal IEND', () => {
  const png = sprite('pip', 'idle');
  assert.equal(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
  assert.throws(() => pngSize(png.subarray(0, -12)), /no IEND/);
});

test('pngSize refuses zero dimensions even with a valid IHDR CRC', () => {
  assert.throws(
    () => pngSize(withDimensions(sprite('pip', 'idle'), 0, 200)),
    /zero-sized image/,
  );
});

test('EVERY state of a member gets the SAME box — the pose is swapped under cells printed once', () => {
  // THE LOAD-BEARING ONE. claude-code re-runs the status-line command a couple of times per
  // TURN, not per state change: the cells are printed once and are still there, untouched, when
  // the agent goes working -> needs-approval -> done. The hook changes the cat by re-transmitting
  // under the same id. If the box moved with the state, the placement would stop matching the
  // cells that are already on screen and the cat would be cropped -- silently, only on the
  // states nobody screenshots.
  //
  // This can only hold because the six poses share a canvas. If someone reverts the art
  // compiler's canonicalisation, THIS is the test that says why it mattered.
  for (const member of ['pip']) {
    const boxes = new Set(STATES.map((s) => JSON.stringify(boxFor(sprite(member, s), DEFAULT_ROWS))));
    assert.equal(boxes.size, 1, `${member}: the box changes with the state — ${[...boxes].join(' ')}`);
  }
});

test('the box is as tall as it is TOLD, and its width follows the sprite', () => {
  // boxFor no longer owns a height — the theme does, and the caller passes it. DEFAULT_ROWS
  // stands in for a real theme number; the point is the box is that many rows, whatever it
  // is, never a constant baked into box.js.
  const box = boxFor(sprite('pip', 'idle'), DEFAULT_ROWS);
  assert.equal(box.rows, DEFAULT_ROWS);
  assert.ok(box.cols >= 1);

  // A member with a different canvas aspect gets a different width. A hardcoded width would
  // letterbox every cat but one -- which is exactly the bug the old renderer had with a
  // hardcoded height.
  const source = sprite('pip', 'idle');
  const wide = boxFor(withDimensions(source, 400, 200), DEFAULT_ROWS);
  const tall = boxFor(withDimensions(source, 200, 400), DEFAULT_ROWS);
  assert.ok(wide.cols > tall.cols, `a wide sprite must claim more columns than a tall one (${wide.cols} vs ${tall.cols})`);
});

test('boxFor REFUSES a height it cannot use, rather than drawing a broken cat', () => {
  // The whole reason box.js loses its default. `Math.round((undefined*2*w)/h)` is NaN, not a
  // throw, so an omitted rows sails through as { cols: NaN, rows: undefined } and reaches
  // kitty as c=NaN,r=undefined — the silent failure this deletes. Out-of-range fails here the
  // same way it does in the parser, against pack.js's SAME bounds.
  const png = sprite('pip', 'idle');
  assert.throws(() => boxFor(png), /rows must be a whole number/);
  assert.throws(() => boxFor(png, 4.5), /rows must be a whole number/);
  assert.equal(boxFor(png, ROW_MIN).rows, ROW_MIN, 'box rejected pack.js\'s inclusive minimum');
  assert.equal(boxFor(png, ROW_MAX).rows, ROW_MAX, 'box rejected pack.js\'s inclusive maximum');
  const range = new RegExp(`rows must be between ${ROW_MIN} and ${ROW_MAX}`);
  assert.throws(() => boxFor(png, ROW_MIN - 1), range);
  assert.throws(() => boxFor(png, ROW_MAX + 1), range);
});
test('compose lays the text beside the cat, and never on top of it', () => {
  const id = imageIdFor('a-session');
  const lines = compose({ id, cols: 6, rows: 4, text: ['[keith@titan familiar] main'] });

  assert.equal(lines.length, 4, 'the cat must occupy exactly its rows');
  const withText = lines.filter((l) => l.includes('familiar'));
  assert.equal(withText.length, 1, 'the text appears exactly once');

  // Every line begins with the cat's cells. The text is APPENDED -- it can never overwrite a
  // placeholder cell, which is the entire difference between this renderer and the overlay it
  // replaced.
  for (const line of lines) {
    assert.ok(line.includes('\u{10EEEE}'), 'a row lost its placeholder cells');
    assert.ok(line.indexOf('\u{10EEEE}') < (line.indexOf('familiar') === -1 ? Infinity : line.indexOf('familiar')));
  }
});

test('one line of text is centred against the cat, not parked on its ear', () => {
  const lines = compose({ id: imageIdFor('s'), cols: 4, rows: 4, text: ['hello'] });
  const row = lines.findIndex((l) => l.includes('hello'));
  assert.ok(row === 1 || row === 2, `a single line should sit in the middle rows, got row ${row}`);
});

test('no wrapped command means the cat alone — not an error, and not an empty line', () => {
  const lines = compose({ id: imageIdFor('s'), cols: 4, rows: 4, text: [] });
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => !l.includes(' ')), 'a gap was padded in with no text to pad for');
});

test('a wrapped command printing more lines than the cat is tall SAYS SO rather than truncating', () => {
  // A status line that quietly drops your last two lines is a status line that lies about your
  // configuration. Say what was dropped.
  const out = textLines('a\nb\nc\nd\ne\nf\n', 4);
  assert.equal(out.length, 4);
  assert.match(out[3], /3 more line/);
});

test('textLines drops blank lines rather than rendering them as gaps in the cat', () => {
  assert.deepEqual(textLines('one\n\ntwo\n', 4), ['one', 'two']);
  assert.deepEqual(textLines('', 4), []);
});

test('composeForIntent sizes the cat from the intent\'s rows — two heights, not a constant', () => {
  // The status line renders whatever the resolved intent's sprite says. compose returns one
  // line per row, so lines.length is the cat's height. 7 and 20 are neither the default 12
  // nor equal — a statusline that hardcoded 12 (the exact risk of leaving this logic inline)
  // would fail both.
  const png = sprite('pip', 'idle');
  for (const rows of [7, 20]) {
    const intent = { sprite: { terminal: '/x.png', rows } };
    const lines = composeForIntent({ intent, sessionId: 's', rawOutput: null, readSprite: () => png });
    assert.equal(lines.length, rows, `the statusline did not size the cat from rows=${rows}`);
  }
});

test('off motion returns all wrapped text with no familiar cells, SGR, or sprite read', () => {
  const rawOutput = 'one\ntwo\nthree\nfour\nfive\nsix\n';
  const lines = composeForIntent({
    intent: {
      motionPolicy: 'off',
      sprite: { terminal: '/must-not-read.png', rows: 4 },
    },
    sessionId: 's',
    rawOutput,
    readSprite: () => { throw new Error('off mode read the sprite'); },
  });
  assert.deepEqual(lines, ['one', 'two', 'three', 'four', 'five', 'six']);
  assert.ok(lines.every((line) => !line.includes('\u{10EEEE}') && !line.includes('\x1b[')));
});

test('reduced motion reserves the same familiar cells as full motion', () => {
  const png = sprite('pip', 'idle');
  const common = { sprite: { terminal: '/x.png', rows: 7 } };
  const full = composeForIntent({
    intent: { ...common, motionPolicy: 'full' }, sessionId: 's', rawOutput: 'hello', readSprite: () => png,
  });
  const reduced = composeForIntent({
    intent: { ...common, motionPolicy: 'reduced' }, sessionId: 's', rawOutput: 'hello', readSprite: () => png,
  });
  assert.deepEqual(reduced, full);
  assert.equal(reduced.length, 7);
});
