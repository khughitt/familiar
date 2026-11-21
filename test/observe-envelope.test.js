import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../src/observe/envelope.js';

const valid = () => ({
  schema: 1, type: 'event', subscriber: 'familiar',
  event: { kind: 'prompt', harness: 'codex', agentId: 'codex:s', sessionId: 's', cwd: '/repo' },
  registry: { generation: 'generation', revision: 2 }, changed: true, reaped: ['codex:old'],
});

test('observer accepts event and reconcile envelopes', () => {
  const event = valid();
  event.event.root = 'codex:root';
  assert.deepEqual(parseEnvelope(JSON.stringify(event)), event);
  const reconcile = { ...valid(), type: 'reconcile', event: null, registry: { generation: null, revision: null } };
  assert.deepEqual(parseEnvelope(JSON.stringify(reconcile)), reconcile);
});

test('empty observer input names the expected envelope', () => {
  for (const text of ['', '  \n']) {
    assert.throws(() => parseEnvelope(text), { message: 'observe: empty input (expected one relay observer envelope)' });
  }
});

test('observer rejects malformed JSON and non-object envelopes', () => {
  for (const text of ['{', '{}\n{}', 'null', '[]', '42']) {
    assert.throws(() => parseEnvelope(text), /^Error: observe: /);
  }
});

test('observer refuses missing and incorrectly typed fields', () => {
  const fields = [
    ['schema', 3], ['type', 'guard'], ['subscriber', 3], ['event', null], ['event', []],
    ...['kind', 'harness', 'agentId', 'sessionId', 'cwd', 'root'].map((key) => [`event.${key}`, 3]),
    ['registry', null], ['registry', []], ['registry.generation', 3], ['registry.revision', '2'],
    ['changed', 1], ['reaped', null], ['reaped', [3]],
  ];
  for (const [field, bad] of fields) {
    for (const missing of [false, true]) {
      if (field === 'event.root' && missing) continue;
      const envelope = valid();
      const keys = field.split('.');
      const parent = keys.length === 1 ? envelope : envelope[keys[0]];
      if (missing) delete parent[keys.at(-1)];
      else parent[keys.at(-1)] = bad;
      assert.throws(() => parseEnvelope(JSON.stringify(envelope)), /^Error: observe: /, `${field} ${missing ? 'missing' : 'invalid'}`);
    }
  }
  assert.throws(() => parseEnvelope(JSON.stringify({ ...valid(), type: 'reconcile' })), /^Error: observe: /);
});

const stopEnvelope = (harness, facts, privateFields = {}) => ({
  schema: 2, type: 'event', subscriber: 'familiar',
  event: {
    schema: 2, kind: 'turn-end', harness, nativeEvent: 'Stop', cwd: '/repo', tool: null,
    identity: { status: 'valid', value: { agentId: `${harness}:s`, sessionId: 's' } },
    facts, private: privateFields,
  },
  registry: { status: 'ready', generation: 'generation', revision: 2 },
});

test('schema 2 preserves agy Stop turn boundaries and the registry position', () => {
  for (const executionNum of [0, 2]) {
    const input = stopEnvelope('agy', { executionNum: { status: 'valid', value: executionNum } });
    const { event, registry } = parseEnvelope(JSON.stringify(input));
    assert.equal(event.agentId, 'agy:s');
    assert.equal(event.stopHookActive, executionNum > 0);
    assert.equal(registry.generation, 'generation');
    assert.equal(registry.revision, 2);
  }
});

test('schema 2 preserves Claude Stop background counts when relay supplies them', () => {
  const input = stopEnvelope('claude-code', { stopHookActive: { status: 'valid', value: false } }, {
    backgroundTasks: { status: 'valid', value: [
      { type: 'subagent', status: 'running' }, { type: 'shell', status: 'pending' },
      { type: 'teammate', status: 'completed' },
    ] },
  });
  const { event } = parseEnvelope(JSON.stringify(input));
  assert.equal(event.stopHookActive, false);
  assert.deepEqual(event.background, { agents: 1, other: 1 });
});

test('schema 2 projects Codex child identity onto the existing registry event kind', () => {
  const input = stopEnvelope('codex', {});
  Object.assign(input.event, { kind: 'child-start', nativeEvent: 'SubagentStart',
    identity: { status: 'valid', value: { agentId: 'codex:s', sessionId: 's', root: 'codex:root' } },
  });
  const { event } = parseEnvelope(JSON.stringify(input));
  assert.equal(event.kind, 'session-start');
  assert.equal(event.nativeEvent, 'SubagentStart');
  assert.equal(event.root, 'codex:root');
});

test('schema 2 refuses unusable identity Facts and missing registry positions', () => {
  for (const identity of [{ status: 'missing' }, { status: 'invalid' }, { status: 'valid', value: [] }]) {
    const input = stopEnvelope('agy', {});
    input.event.identity = identity;
    assert.throws(() => parseEnvelope(JSON.stringify(input)), /event.identity/);
  }
  for (const registry of [{ status: 'not-requested' }, { status: 'ready', generation: 'g' }, { status: 'unavailable' }]) {
    const input = stopEnvelope('agy', {});
    input.registry = registry;
    assert.throws(() => parseEnvelope(JSON.stringify(input)), /registry/);
  }
});
