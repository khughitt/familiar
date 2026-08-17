import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oscBackground, oscCursor, oscReset, BEL } from '../src/render/term/osc.js';

test('OSC is terminated with ST, not BEL', () => {
  assert.equal(oscBackground('#1f1814'), '\x1b]11;#1f1814\x1b\\');
  assert.equal(oscCursor('#d68251'), '\x1b]12;#d68251\x1b\\');
  assert.equal(oscReset(), '\x1b]111\x1b\\\x1b]112\x1b\\');   // background, then cursor
  assert.equal(BEL, '\x07');
});

test('BEL appears in an OSC sequence nowhere — it means exactly one thing', () => {
  for (const bytes of [oscBackground('#000000'), oscCursor('#000000'), oscReset()]) {
    assert.ok(!bytes.includes(BEL), `${JSON.stringify(bytes)} contains a bell`);
  }
});
