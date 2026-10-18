import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHexColor, hexToHsl, oklchChroma } from '../src/protocol/color.js';

test('hexToHsl recovers unrounded HSL', () => {
  const fam = hexToHsl('#bc8369');
  assert.equal(fam.h.toFixed(2), '18.80');
  assert.equal(fam.s.toFixed(2), '38.25');
  assert.equal(fam.l.toFixed(2), '57.45');
  assert.deepEqual(hexToHsl('#ff0000'), { h: 0, s: 100, l: 50 });
  assert.equal(hexToHsl('#808080').s, 0);
});

test('oklchChroma separates the grey projects from the most muted colour', () => {
  assert.equal(oklchChroma('#776558').toFixed(4), '0.0305');
  assert.equal(oklchChroma('#947782').toFixed(4), '0.0392');
  assert.equal(oklchChroma('#859982').toFixed(4), '0.0405');
  assert.equal(oklchChroma('#72638f').toFixed(4), '0.0698');
  assert.ok(oklchChroma('#808080') < 1e-6);
});

test('assertHexColor accepts only lowercase #rrggbb', () => {
  assert.equal(assertHexColor('#bc8369'), '#bc8369');
  for (const bad of ['#BC8369', '#abc', 'bc8369', 'red', '', null, undefined, 42]) {
    assert.throws(() => assertHexColor(bad), /not a #rrggbb colour/);
  }
});
