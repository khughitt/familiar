import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { shellQuote, setupDocument } from '../src/install/setup.js';
import { adapterFor, validateSubscribers, budgetFor, checkBudget } from 'relay';

const bin = realpathSync(new URL('../bin/familiar', import.meta.url));
test('shellQuote preserves spaces and single quotes', () => {
  assert.equal(shellQuote("/tmp/Familiar's Build/bin/familiar"), "'/tmp/Familiar'\\''s Build/bin/familiar'");
});
test('Claude setup contains only the status line', () => {
  assert.deepEqual(setupDocument('claude-code', bin), { statusLine: {
    type: 'command', command: `${shellQuote(bin)} statusline`, refreshInterval: 2,
  } });
});
test('schema-2 setup observers fit the released relay installer budgets', () => {
  const document = setupDocument('relay', bin);
  const config = validateSubscribers(document);
  for (const observer of config.subscribers) {
    assert.equal(observer.registry, 'snapshot');
    assert.deepEqual(observer.argv, ['familiar', 'observe']);
  }
  for (const harness of ['claude-code', 'codex', 'opencode']) {
    for (const [nativeEvent, { kind }] of Object.entries(adapterFor(harness).hookEvents)) {
      const outerMs = nativeEvent === 'SessionEnd' ? (harness === 'claude-code' ? 60000 : 3000) : undefined;
      const observers = checkBudget(config, budgetFor({ harness, nativeEvent, outerMs }), { harness, kind, nativeEvent });
      if (harness === 'opencode' || (harness === 'codex' && nativeEvent === 'SessionEnd')
        || ['after-tool', 'tool-error', 'model-change', 'compact-start', 'compact-end'].includes(kind)
        || (harness === 'claude-code' && ['child-start', 'child-stop'].includes(kind))) {
        assert.deepEqual(observers, [], `${harness} ${nativeEvent}`);
      } else {
        assert.equal(observers.length, 1, `${harness} ${nativeEvent}`);
      }
    }
  }
  assert.deepEqual(checkBudget(config, budgetFor({ outerMs: 30000 }), { kind: 'reconcile' }).map(({ name }) => name), ['familiar']);
  assert.deepEqual(config.subscribers[0].privateFields, [{ nativeEvent: 'Stop', fields: ['backgroundTasks'] }]);
});
test('relay setup adds an agy observer only when asked, and it fits every agy event budget', () => {
  const plain = setupDocument('relay', bin);
  assert.ok(plain.subscribers.every(({ harnesses }) => !harnesses.includes('agy')));
  assert.deepEqual(setupDocument('relay', bin, { agy: false }), plain);
  const document = setupDocument('relay', bin, { agy: true });
  assert.deepEqual(document.subscribers.slice(0, -1), plain.subscribers);
  assert.deepEqual(document.subscribers.at(-1), {
    name: 'familiar-agy', role: 'observer', registry: 'snapshot', harnesses: ['agy'],
    kinds: ['session-start', 'before-tool', 'turn-end'], argv: ['familiar', 'observe'], timeoutMs: 2000,
  });
  // Every agy event relay maps reaches familiar, and nothing familiar asks for is unmapped.
  const mapped = Object.values(adapterFor('agy').events).map(({ kind }) => kind);
  assert.deepEqual([...document.subscribers.at(-1).kinds].sort(), [...mapped].sort());
  const config = validateSubscribers(document);
  for (const [nativeEvent, { kind }] of Object.entries(adapterFor('agy').events)) {
    const harness = 'agy';
    assert.deepEqual(checkBudget(config, budgetFor({ harness, nativeEvent }), { harness, kind }).map(({ name }) => name), ['familiar-agy'], nativeEvent);
  }
});

test('codex and unknown setup targets are rejected', () => {
  for (const target of ['codex', 'cursor']) assert.throws(() => setupDocument(target, bin), /unknown setup target/);
});
