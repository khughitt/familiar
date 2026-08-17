import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { STATES as PROTOCOL_STATES } from 'familiar-theme';

function loadLogic() {
  const path = fileURLToPath(new URL('./logic.js', import.meta.url));
  const source = readFileSync(path, 'utf8').replace(/^\s*\.pragma\s+library\s*$/m, '');
  const context = {};
  vm.runInNewContext(source, context);
  return context;
}

const L = loadLogic();
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function record(state, motionPolicy = 'full', sessionId = 's1') {
  return {
    current: {
      sessionId,
      state,
      motionPolicy,
      sprite: { terminal: `/sprites/${sessionId}/${state}.png`, rows: 12 },
    },
    expiresAt: null,
    after: null,
  };
}

test('the QML state vocabulary matches the portable protocol', () => {
  assert.deepEqual(Object.keys(L.STATES).sort(), [...PROTOCOL_STATES].sort());
});

test('parseIntent rejects malformed records instead of normalizing them', () => {
  assert.deepEqual(plain(L.parseIntent('{}')), { intent: {}, error: null });
  assert.equal(L.parseIntent('').error, 'intent.json: empty');
  assert.equal(L.parseIntent('{broken').error, 'intent.json: invalid json');
  assert.equal(L.parseIntent('[]').error, 'intent.json: not an object');
  assert.match(L.parseIntent(JSON.stringify({ s1: {} })).error, /s1.*current/);
  assert.match(L.parseIntent(JSON.stringify({ s1: record('mystery') })).error, /s1.*state/);
  assert.match(L.parseIntent(JSON.stringify({ s1: record('done', 'sometimes') })).error, /s1.*motionPolicy/);
  const noMaster = record('done');
  delete noMaster.current.sprite.terminal;
  assert.match(L.parseIntent(JSON.stringify({ s1: noMaster })).error, /s1.*sprite\.terminal/);
});

test('the first successful snapshot seeds state without playback', () => {
  const result = L.observe({ s1: record('done') }, {}, false);
  assert.deepEqual(plain(result), { states: { s1: 'done' }, candidate: null });
});

test('later done and error transitions produce exact candidates', () => {
  const done = L.observe({ s1: record('done') }, { s1: 'working' }, true);
  assert.deepEqual(plain(done.candidate), {
    sessionId: 's1', state: 'done', motionPolicy: 'full', sprite: '/sprites/s1/done.png',
  });
  const error = L.observe({ s1: record('error', 'reduced') }, { s1: 'working' }, true);
  assert.deepEqual(plain(error.candidate), {
    sessionId: 's1', state: 'error', motionPolicy: 'reduced', sprite: '/sprites/s1/error.png',
  });
});

test('new post-startup transient sessions trigger, stable and absent states do not', () => {
  assert.equal(L.observe({ s2: record('done', 'full', 's2') }, { s1: 'working' }, true).candidate.sessionId, 's2');
  assert.equal(L.observe({ s1: record('done') }, { s1: 'done' }, true).candidate, null);
  assert.equal(L.observe({ s1: record('working') }, { s1: 'working' }, true).candidate, null);
});

test('error wins and equal-state ties use lexical session id', () => {
  const mixed = L.observe({
    z: record('done', 'full', 'z'),
    b: record('error', 'full', 'b'),
    a: record('error', 'full', 'a'),
  }, { z: 'working', b: 'working', a: 'working' }, true);
  assert.equal(mixed.candidate.sessionId, 'a');
  assert.equal(mixed.candidate.state, 'error');
});

test('a dropped observation still becomes the next comparison baseline', () => {
  const first = L.observe({ s1: record('done') }, { s1: 'working' }, true);
  assert.equal(L.decidePlayback('error', first.candidate).action, 'drop');
  const second = L.observe({ s1: record('done') }, first.states, true);
  assert.equal(second.candidate, null);
});

test('two observed working snapshots never reconstruct an unseen done', () => {
  const result = L.observe({ s1: record('working') }, { s1: 'working' }, true);
  assert.equal(result.candidate, null);
});

test('playback arbitration has one slot, error preemption, and explicit policy', () => {
  const done = L.observe({ s1: record('done') }, { s1: 'working' }, true).candidate;
  const error = L.observe({ s1: record('error', 'reduced') }, { s1: 'working' }, true).candidate;
  const off = L.observe({ s1: record('done', 'off') }, { s1: 'working' }, true).candidate;
  assert.deepEqual(plain(L.decidePlayback(null, done)), { action: 'start', mode: 'full' });
  assert.deepEqual(plain(L.decidePlayback('done', error)), { action: 'preempt', mode: 'reduced' });
  assert.deepEqual(plain(L.decidePlayback('error', done)), { action: 'drop', mode: null });
  assert.deepEqual(plain(L.decidePlayback('done', done)), { action: 'drop', mode: null });
  assert.deepEqual(plain(L.decidePlayback('error', error)), { action: 'drop', mode: null });
  assert.deepEqual(plain(L.decidePlayback(null, off)), { action: 'start', mode: 'off' });
  assert.deepEqual(plain(L.decidePlayback(null, null)), { action: 'none', mode: null });
});

test('focused-output parsing requires one non-empty name', () => {
  assert.deepEqual(plain(L.parseFocusedOutput('{\"name\":\"DP-1\"}')), { name: 'DP-1', error: null });
  assert.match(L.parseFocusedOutput('').error, /empty/);
  assert.match(L.parseFocusedOutput('{}').error, /name/);
  assert.match(L.parseFocusedOutput('[]').error, /object/);
});
