import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATES, stageToken } from '../src/render/term/stage.js';

const doing = { status: 'doing' };
const out = (code, state) => ({ code, stdout: JSON.stringify({ state }) });

test('tasks fault wins over everything', () => {
  const r = stageToken({ tasks: { fault: 'tasks show: exited 1' }, park: { reason: 'review' }, flow: out(0, 'planned') });
  assert.deepEqual(r, { stage: '—', fault: 'tasks show: exited 1' });
});

test('park rules win over flow, even a failing flow', () => {
  for (const flow of [out(0, 'planned'), { code: 1, stdout: '' }, { timedOut: true }]) {
    assert.deepEqual(stageToken({ tasks: doing, park: { reason: 'review' }, flow }), { stage: 'parked: review', fault: null });
    assert.deepEqual(stageToken({ tasks: doing, park: { waiting_on: 'user' }, flow }), { stage: 'parked: you', fault: null });
    assert.deepEqual(stageToken({ tasks: doing, park: {}, flow }), { stage: 'parked', fault: null });
  }
});

test('flow-state missing shows the tasks status', () => {
  assert.deepEqual(stageToken({ tasks: doing, park: null, flow: { missing: true } }), { stage: 'doing', fault: null });
});

test('exit 0 gate states show the gate name', () => {
  for (const g of GATES) {
    assert.deepEqual(stageToken({ tasks: doing, park: null, flow: out(0, g) }), { stage: g, fault: null });
  }
});

test('exit 3 with a gate state shows the gate with ?', () => {
  for (const g of ['closed', 'planned']) {
    assert.deepEqual(stageToken({ tasks: doing, park: null, flow: out(3, g) }), { stage: `${g}?`, fault: null });
  }
});

test('exit 0 outside shows the tasks status', () => {
  for (const s of ['todo', 'doing', 'blocked', 'idea', 'shelved', 'done', 'dropped']) {
    assert.deepEqual(stageToken({ tasks: { status: s }, park: null, flow: out(0, 'outside') }), { stage: s, fault: null });
  }
});

test('other flow outcomes show gate? with a fault', () => {
  const cases = [
    [{ code: 1, stdout: '' }, 'flow-state: exited 1'],
    [{ code: 2, stdout: '{}' }, 'flow-state: exited 2'],
    [{ timedOut: true }, 'flow-state: timed out'],
    [{ code: 0, stdout: 'not json' }, 'flow-state: unparseable output'],
    [out(3, null), 'flow-state: exit 3 without a gate state'],
    [out(0, 'bogus'), 'flow-state: unknown state bogus'],
  ];
  for (const [flow, fault] of cases) {
    assert.deepEqual(stageToken({ tasks: doing, park: null, flow }), { stage: 'gate?', fault });
  }
});
