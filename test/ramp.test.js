import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ramp, identityColors, assertTone } from '../src/theme/ramp.js';

const DARK = { mode: 'dark', satScale: 1 };
const LIGHT = { mode: 'light', satScale: 1 };

test('a missing or malformed tone is an error — an integration must supply it', () => {
  assert.throws(() => assertTone(undefined), /missing SchemeTone/);
  assert.throws(() => assertTone({ satScale: 1 }), /SchemeTone.mode must be "dark" or "light"/);
  assert.throws(() => assertTone({ mode: 'sepia', satScale: 1 }), /SchemeTone.mode must be "dark" or "light"/);
  assert.throws(() => assertTone({ mode: 'dark' }), /SchemeTone.satScale must be a number in 0..2/);
  assert.throws(() => assertTone({ mode: 'dark', satScale: 3 }), /SchemeTone.satScale must be a number in 0..2/);
});

// KILLS: deleting `assertTone(tone)` from inside ramp(). assertTone's INTERNALS are
// covered above, and by loadTone — but nothing above asserts that RAMP ITSELF refuses
// a bad tone, and with the call gone the whole suite stayed green.
//
// THE FIXTURE IS CHOSEN, not arbitrary. A bad `mode` throws even without the guard
// (ANCHORS[mode] is undefined and `anchors.shadow` blows up), so it cannot tell "the
// guard is there" from "it crashed anyway". A bad `satScale` is the one that
// discriminates: unguarded, `62 * 'abc'` is NaN, every channel rounds to NaN, and
// ramp() cheerfully RETURNS `{ shadow: '#NaNNaNNaN', ... }` — garbage colours, no
// throw, straight onto the terminal background. Hence the assertion on the guard's
// own message rather than on "something threw".
test('ramp() itself rejects a malformed tone — it does not paint #NaNNaNNaN', () => {
  assert.throws(
    () => ramp(30, 80, { mode: 'dark', satScale: 'abc' }),
    /SchemeTone\.satScale must be a number in 0\.\.2, got: abc/
  );
});

test('slot 0 in a dark scheme is the ginger ramp', () => {
  assert.deepEqual(identityColors(0, DARK), {
    shadow: '#954d23', base: '#d68251', light: '#e5af8f',
    highlight: '#f1d5c5', backdrop: '#1f1814',
  });
});

test('a light scheme deepens the same hue rather than changing it', () => {
  const dark = identityColors(6, DARK);
  const light = identityColors(6, LIGHT);
  assert.equal(light.base, '#3571b6');
  assert.equal(light.backdrop, '#edf0f3');   // near-white, faintly blue
  assert.notEqual(dark.base, light.base);    // tone differs...
  assert.deepEqual(hueOf(dark.base), hueOf(light.base)); // ...hue does not
});

// Recover the hue from a hex color, to prove the identity hue survives the scheme.
function hueOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
}

test('satScale scales saturation and clamps at 100', () => {
  assert.equal(ramp(22, 62, { mode: 'dark', satScale: 0.5 }).base, '#b58b73');
  assert.equal(ramp(22, 62, { mode: 'dark', satScale: 2 }).base, '#ff7729'); // clamped, not wrapped
});

test('slot 11 is near-greyscale by design — the witches familiar', () => {
  assert.equal(identityColors(11, DARK).base, '#9a8d8d');
});
