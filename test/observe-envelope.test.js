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
    ['schema', 2], ['type', 'guard'], ['subscriber', 3], ['event', null], ['event', []],
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
