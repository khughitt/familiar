import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, assertState } from 'familiar-theme';
import {
  isTransient, ttlFor, decayTo, presentationFor, displayedIntent,
  TTL_DONE_MS, TTL_ERROR_MS,
} from '../src/protocol/intent.js';

test('there are exactly six states', () => {
  assert.deepEqual(STATES, ['idle', 'working', 'needs-input', 'needs-approval', 'error', 'done']);
});

test('assertState throws on an unknown state rather than defaulting to idle', () => {
  assert.throws(() => assertState('busy'), /unknown state: busy/);
  assert.equal(assertState('working'), 'working');
});

test('only done and error are transient, with per-state TTLs', () => {
  assert.equal(TTL_DONE_MS, 8000);
  assert.equal(TTL_ERROR_MS, 30000);
  assert.deepEqual(STATES.filter(isTransient), ['error', 'done']);
  assert.equal(ttlFor('done'), 8000);
  assert.equal(ttlFor('error'), 30000);
  assert.equal(ttlFor('idle'), null);
});

test('transient states decay to idle; asking a persistent state to decay is a bug', () => {
  assert.equal(decayTo('done'), 'idle');
  assert.equal(decayTo('error'), 'idle');
  assert.throws(() => decayTo('working'), /not transient/);
});

test('state owns urgency and motion', () => {
  assert.deepEqual(presentationFor('idle'), { urgency: 'none', motion: 'breathe' });
  assert.deepEqual(presentationFor('working'), { urgency: 'none', motion: 'pulse' });
  assert.deepEqual(presentationFor('needs-input'), { urgency: 'demand', motion: 'pulse' });
  assert.deepEqual(presentationFor('needs-approval'), { urgency: 'demand', motion: 'flash' });
  assert.deepEqual(presentationFor('error'), { urgency: 'demand', motion: 'flash' });
  assert.deepEqual(presentationFor('done'), { urgency: 'notice', motion: 'static' });
});

test('displayedIntent is the whole decay contract: a timed swap, never a computation', () => {
  const current = { state: 'done' };
  const after = { state: 'idle' };

  const transient = { current, expiresAt: 5000, after };
  assert.equal(displayedIntent(transient, 4999).state, 'done');
  assert.equal(displayedIntent(transient, 5000).state, 'idle');
  assert.equal(displayedIntent(transient, 9999).state, 'idle');

  // A persistent state stays until an event changes it. No timer, ever.
  const persistent = { current: { state: 'needs-input' }, expiresAt: null, after: null };
  assert.equal(displayedIntent(persistent, 1e12).state, 'needs-input');
});
