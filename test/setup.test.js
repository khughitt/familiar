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
test('relay setup declares its observers and fits every mapped event budget', () => {
  const document = setupDocument('relay', bin);
  const nonEnd = ['session-start', 'prompt', 'before-tool', 'activity', 'idle', 'needs-input', 'needs-approval', 'turn-end', 'turn-error', 'reconcile'];
  assert.deepEqual(document, { schema: 1, subscribers: [
    { name: 'familiar', role: 'observer', harnesses: ['claude-code', 'codex'], kinds: nonEnd, argv: [bin, 'observe'], timeoutMs: 2000 },
    { name: 'familiar-opencode', role: 'observer', harnesses: ['opencode'], kinds: ['session-start', 'activity', 'idle', 'needs-approval', 'turn-error', 'session-end'], argv: [bin, 'observe'], timeoutMs: 1000 },
    { name: 'familiar-teardown', role: 'observer', harnesses: ['claude-code'], kinds: ['session-end'], argv: [bin, 'observe'], timeoutMs: 400 },
    { name: 'familiar-teardown-codex', role: 'observer', harnesses: ['codex'], kinds: ['session-end'], argv: [bin, 'observe'], timeoutMs: 267 },
  ] });
  const config = validateSubscribers(document);
  for (const harness of ['claude-code', 'codex', 'opencode']) {
    for (const [nativeEvent, { kind }] of Object.entries(adapterFor(harness).events)) {
      assert.doesNotThrow(() => checkBudget(config, budgetFor({ harness, nativeEvent }), { harness, kind }));
    }
  }
  // A cold `familiar observe` takes about 200 ms, so each teardown takes every
  // millisecond relay admits for SessionEnd at that harness's default outer timeout.
  for (const harness of ['claude-code', 'codex']) {
    const [teardown] = checkBudget(config, budgetFor({ harness, nativeEvent: 'SessionEnd' }), { harness, kind: 'session-end' });
    assert.equal(teardown.timeoutMs, budgetFor({ harness, nativeEvent: 'SessionEnd' }).subscribersMs, harness);
  }
  assert.doesNotThrow(() => checkBudget(config, budgetFor({ outerMs: 60000 }), { kind: 'reconcile' }));
});
test('relay setup adds an agy observer only when asked, and it fits every agy event budget', () => {
  const plain = setupDocument('relay', bin);
  assert.ok(plain.subscribers.every(({ harnesses }) => !harnesses.includes('agy')));
  assert.deepEqual(setupDocument('relay', bin, { agy: false }), plain);
  const document = setupDocument('relay', bin, { agy: true });
  assert.deepEqual(document.subscribers.slice(0, -1), plain.subscribers);
  assert.deepEqual(document.subscribers.at(-1), {
    name: 'familiar-agy', role: 'observer', harnesses: ['agy'],
    kinds: ['session-start', 'before-tool', 'turn-end'], argv: [bin, 'observe'], timeoutMs: 2000,
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
