# macOS Setup and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-mutating Claude Code and Codex setup output, declare Node 22, and replace path-placeholder installation instructions with generated configuration.

**Architecture:** One pure setup module owns both JSON documents. `bin/familiar` resolves its own real path and only prints the selected document; it never reads or writes agent configuration. Claude Code commands use POSIX shell quoting at its documented `sh -c` boundary. Codex command encoding is filled in only after the physical-Mac process spike records its executor boundary.

**Tech Stack:** Node 22 ESM, `node:util.parseArgs`, `node:test`, Markdown.

**Spec:** `docs/specs/2026-08-22-macos-support-design.md` §§1, 7, 8, 9, 10, 13.

## Global Constraints

- Commands are `familiar setup claude-code` and `familiar setup codex`; universal `-h`/`--help` remains available.
- Leaf commands accept no other flags or positional arguments.
- Resolve the checkout's real `bin/familiar` path before command encoding and JSON serialization.
- POSIX-shell-quote Claude Code paths. Apply the same encoding to Codex only if Task 1 of the process/runtime plan records a shell frame; otherwise stop and amend this plan from the measured executor behavior.
- Never inspect, merge, or write `~/.claude` or `~/.codex`.
- Keep Familiar's existing `~/.config` and `~/.local/state` paths on macOS.
- Add `engines.node: ">=22"`; add no dependency or packaging channel.
- Use conventional commits without attribution trailers.

---

### Task 1: Make setup documents a single pure source of truth

**Precondition:** Complete Task 1 of
`2026-08-22-macos-process-runtime-and-ci.md`. The code and Codex assertions below
apply only when its evidence note confirms that Codex interprets hook commands
through a shell. If it does not, revise and reapprove the Codex portions before
writing them. If a physical Mac is unavailable, complete the Claude Code parts
of this plan and omit every Codex-labeled branch, assertion, CLI leaf, and
documentation instruction until the gate is resolved.

**Files:**
- Create: `src/install/setup.js`
- Create: `test/setup.test.js`
- Delete: `integrations/codex/hooks.json`
- Modify: `test/codex.test.js`

**Interfaces:**
- Produces: `shellQuote(value: string): string` and `setupDocument(agent: 'claude-code' | 'codex', binPath: string): object`.
- Consumes: no filesystem or environment state; callers supply the resolved binary path.

- [ ] **Step 1: Write failing quoting and document tests**

Create `test/setup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, setupDocument } from '../src/install/setup.js';

test('shellQuote preserves spaces and single quotes at an sh -c boundary', () => {
  assert.equal(
    shellQuote("/tmp/Familiar's Build/bin/familiar"),
    "'/tmp/Familiar'\\''s Build/bin/familiar'"
  );
});

test('Claude setup contains every lifecycle hook and the status line', () => {
  const document = setupDocument('claude-code', '/tmp/Familiar Build/bin/familiar');
  assert.deepEqual(Object.keys(document.hooks), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification',
    'Stop', 'StopFailure', 'SessionEnd',
  ]);
  assert.equal(document.hooks.Notification.length, 2);
  assert.equal(document.statusLine.refreshInterval, 2);
  assert.equal(
    document.statusLine.command,
    "'/tmp/Familiar Build/bin/familiar' statusline"
  );
});

test('Codex setup contains the six supported events and explicit agent selection', () => {
  const document = setupDocument('codex', '/tmp/Familiar Build/bin/familiar');
  assert.deepEqual(Object.keys(document.hooks), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PermissionRequest', 'Stop', 'SessionEnd',
  ]);
  assert.equal(document.hooks.SessionEnd[0].hooks[0].command,
    "'/tmp/Familiar Build/bin/familiar' hook SessionEnd --agent codex");
});

test('setupDocument rejects an unknown agent', () => {
  assert.throws(() => setupDocument('cursor', '/bin/familiar'), /unknown setup target "cursor"/);
});
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run:

```bash
node --test test/setup.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/install/setup.js`.

- [ ] **Step 3: Implement the pure generator**

Create `src/install/setup.js` with the complete maps, not templates or string replacement:

```js
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const commandHook = (command, matcher) => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks: [{ type: 'command', command }],
});

const commandFor = (bin, event, agent) =>
  `${shellQuote(bin)} hook ${event}${agent ? ` --agent ${agent}` : ''}`;

function claudeCode(bin) {
  const command = (event) => commandFor(bin, event);
  return {
    hooks: {
      SessionStart: [commandHook(command('SessionStart'), 'startup|resume')],
      UserPromptSubmit: [commandHook(command('UserPromptSubmit'))],
      PreToolUse: [commandHook(command('PreToolUse'), '*')],
      Notification: [
        commandHook(command('Notification:idle_prompt'), 'idle_prompt'),
        commandHook(command('Notification:permission_prompt'), 'permission_prompt'),
      ],
      Stop: [commandHook(command('Stop'))],
      StopFailure: [commandHook(command('StopFailure'))],
      SessionEnd: [commandHook(command('SessionEnd'))],
    },
    statusLine: {
      type: 'command',
      command: `${shellQuote(bin)} statusline`,
      refreshInterval: 2,
    },
  };
}

function codex(bin) {
  const hook = (event, matcher) =>
    commandHook(commandFor(bin, event, 'codex'), matcher);
  return {
    hooks: {
      SessionStart: [hook('SessionStart')],
      UserPromptSubmit: [hook('UserPromptSubmit')],
      PreToolUse: [hook('PreToolUse', '*')],
      PermissionRequest: [hook('PermissionRequest')],
      Stop: [hook('Stop')],
      SessionEnd: [hook('SessionEnd')],
    },
  };
}

export function setupDocument(agent, binPath) {
  if (agent === 'claude-code') return claudeCode(binPath);
  if (agent === 'codex') return codex(binPath);
  throw new Error(`unknown setup target ${JSON.stringify(agent)}`);
}
```

- [ ] **Step 4: Remove the duplicate Codex fixture**

Delete `integrations/codex/hooks.json`. In `test/codex.test.js`, remove its `readFileSync` import and replace the file-reading test with:

```js
import { setupDocument } from '../src/install/setup.js';

test('generated Codex hooks invoke Familiar for SessionEnd', () => {
  const document = setupDocument('codex', '/path/to/familiar/bin/familiar');
  assert.equal(
    document.hooks.SessionEnd[0].hooks[0].command,
    "'/path/to/familiar/bin/familiar' hook SessionEnd --agent codex"
  );
});
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/setup.test.js test/codex.test.js
```

Expected: both files pass.

- [ ] **Step 6: Commit**

```bash
git add src/install/setup.js test/setup.test.js test/codex.test.js integrations/codex/hooks.json
git commit -m "feat(setup): generate agent configuration"
```

---

### Task 2: Expose setup through the CLI

**Files:**
- Modify: `bin/familiar`
- Modify: `test/cli-help.test.js`
- Modify: `test/bin-familiar.test.js`

**Interfaces:**
- Consumes: `setupDocument(agent, realpathSync(fileURLToPath(import.meta.url)))` from Task 1.
- Produces: `familiar setup claude-code|codex`, each writing pretty two-space JSON plus exactly one final newline.

- [ ] **Step 1: Add failing command-resolution and process tests**

Extend the root-family assertions and `leaves` list in `test/cli-help.test.js` with `setup`, `setup claude-code`, and `setup codex`. Add to `test/bin-familiar.test.js`:

```js
test('setup commands print exact JSON without reading user configuration', () => {
  const runEnv = env();
  for (const agent of ['claude-code', 'codex']) {
    const result = spawnSync(process.execPath, [bin, 'setup', agent], {
      encoding: 'utf8', env: runEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.endsWith('\n'), true);
    assert.deepEqual(
      JSON.parse(result.stdout),
      setupDocument(agent, realpathSync(bin))
    );
  }
  assert.deepEqual(readdirSync(runEnv.FAMILIAR_STATE_DIR), []);
});

test('setup leaves reject extra arguments and unknown flags', () => {
  for (const args of [
    ['setup', 'claude-code', 'extra'],
    ['setup', 'codex', '--write'],
  ]) {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8', env: env(),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unexpected argument|unknown option/);
  }
});
```

Import `setupDocument` and `realpathSync` in that test file.

Add one integration test whose actual package target contains spaces. Create a temporary `Familiar Build` directory; copy `bin/familiar` into its `bin/`, symlink the checkout's `src`, `integrations`, and `node_modules` into it, then invoke the copied binary through a separate npm-prefix-style symlink. Assert the generated status-line command begins with the single-quoted real copied path, not the prefix symlink:

```js
test('setup resolves an npm-style link to a checkout path containing spaces', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-setup-link-'));
  const checkout = join(root, 'Familiar Build');
  const prefix = join(root, 'prefix', 'bin');
  mkdirSync(join(checkout, 'bin'), { recursive: true });
  mkdirSync(prefix, { recursive: true });
  cpSync(bin, join(checkout, 'bin', 'familiar'));
  for (const name of ['src', 'integrations', 'node_modules']) {
    symlinkSync(join(repoRoot, name), join(checkout, name), 'dir');
  }
  const linked = join(prefix, 'familiar');
  symlinkSync(join(checkout, 'bin', 'familiar'), linked);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [linked, 'setup', 'claude-code'], {
    encoding: 'utf8', env: env(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).statusLine.command,
    `'${join(checkout, 'bin', 'familiar')}' statusline`);
});
```

Import `cpSync`, `symlinkSync`, and define `repoRoot` with `fileURLToPath(new URL('..', import.meta.url))` if not already present.

- [ ] **Step 2: Run the focused tests and confirm `setup` is unknown**

Run:

```bash
node --test --test-name-pattern='setup|root and bare families|every leaf' test/cli-help.test.js test/bin-familiar.test.js
```

Expected: FAIL because the new family is unresolved.

- [ ] **Step 3: Add the family, help, and main branch**

In `bin/familiar`:

```js
import { setupDocument } from '../src/install/setup.js';

// FAMILIES
['setup', new Set(['claude-code', 'codex'])],
```

Add `setup` and both leaf entries to `HELP`, include the two commands beneath the root `Set up` heading, and add this branch before mutating install commands:

```js
} else if (command === 'setup claude-code' || command === 'setup codex') {
  parseLeaf(rest, { help: command });
  const agent = command.slice('setup '.length);
  const binPath = realpathSync(fileURLToPath(import.meta.url));
  process.stdout.write(`${JSON.stringify(setupDocument(agent, binPath), null, 2)}\n`);
```

Do not add either command to `COSMETIC_COMMANDS`; invalid user setup must exit nonzero.

- [ ] **Step 4: Run CLI tests and the fast suite**

Run:

```bash
node --test test/setup.test.js test/cli-help.test.js test/bin-familiar.test.js
npm test
```

Expected: all tests pass and the help inventory names both setup leaves exactly once.

- [ ] **Step 5: Commit**

```bash
git add bin/familiar test/cli-help.test.js test/bin-familiar.test.js
git commit -m "feat(cli): print agent setup documents"
```

---

### Task 3: Rewrite installation guidance and declare Node 22

**Files:**
- Modify: `package.json`
- Modify: `docs/install.md`
- Modify: `README.md`
- Modify: `test/cli-help.test.js`

**Interfaces:**
- Consumes: the setup commands from Task 2.
- Produces: shared checkout setup, separate macOS/Linux integration sections, and no hand-maintained Claude/Codex JSON.

- [ ] **Step 1: Add the engine declaration**

Add beside `type` in `package.json`:

```json
"engines": {
  "node": ">=22"
},
```

Run:

```bash
npm install --package-lock-only
```

Expected: `package-lock.json` records the root package engine without changing dependency versions.

- [ ] **Step 2: Replace `docs/install.md` with shared, macOS, and Linux sections**

The shared section must contain checkout installation, scheme, and theme commands:

```sh
git clone https://github.com/khughitt/familiar.git
cd familiar
npm install
npm link
familiar scheme set dark
familiar theme add <theme-url-or-directory>
```

The agent configuration sections must say:

```sh
familiar setup claude-code
familiar setup codex
```

and instruct the user to review and merge stdout into `~/.claude/settings.json` and `$CODEX_HOME/hooks.json`, respectively. Delete all hand-written Claude/Codex JSON and the old `cp integrations/codex/hooks.json` instruction.

The macOS section must include:

- `familiar install pets --sync-projects` and `familiar install opencode`.
- A provisional Kitty/Ghostty checklist covering the three agents.
- An explicit note that OpenCode renderer graphics, tint, bell, and live terminal delivery remain provisional pending the physical-Mac gate.

Use this LaunchAgent shape, instructing the user to replace only the binary path before saving it as `~/Library/LaunchAgents/dev.familiar.reap.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.familiar.reap</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/familiar/bin/familiar</string>
    <string>reap</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Activation commands are:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.familiar.reap.plist
launchctl kickstart gui/$(id -u)/dev.familiar.reap
```

The Linux-only section retains the existing Niri, Noctalia, and systemd material without implying it applies to macOS.

- [ ] **Step 3: Update README installation links and stale command checks**

Keep README concise: state Node 22+, link to `docs/install.md`, and do not duplicate generated JSON. Extend `test/cli-help.test.js`'s current-surface scan so `integrations/codex/hooks.json` is not expected and these stale forms fail:

```js
const retiredSetup = /\/path\/to\/familiar\/bin\/familiar hook|integrations\/codex\/hooks\.json/;
```

Apply that expression to user-facing Markdown alongside the existing retired CLI scan.

- [ ] **Step 4: Verify documentation and package metadata**

Run:

```bash
rg -n '/path/to/familiar/bin/familiar hook|integrations/codex/hooks.json' README.md docs bin test
npm test
npm install --package-lock-only --ignore-scripts
git diff --check
```

Expected: `rg` finds only the deliberate stale-pattern assertion in `test/cli-help.test.js`; tests pass; the second lockfile command produces no diff.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md docs/install.md test/cli-help.test.js
git commit -m "docs(install): add shared macOS setup"
```
