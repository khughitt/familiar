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
test('relay setup declares all three observers and fits every mapped event budget', () => {
  const document = setupDocument('relay', bin);
  const nonEnd = ['session-start', 'prompt', 'before-tool', 'activity', 'idle', 'needs-input', 'needs-approval', 'turn-end', 'turn-error', 'reconcile'];
  assert.deepEqual(document, { schema: 1, subscribers: [
    { name: 'familiar', role: 'observer', harnesses: ['claude-code', 'codex'], kinds: nonEnd, argv: [bin, 'observe'], timeoutMs: 2000 },
    { name: 'familiar-opencode', role: 'observer', harnesses: ['opencode'], kinds: ['session-start', 'activity', 'idle', 'needs-approval', 'turn-error', 'session-end'], argv: [bin, 'observe'], timeoutMs: 1000 },
    { name: 'familiar-teardown', role: 'observer', harnesses: ['claude-code', 'codex'], kinds: ['session-end'], argv: [bin, 'observe'], timeoutMs: 200 },
  ] });
  const config = validateSubscribers(document);
  for (const harness of ['claude-code', 'codex', 'opencode']) {
    for (const [nativeEvent, { kind }] of Object.entries(adapterFor(harness).events)) {
      assert.doesNotThrow(() => checkBudget(config, budgetFor({ harness, nativeEvent }), { harness, kind }));
    }
  }
  assert.doesNotThrow(() => checkBudget(config, budgetFor({ outerMs: 60000 }), { kind: 'reconcile' }));
});
test('codex and unknown setup targets are rejected', () => {
  for (const target of ['codex', 'cursor']) assert.throws(() => setupDocument(target, bin), /unknown setup target/);
});
