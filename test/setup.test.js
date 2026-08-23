import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, setupDocument } from '../src/install/setup.js';

test('shellQuote preserves spaces and single quotes at an sh -c boundary', () => {
  assert.equal(
    shellQuote("/tmp/Familiar's Build/bin/familiar"),
    "'/tmp/Familiar'\\''s Build/bin/familiar'",
  );
});

test('Claude setup contains every lifecycle hook and the status line', () => {
  const document = setupDocument('claude-code', "/tmp/Familiar's Build/bin/familiar");
  assert.deepEqual(Object.keys(document.hooks), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification',
    'Stop', 'StopFailure', 'SessionEnd',
  ]);
  assert.equal(document.hooks.Notification.length, 2);
  assert.equal(document.statusLine.refreshInterval, 2);
  assert.equal(
    document.statusLine.command,
    "'/tmp/Familiar'\\''s Build/bin/familiar' statusline",
  );
});

test('setupDocument rejects Codex until its executor boundary is verified', () => {
  assert.throws(
    () => setupDocument('codex', '/bin/familiar'),
    /unknown setup target "codex"/,
  );
});

test('setupDocument rejects an unknown agent', () => {
  assert.throws(() => setupDocument('cursor', '/bin/familiar'), /unknown setup target "cursor"/);
});
