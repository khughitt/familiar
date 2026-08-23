# macOS agent-process handoff

This runbook closes only Familiar's Darwin ancestry and hook-executor gate. It
uses Kitty and one authenticated tool event from Claude Code, Codex, and
OpenCode. It does not test visible graphics, tint, or bell behavior.

The `spike/macos-agent-handoff` branch is disposable and must never be merged.
Its opt-in probe records only Familiar's process and its ancestors, not the
machine-wide process table. Even that narrow chain can contain private command
arguments, so raw output stays in `$TMPDIR` and must not be committed.

## Prerequisites

- macOS 14 or newer on Apple Silicon.
- Node.js 22 or newer and Kitty.
- Authenticated, working installations of Claude Code, Codex, and OpenCode.
- Permission to make and restore temporary edits to each agent's configuration.

Run the entire handoff from a Kitty shell. Use a checkout path without spaces;
Codex command quoting is the fact being measured, not an assumption this probe
may make.

## 1. Check out and verify the disposable branch

```sh
cd "$HOME"
git clone --branch spike/macos-agent-handoff --single-branch \
  https://github.com/khughitt/familiar.git familiar-macos-handoff
cd familiar-macos-handoff
npm ci
npm test
export FAMILIAR_HANDOFF_ROOT="$(pwd -P)"
export FAMILIAR_HANDOFF_BIN="$FAMILIAR_HANDOFF_ROOT/bin/familiar"
test -x "$FAMILIAR_HANDOFF_BIN"
git rev-parse HEAD
```

The expected branch and commit are recorded in the handoff message. Stop if
either differs, or if the suite fails.

## 2. Prepare private output and record versions

Resolve the same temporary root that the Node probe uses:

```sh
export FAMILIAR_NODE_TMP="$(node -e '
  process.stdout.write(require("node:os").tmpdir())
')"
export FAMILIAR_PROBE_DIR="$FAMILIAR_NODE_TMP/familiar-macos-process-spike"
test ! -e "$FAMILIAR_PROBE_DIR"
mkdir -m 700 "$FAMILIAR_PROBE_DIR"
```

If the `test` command fails, stop and move the existing directory aside. Do not
overwrite evidence from an earlier attempt.

Record the environment without recording general environment variables:

```sh
{
  date -u '+captured-at=%Y-%m-%dT%H:%M:%SZ'
  sw_vers
  printf 'architecture='; uname -m
  printf 'node='; node --version
  printf 'kitty='; kitty --version
  printf 'claude='; claude --version
  printf 'codex='; codex --version
  printf 'opencode='; opencode --version
  printf 'familiar-commit='; git rev-parse HEAD
} > "$FAMILIAR_PROBE_DIR/versions.txt"
chmod 600 "$FAMILIAR_PROBE_DIR/versions.txt"
```

## 3. Back up configuration

Do not replace an agent's complete configuration. Create a private backup, then
merge only the temporary hook entries described below.

```sh
export FAMILIAR_BACKUP_DIR="$(mktemp -d "$FAMILIAR_NODE_TMP/familiar-macos-config.XXXXXX")"
mkdir -m 700 "$FAMILIAR_BACKUP_DIR/claude" \
  "$FAMILIAR_BACKUP_DIR/codex" "$FAMILIAR_BACKUP_DIR/opencode"
export FAMILIAR_CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
export FAMILIAR_OPENCODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
```

Back up each present file; create the corresponding `.absent` marker when it
does not exist:

```sh
if [ -f "$HOME/.claude/settings.json" ]; then
  cp -p "$HOME/.claude/settings.json" "$FAMILIAR_BACKUP_DIR/claude/settings.json"
else
  : > "$FAMILIAR_BACKUP_DIR/claude/settings.absent"
fi

if [ -f "$FAMILIAR_CODEX_DIR/hooks.json" ]; then
  cp -p "$FAMILIAR_CODEX_DIR/hooks.json" "$FAMILIAR_BACKUP_DIR/codex/hooks.json"
else
  : > "$FAMILIAR_BACKUP_DIR/codex/hooks.absent"
fi

for name in tui.json opencode.json; do
  if [ -f "$FAMILIAR_OPENCODE_DIR/$name" ]; then
    cp -p "$FAMILIAR_OPENCODE_DIR/$name" "$FAMILIAR_BACKUP_DIR/opencode/$name"
  else
    : > "$FAMILIAR_BACKUP_DIR/opencode/$name.absent"
  fi
done
```

## 4. Capture Claude Code

Append one temporary `PreToolUse` hook without changing unrelated settings. The
command obtains Familiar's existing shell-quoted form from the setup generator,
writes a private temporary file, and atomically replaces the settings file:

```sh
node --input-type=module <<'NODE'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const path = join(process.env.HOME, '.claude', 'settings.json');
let config = {};
try {
  config = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (typeof config !== 'object' || config === null || Array.isArray(config)) {
  throw new Error(`${path}: root must be an object`);
}
if (config.hooks !== undefined
    && (typeof config.hooks !== 'object' || config.hooks === null || Array.isArray(config.hooks))) {
  throw new Error(`${path}: hooks must be an object`);
}
const current = config.hooks?.PreToolUse ?? [];
if (!Array.isArray(current)) throw new Error(`${path}: hooks.PreToolUse must be an array`);

const modulePath = join(process.env.FAMILIAR_HANDOFF_ROOT, 'src', 'install', 'setup.js');
const { setupDocument } = await import(pathToFileURL(modulePath));
const entry = setupDocument('claude-code', process.env.FAMILIAR_HANDOFF_BIN)
  .hooks.PreToolUse[0];
entry.hooks[0].command += ' ; :';
config.hooks = { ...config.hooks, PreToolUse: [...current, entry] };

mkdirSync(dirname(path), { recursive: true });
const temporary = `${path}.familiar-spike-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, path);
NODE
```

Launch a fresh authenticated session with the probe label inherited by its
hooks:

```sh
FAMILIAR_MACOS_SPIKE=claude-code claude
```

Ask Claude Code exactly:

```text
Run `printf familiar-macos-probe` once using the terminal tool.
```

Exit the session after that tool call. Confirm that
`$FAMILIAR_PROBE_DIR/claude-code.jsonl` exists and is non-empty.

## 5. Capture Codex

Append one temporary `PreToolUse` hook without changing unrelated events. This
command deliberately leaves the no-space binary path unquoted and appends the
canary; Codex's treatment of that single string is the fact being measured:

```sh
node --input-type=module <<'NODE'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const path = join(process.env.FAMILIAR_CODEX_DIR, 'hooks.json');
let config = {};
try {
  config = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (typeof config !== 'object' || config === null || Array.isArray(config)) {
  throw new Error(`${path}: root must be an object`);
}
if (config.hooks !== undefined
    && (typeof config.hooks !== 'object' || config.hooks === null || Array.isArray(config.hooks))) {
  throw new Error(`${path}: hooks must be an object`);
}
const current = config.hooks?.PreToolUse ?? [];
if (!Array.isArray(current)) throw new Error(`${path}: hooks.PreToolUse must be an array`);

const entry = {
  matcher: '*',
  hooks: [{
    type: 'command',
    command: `${process.env.FAMILIAR_HANDOFF_BIN} hook PreToolUse --agent codex; :`,
  }],
};
config.hooks = { ...config.hooks, PreToolUse: [...current, entry] };

mkdirSync(dirname(path), { recursive: true });
const temporary = `${path}.familiar-spike-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, path);
NODE
```

The probe runs before Familiar parses the canary tokens. Therefore both a shell
executor and a whitespace-splitting executor can leave ancestry evidence; the
recorded chain, not hook success, decides which behavior occurred.

Launch a fresh authenticated session:

```sh
FAMILIAR_MACOS_SPIKE=codex codex
```

Ask Codex exactly:

```text
Run `printf familiar-macos-probe` once using the terminal tool.
```

Exit after the tool call. Confirm that `$FAMILIAR_PROBE_DIR/codex.jsonl` exists
and is non-empty. If it does not, preserve the exact Codex diagnostic in
`notes.md`; do not infer executor behavior from the JSON field shape.

## 6. Capture OpenCode

Install Familiar's two OpenCode registrations into the existing config. The
backups above make this reversible:

```sh
"$FAMILIAR_HANDOFF_BIN" install opencode
```

Launch a fresh authenticated session:

```sh
FAMILIAR_MACOS_SPIKE=opencode opencode
```

Ask OpenCode exactly:

```text
Run `printf familiar-macos-probe` once using the terminal tool.
```

Exit after the tool call. Confirm that
`$FAMILIAR_PROBE_DIR/opencode.jsonl` exists and is non-empty.

## 7. Validate the raw artifact inventory

```sh
for agent in claude-code codex opencode; do
  test -s "$FAMILIAR_PROBE_DIR/$agent.jsonl"
done
```

Each line is one JSON record. A valid record has:

- `agent`, `event`, `capturedAt`, and the Familiar `hookPid`;
- a `chain` beginning at that exact PID;
- paired raw `comm` and `command` rows for every ancestor;
- matching PID/PPID values in each pair; and
- a final PID 1 / PPID 0 row.

There may be several records per agent because lifecycle hooks can fire around
the requested tool event. Keep them all. The evaluator will select the real
tool-event chain and follow its PPIDs.

## 8. Redact copies, never the raw evidence

Create a separate return directory:

```sh
export FAMILIAR_RETURN_DIR="$FAMILIAR_NODE_TMP/familiar-macos-process-return"
test ! -e "$FAMILIAR_RETURN_DIR"
mkdir -m 700 "$FAMILIAR_RETURN_DIR"
cp "$FAMILIAR_PROBE_DIR/versions.txt" "$FAMILIAR_RETURN_DIR/"
cp "$FAMILIAR_PROBE_DIR/"*.jsonl "$FAMILIAR_RETURN_DIR/"
chmod 600 "$FAMILIAR_RETURN_DIR/"*
```

Edit only the copies. Review every `command` string and apply these rules:

- Replace the account name in `/Users/<name>/...` with `/Users/REDACTED/...`.
- Replace private repository/workspace names and unrelated command arguments
  with `<REDACTED>`.
- Remove tokens, credentials, private URLs, prompt text, and user-provided
  secrets completely.
- Preserve every PID, PPID, TTY, `lstart`, executable basename, agent name,
  `/bin/sh` or shell frame, `-c`, and the `; :` canary. These are the evidence.
- Keep JSON valid and keep `comm` and `command` rows paired.

Do not commit either directory. Return only the redacted directory through the
agreed private channel. Keep the raw directory private until the evidence note
has been accepted, then delete it locally.

## 9. Add tester notes

Create `$FAMILIAR_RETURN_DIR/notes.md` with this exact checklist:

```markdown
# macOS process handoff notes

- Tester:
- Capture date (UTC):
- Mac model / architecture:
- macOS version:
- Kitty version:
- Familiar commit:

## Claude Code
- Version:
- Authenticated tool event completed: yes/no
- `claude-code.jsonl` present: yes/no
- Diagnostic or unexpected behavior: none / describe

## Codex
- Version:
- Authenticated tool event completed: yes/no
- `codex.jsonl` present: yes/no
- Diagnostic or unexpected behavior: none / describe exactly

## OpenCode
- Version:
- Authenticated tool event completed: yes/no
- `opencode.jsonl` present: yes/no
- Diagnostic or unexpected behavior: none / describe

## Restoration
- Claude settings restored: yes/no
- Codex hooks restored: yes/no
- OpenCode configs restored: yes/no
```

The return directory must contain exactly:

```text
versions.txt
claude-code.jsonl
codex.jsonl
opencode.jsonl
notes.md
```

## 10. Restore configuration

Close all three agents first. Restore every file that existed before the test;
remove only a file whose matching `.absent` marker proves the probe created it.

```sh
if [ -f "$FAMILIAR_BACKUP_DIR/claude/settings.json" ]; then
  cp -p "$FAMILIAR_BACKUP_DIR/claude/settings.json" "$HOME/.claude/settings.json"
elif [ -f "$FAMILIAR_BACKUP_DIR/claude/settings.absent" ]; then
  rm -f "$HOME/.claude/settings.json"
fi

if [ -f "$FAMILIAR_BACKUP_DIR/codex/hooks.json" ]; then
  cp -p "$FAMILIAR_BACKUP_DIR/codex/hooks.json" "$FAMILIAR_CODEX_DIR/hooks.json"
elif [ -f "$FAMILIAR_BACKUP_DIR/codex/hooks.absent" ]; then
  rm -f "$FAMILIAR_CODEX_DIR/hooks.json"
fi

for name in tui.json opencode.json; do
  if [ -f "$FAMILIAR_BACKUP_DIR/opencode/$name" ]; then
    cp -p "$FAMILIAR_BACKUP_DIR/opencode/$name" "$FAMILIAR_OPENCODE_DIR/$name"
  elif [ -f "$FAMILIAR_BACKUP_DIR/opencode/$name.absent" ]; then
    rm -f "$FAMILIAR_OPENCODE_DIR/$name"
  fi
done
```

Re-open each restored JSON/JSONC file once before deleting the backup directory.
Do not merge this branch. Its only durable output is the later reviewed and
redacted `docs/ref/2026-08-22-macos-agent-process-spike.md` evidence note.
