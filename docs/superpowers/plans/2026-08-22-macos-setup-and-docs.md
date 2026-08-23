# macOS Setup and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-mutating Claude Code setup output, declare Node 22, and keep
Codex configuration gated until its executor boundary is measured.

**Architecture:** One pure setup module owns the Claude Code JSON document.
`bin/familiar` resolves its own real path and only prints that document; it never
reads or writes agent configuration. Claude Code commands use POSIX shell quoting
at its documented `sh -c` boundary. Codex command encoding is filled in only
after the physical-Mac process spike records its executor boundary.

**Tech Stack:** Node 22 ESM, `node:util.parseArgs`, `node:test`, Markdown.

**Spec:** `docs/specs/2026-08-22-macos-support-design.md` §§1, 7, 8, 9, 10, 13.

**Implementation status (2026-08-23):** The shared Node/install documentation
scope and `familiar setup claude-code` are complete. `familiar setup codex`,
Codex command encoding, and replacement of the committed review-only fixture
remain gated on physical executor evidence.

## Global Constraints

- The current command is `familiar setup claude-code`; universal `-h`/`--help`
  remains available. `familiar setup codex` is pending the physical executor gate.
- Leaf commands accept no other flags or positional arguments.
- Resolve the checkout's real `bin/familiar` path before command encoding and JSON serialization.
- POSIX-shell-quote Claude Code paths. Do not expose Codex setup until Task 1 of
  the process/runtime plan records its executor behavior and this plan is amended
  if necessary.
- Never inspect, merge, or write `~/.claude` or `~/.codex`.
- Keep Familiar's existing `~/.config` and `~/.local/state` paths on macOS.
- Add `engines.node: ">=22"`; add no dependency or packaging channel.
- Use conventional commits without attribution trailers.

---

### Task 1: Make Claude setup a single pure source of truth

**Precondition:** Complete Task 1 of
`2026-08-22-macos-process-runtime-and-ci.md`. The code and Codex assertions below
apply only when its evidence note confirms that Codex interprets hook commands
through a shell. If it does not, revise and reapprove the Codex portions before
writing them. If a physical Mac is unavailable, complete the Claude Code parts
of this plan and omit every Codex-labeled branch, assertion, CLI leaf, and
documentation instruction until the gate is resolved.

**Approved deviation / implementation note:** A physical Mac was unavailable,
so commits `8bd16a8` and `f65e3a3` completed the Claude Code scope only. The
Codex generator, CLI leaf, and fixture deletion from the original plan were
omitted and remain gated; the fixture is retained for review, not installation.

**Files:**
- Create: `src/install/setup.js`
- Create: `test/setup.test.js`
- Originally proposed delete after the gate: `integrations/codex/hooks.json`
- Originally proposed modify after the gate: `test/codex.test.js`

**Interfaces:**
- Produces now: `shellQuote(value: string): string` and
  `setupDocument(agent: 'claude-code', binPath: string): object`. The original
  `'codex'` branch remains deferred.
- Consumes: no filesystem or environment state; callers supply the resolved binary path.

- [x] **Step 1: Write failing quoting and document tests**

The Claude assertions below are complete. The original Codex assertion remains
deferred, so this mixed step stays unchecked.

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

// Deferred until the Codex executor boundary is measured:
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

- [x] **Step 2: Run the test and confirm the module is missing**

Run:

```bash
node --test test/setup.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/install/setup.js`.

- [x] **Step 3: Implement the pure generator**

The Claude generator below is complete. The originally proposed Codex branch
remains deferred, so this mixed step stays unchecked.

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

// Deferred until the Codex executor boundary is measured:
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
  // Deferred: if (agent === 'codex') return codex(binPath);
  throw new Error(`unknown setup target ${JSON.stringify(agent)}`);
}
```

- [ ] **Step 4: Replace the Codex fixture after executor evidence**

UNBLOCKED 2026-08-23, still unimplemented. The executor boundary is measured:
Codex runs its single-string hook command through `/bin/zsh -c`, confirmed in
both the Kitty and Ghostty captures with a deliberately unquoted path and a
`; :` canary (docs/ref/2026-08-23-macos-agent-process-spike.md). Single-quote
shell quoting is correct there. Until `setup codex` is written,
`integrations/codex/hooks.json` remains a review-only fixture and is not
documented as installable configuration.

- [x] **Step 5: Run focused tests**

Run:

```bash
node --test test/setup.test.js test/codex.test.js
```

Expected: both files pass.

- [ ] **Step 6: Commit the complete two-agent task**

The Claude-only commit exists as `8bd16a8`. The original two-agent commit now
waits only on writing Step 4, not on evidence.

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
- Consumes: `setupDocument('claude-code', realpathSync(fileURLToPath(import.meta.url)))` from Task 1.
- Produces now: `familiar setup claude-code`, writing pretty two-space JSON
  plus exactly one final newline. `setup codex` remains an unknown command.

- [x] **Step 1: Add failing command-resolution and process tests**

Extend the root-family assertions and `leaves` list in `test/cli-help.test.js`
with `setup` and `setup claude-code`. Add to `test/bin-familiar.test.js`:

```js
test('setup claude-code prints exact JSON without reading configuration', () => {
  const runEnv = env();
  const result = spawnSync(process.execPath, [bin, 'setup', 'claude-code'], {
    encoding: 'utf8', env: runEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(result.stdout),
    setupDocument('claude-code', realpathSync(bin)));
  assert.deepEqual(readdirSync(runEnv.FAMILIAR_STATE_DIR), []);
});

test('setup claude-code rejects extra arguments and unknown flags', () => {
  for (const args of [
    ['setup', 'claude-code', 'extra'],
    ['setup', 'claude-code', '--write'],
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

- [x] **Step 2: Run the focused tests and confirm `setup` is unknown**

Run:

```bash
node --test --test-name-pattern='setup|root and bare families|every leaf' test/cli-help.test.js test/bin-familiar.test.js
```

Expected: FAIL because the new family is unresolved.

- [x] **Step 3: Add the family, help, and main branch**

In `bin/familiar`:

```js
import { setupDocument } from '../src/install/setup.js';

// FAMILIES
['setup', new Set(['claude-code'])],
```

Add `setup` and the Claude Code leaf to `HELP`, include it beneath the root
`Set up` heading, and add this branch before mutating install commands:

```js
} else if (command === 'setup claude-code') {
  parseLeaf(rest, { help: command });
  const binPath = realpathSync(fileURLToPath(import.meta.url));
  process.stdout.write(`${JSON.stringify(setupDocument('claude-code', binPath), null, 2)}\n`);
```

Do not add the command to `COSMETIC_COMMANDS`; invalid user setup must exit nonzero.

- [x] **Step 4: Run CLI tests and the fast suite**

Run:

```bash
node --test test/setup.test.js test/cli-help.test.js test/bin-familiar.test.js
npm test
```

Expected: all tests pass and the help inventory names the Claude setup leaf exactly once.

- [x] **Step 5: Commit**

```bash
git add bin/familiar test/cli-help.test.js test/bin-familiar.test.js
git commit -m "feat(cli): add Claude Code setup command"
```

---

### Task 3: Rewrite installation guidance and declare Node 22

**Files:**
- Modify: `package.json`
- Modify: `docs/install.md`
- Modify: `README.md`
- Modify: `test/cli-help.test.js`

**Interfaces:**
- Consumes: the Claude setup command from Task 2.
- Produces: shared checkout setup, separate macOS/Linux integration sections,
  generated Claude JSON, and an explicitly review-only Codex fixture.

- [x] **Step 1: Add the engine declaration**

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

- [x] **Step 2: Replace `docs/install.md` with shared, macOS, and Linux sections**

The shared section must contain checkout installation, scheme, and theme commands:

```sh
git clone https://github.com/khughitt/familiar.git
cd familiar
npm install
npm link
familiar scheme set dark
familiar theme add <theme-url-or-directory>
```

The Claude agent configuration section must say:

```sh
familiar setup claude-code
```

and instruct the user to review and merge stdout into
`~/.claude/settings.json`. The Codex section must identify
`integrations/codex/hooks.json` as review-only and not installable until the
physical executor gate resolves its path placeholder and command encoding.

The macOS section must include:

- `familiar install pets --sync-projects` and `familiar install opencode`.
- A provisional Kitty/Ghostty checklist covering the three agents.
- An explicit note that OpenCode renderer graphics, tint, bell, and live terminal delivery remain provisional pending the physical-Mac gate.

Tell the user to run `command -v node`, then use that absolute path plus the
absolute checkout `bin/familiar` path in this LaunchAgent before saving it as
`~/Library/LaunchAgents/dev.familiar.reap.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.familiar.reap</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
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

- [x] **Step 3: Update README installation links and stale command checks**

Keep README concise: state Node 22+, link to `docs/install.md`, and do not
duplicate generated JSON. Extend `test/cli-help.test.js`'s current-surface scan
so obsolete literal Claude hook/status-line paths fail. The Codex fixture path
is intentionally named in installation documentation as review-only.

```js
const retiredClaudeSetup = /\/path\/to\/familiar\/bin\/familiar (?:hook|statusline)/u;
```

Apply that expression to user-facing Markdown alongside the existing retired CLI scan.

- [x] **Step 4: Verify documentation and package metadata**

Run:

```bash
rg -n 'familiar setup codex|cp integrations/codex/hooks|replace only the binary path' README.md docs/install.md docs/surfaces.md
npm test
npm install --package-lock-only --ignore-scripts
git diff --check
```

Expected: `rg` finds no stale user instructions; tests pass; the second lockfile
command produces no diff.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md docs/install.md test/cli-help.test.js
git commit -m "docs(install): add shared macOS setup"
```
