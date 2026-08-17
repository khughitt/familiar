// The image id is the one piece of this renderer that reaches OUTSIDE our process and lands in
// a namespace we share with strangers. Everything here guards that boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { transmitVirtual, placeholderLines, imageIdFor, wrapForTmux, diacritics } from '../src/render/term/placeholder.js';
import { loadThemePackSync, memberAssetDir } from 'familiar-theme';

const themeDir = fileURLToPath(new URL('../test/fixtures/theme-pack', import.meta.url));
const PNG = readFileSync(join(memberAssetDir(loadThemePackSync(themeDir), 'pip'), 'idle.png'));

test('an image id below the reserved floor is refused', () => {
  // Measured: kitty scopes image ids per WINDOW, so two agents cannot collide with each other.
  // What CAN collide is anything else run in the agent's own window -- icat, timg, an editor's
  // image preview -- and those allocate from the bottom of the range. An 8-bit id sits exactly
  // there. Refusing the low range is the whole point; if this test goes green with id=42, the
  // guard is gone and the cat can be silently replaced by someone else's picture.
  assert.throws(() => transmitVirtual(PNG, { id: 42, cols: 8, rows: 5 }), /image id must be/);
  assert.throws(() => transmitVirtual(PNG, { id: 255, cols: 8, rows: 5 }), /image id must be/);
});

test('an image id wider than the RGB foreground can carry is refused', () => {
  // The id is encoded in `\x1b[38;2;r;g;b m`. Anything above 24 bits would be silently truncated
  // to a DIFFERENT id -- i.e. drawn as somebody else's image, which is worse than not drawing.
  assert.throws(() => transmitVirtual(PNG, { id: 0x1000000, cols: 8, rows: 5 }), /image id must be/);
});

test('imageIdFor is stable per session and lands in the safe range', () => {
  // Stability is load-bearing: the status line prints the cells ONCE, and the hook swaps the
  // sprite underneath them on every state change. If the id moved between calls, the hook would
  // transmit to an id nothing is pointing at, and the cat would freeze on its first pose.
  const a = imageIdFor('af48b01c-1203-4658-8c14-dc4707619952');
  const b = imageIdFor('af48b01c-1203-4658-8c14-dc4707619952');
  assert.equal(a, b);
  assert.ok(a >= 0x1000 && a <= 0xffffff, `id ${a} escaped the safe range`);
  assert.notEqual(a, imageIdFor('d96b6e48-ee76-4e4b-93b2-c923f088ccce'));
});

test('imageIdFor refuses an empty session id', () => {
  assert.throws(() => imageIdFor(''), /session id/);
});

test('the id is carried in an RGB foreground, not a 256-colour index', () => {
  const id = 0xa1b2c3;
  const [line] = placeholderLines({ id, cols: 2, rows: 1 });
  assert.match(line, /^\x1b\[38;2;161;178;195m/, `expected an RGB foreground carrying ${id}, got ${JSON.stringify(line)}`);
  assert.doesNotMatch(line, /38;5;/, 'fell back to the 8-bit palette — the id no longer survives above 255');
});

test('the placeholder cells encode row and column with kitty\'s diacritics', () => {
  const d = diacritics();
  const lines = placeholderLines({ id: 0x1234, cols: 2, rows: 2 });
  assert.equal(lines.length, 2);
  // row 1, column 0 -> the placeholder char, then the diacritic for 1, then the one for 0.
  assert.ok(lines[1].includes('\u{10EEEE}' + d[1] + d[0]), 'row/column diacritics are wrong — the image would render offset');
});

test('tmux wrapping doubles every ESC and fences the payload', () => {
  // MEASURED: unwrapped, tmux forwards 0 of 38 graphics escapes and the cat silently never
  // appears. Wrapped, all 38 survive and it renders. The doubling is not decoration: tmux eats
  // one ESC per pair.
  const wrapped = wrapForTmux('\x1b_Ga=T;xyz\x1b\\');
  assert.ok(wrapped.startsWith('\x1bPtmux;'), 'missing the DCS passthrough opener');
  assert.ok(wrapped.endsWith('\x1b\\'), 'missing the DCS terminator');
  assert.ok(wrapped.includes('\x1b\x1b_Ga=T;xyz'), 'inner ESC was not doubled — tmux will swallow it');
});

test('an empty PNG is refused rather than transmitted as nothing', () => {
  assert.throws(() => transmitVirtual(Buffer.alloc(0), { id: 0x1234, cols: 8, rows: 5 }), /empty PNG/);
});
