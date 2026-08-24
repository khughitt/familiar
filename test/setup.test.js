import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, setupDocument } from '../src/install/setup.js';
import { HOOK_EVENTS } from '../src/adapters/codex.js';

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

// Codex's executor boundary is measured -- `/bin/zsh -c`, captured on a real Mac with a
// deliberately unquoted path and a `; :` canary, recorded in
// docs/ref/2026-08-23-macos-agent-process-spike.md. Single-quote quoting is correct under both
// that and Claude Code's `/bin/sh -c`, so one shellQuote serves both targets.
test('Codex setup contains the six supported events and explicit agent selection', () => {
  const document = setupDocument('codex', "/tmp/Familiar's Build/bin/familiar");
  assert.deepEqual(Object.keys(document.hooks), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PermissionRequest', 'Stop', 'SessionEnd',
  ]);
  assert.equal(
    document.hooks.SessionEnd[0].hooks[0].command,
    "'/tmp/Familiar'\\''s Build/bin/familiar' hook SessionEnd --agent codex",
  );
  assert.equal(document.hooks.PreToolUse[0].matcher, '*');
});

// Codex renders its own pet and its status line is a closed enum of built-ins, so there are no
// cells for Familiar to print into -- src/adapters/codex.js's printsPlaceholderCells says so.
// Emitting a statusLine key here would be configuration Codex has nowhere to put.
test('Codex setup carries hooks only, with no status line', () => {
  assert.deepEqual(Object.keys(setupDocument('codex', '/bin/familiar')), ['hooks']);
});

// Codex has no idle-prompt notification and no error event (test/codex.test.js states why), so
// the generated document must not invent hooks the adapter would reject.
test('Codex setup emits exactly the events the Codex adapter maps', () => {
  const document = setupDocument('codex', '/bin/familiar');
  assert.deepEqual(Object.keys(document.hooks).sort(), Object.keys(HOOK_EVENTS).sort());
});

test('setupDocument rejects an unknown agent', () => {
  assert.throws(() => setupDocument('cursor', '/bin/familiar'), /unknown setup target "cursor"/);
});
