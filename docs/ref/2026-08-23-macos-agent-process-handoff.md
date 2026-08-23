# macOS agent-process handoff

This runbook closes only Familiar's Darwin ancestry and hook-executor gate. It
uses Kitty and one authenticated tool event from Claude Code, Codex, and
OpenCode. It does not test visible graphics, tint, or bell behavior.

The `spike/macos-agent-handoff` branch is disposable and must never be merged.
The tester must not push this branch or any capture to any remote.
Its opt-in probe records only Familiar's process and its ancestors, not the
machine-wide process table. Even that narrow chain can contain private command
arguments, so raw output stays in `$TMPDIR` and must not be committed.

The branch also writes a payload-free execution witness before it checks the
probe environment. That separates "Familiar ran but the environment was not
inherited" from "the hook command never reached Familiar" without recording a
tool payload.

## Prerequisites

- macOS 14 or newer on Apple Silicon.
- Node.js 22 or newer and Kitty.app.
- Authenticated, working installations of Claude Code, Codex, and OpenCode.
- Permission to make and restore temporary edits to each agent's configuration.

Run the entire handoff from a Kitty shell. Use a checkout path without spaces;
Codex command quoting is the fact being measured, not an assumption this probe
may make.

## 1. Check out and verify the disposable branch

```sh
set -eu
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
export FAMILIAR_MACOS_PROBE_DIR="$FAMILIAR_PROBE_DIR"
export FAMILIAR_WITNESS_PATH="$FAMILIAR_HANDOFF_ROOT/.familiar-macos-executed.jsonl"
export FAMILIAR_WITNESS_ENABLE_PATH="$FAMILIAR_HANDOFF_ROOT/.familiar-macos-witness-enabled"
test ! -e "$FAMILIAR_PROBE_DIR"
test ! -e "$FAMILIAR_WITNESS_PATH"
test ! -e "$FAMILIAR_WITNESS_ENABLE_PATH"
mkdir -m 700 "$FAMILIAR_PROBE_DIR"
: > "$FAMILIAR_WITNESS_ENABLE_PATH"
chmod 600 "$FAMILIAR_WITNESS_ENABLE_PATH"
```

If the `test` command fails, stop and move the existing directory aside. Do not
overwrite evidence from an earlier attempt.

Record the environment without recording general environment variables:

```sh
export FAMILIAR_KITTY_BIN="$(command -v kitty 2>/dev/null || true)"
if [ -z "$FAMILIAR_KITTY_BIN" ]; then
  export FAMILIAR_KITTY_BIN="/Applications/kitty.app/Contents/MacOS/kitty"
fi
test -x "$FAMILIAR_KITTY_BIN"

{
  date -u '+captured-at=%Y-%m-%dT%H:%M:%SZ'
  sw_vers
  printf 'architecture='; uname -m
  printf 'node='; node --version
  printf 'kitty='; "$FAMILIAR_KITTY_BIN" --version
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

The temporary atomic replacements below do not preserve a configuration-file
symlink. Stop before making any change if one of the affected files is a
symlink:

```sh
for path in \
  "$HOME/.claude/settings.json" \
  "$FAMILIAR_CODEX_DIR/hooks.json" \
  "$FAMILIAR_OPENCODE_DIR/tui.json" \
  "$FAMILIAR_OPENCODE_DIR/opencode.json"
do
  if [ -L "$path" ]; then
    printf 'stop: configuration is a symlink: %s\n' "$path" >&2
    exit 1
  fi
done
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

After these backups exist, an aborted run is recovered by closing the agents
and going directly to step 10.

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
`$FAMILIAR_PROBE_DIR/claude-code.jsonl` exists and is non-empty. If it does not,
record the exact Claude Code diagnostic in `notes.md` and continue to the
classification in step 7; do not guess why it is absent.

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
`$FAMILIAR_PROBE_DIR/opencode.jsonl` exists and is non-empty. If it does not,
record the exact OpenCode diagnostic and the relevant lines from
`~/.local/state/familiar/opencode-plugin.log` in `notes.md`; do not guess why it
is absent.

## 7. Validate the raw artifact inventory

Print the two independent observations for each agent:

```sh
node --input-type=module <<'NODE'
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const witnesses = existsSync(process.env.FAMILIAR_WITNESS_PATH)
  ? readFileSync(process.env.FAMILIAR_WITNESS_PATH, 'utf8')
    .trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
for (const agent of ['claude-code', 'codex', 'opencode']) {
  const executed = witnesses.some((record) => record.agent === agent);
  const capture = join(process.env.FAMILIAR_PROBE_DIR, `${agent}.jsonl`);
  const captured = existsSync(capture) && statSync(capture).size > 0;
  console.log(`${agent}: executed=${executed ? 'yes' : 'no'} captured=${captured ? 'yes' : 'no'}`);
}
NODE
```

Interpret each pair as follows:

- `executed=yes captured=yes`: Familiar ran and inherited the explicit probe
  environment. Use the ancestor frames to determine shell versus direct spawn.
- `executed=yes captured=no` with a `macOS process probe` diagnostic: the probe
  ran but an identity read failed. Trigger one more harmless tool event and keep
  both the diagnostic and any later record.
- `executed=yes captured=no` without that diagnostic: Familiar ran but the
  `FAMILIAR_MACOS_*` environment did not reach the hook. Record this as a
  milestone finding.
- `executed=no captured=no`: the configured command never reached Familiar.
  Record the agent's exact diagnostic and stop that agent's evaluation.

`executed=no captured=yes` is internally inconsistent; preserve the files and
stop rather than interpreting them.

Proceed to step 8 only when all three agents report `captured=yes`. If one still
reports `captured=no` after the single retry above, stop and report the finding
in the Signal thread; do not manufacture an empty fifth artifact.

Each line is one JSON record. A valid record has:

- `agent`, `event`, `capturedAt`, and the Familiar `hookPid`;
- a `chain` beginning at that exact PID;
- paired raw `comm` and `command` rows for every ancestor;
- matching PID/PPID values in each pair; and
- a final PID 1 / PPID 0 row.

Each record also contains presence booleans, never values, for `TERM`,
`TERM_PROGRAM`, `KITTY_WINDOW_ID`, `KITTY_PID`, and
`GHOSTTY_RESOURCES_DIR` as seen inside the hook.

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

Do not commit either directory. The five redacted files are sent later as file
attachments in the same Signal direct-message thread that delivered this
handoff. Keep the raw directory private until receipt is confirmed in step 11.

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
- Execution witness present: yes/no
- Explicit probe environment inherited: yes/no/indeterminate
- `claude-code.jsonl` present: yes/no
- Diagnostic or unexpected behavior: none / describe

## Codex
- Version:
- Authenticated tool event completed: yes/no
- Execution witness present: yes/no
- Explicit probe environment inherited: yes/no/indeterminate
- `codex.jsonl` present: yes/no
- Diagnostic or unexpected behavior: none / describe exactly

## OpenCode
- Version:
- Authenticated tool event completed: yes/no
- Execution witness present: yes/no
- Explicit probe environment inherited: yes/no/indeterminate
- `opencode.jsonl` present: yes/no
- Diagnostic or unexpected behavior: none / describe

## Restoration
- Claude settings byte-for-byte restored: yes/no
- Codex hooks byte-for-byte restored: yes/no
- OpenCode configs byte-for-byte restored: yes/no

## Privacy
- Mechanical redaction scan passed: yes/no
```

The return directory must contain exactly:

```text
versions.txt
claude-code.jsonl
codex.jsonl
opencode.jsonl
notes.md
```

Run this mechanical backstop over the return copies after manual redaction. It
prints only filenames and rule names, never the matching secret text:

```sh
export FAMILIAR_REDACTION_USERNAME="$(id -un)"
node --input-type=module <<'NODE'
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const escapedUser = process.env.FAMILIAR_REDACTION_USERNAME
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [
  ['OpenAI-style key', /sk-[A-Za-z0-9_-]{8,}/i],
  ['GitHub token', /(?:ghp_|github_pat_)[A-Za-z0-9_]+/i],
  ['AWS access key', /AKIA[A-Z0-9]{12,}/],
  ['Bearer credential', /Bearer\s+\S+/i],
  ['token/key argument', /(?:token|key)=\S+/i],
  ['local username', new RegExp(`/Users/${escapedUser}(?:/|\\b)`, 'i')],
];
const failures = [];
for (const name of readdirSync(process.env.FAMILIAR_RETURN_DIR)) {
  const text = readFileSync(join(process.env.FAMILIAR_RETURN_DIR, name), 'utf8');
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) failures.push(`${name}: ${label}`);
  }
}
if (failures.length) {
  console.error(`redaction scan failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('redaction scan passed');
NODE
unset FAMILIAR_REDACTION_USERNAME
```

Only after that command prints `redaction scan passed`, change the corresponding
`notes.md` answer to `yes`.

## 10. Restore configuration

Close all three agents first. Restore every file that existed before the test;
remove only a file whose matching `.absent` marker proves the probe created it.

```sh
if [ -f "$FAMILIAR_BACKUP_DIR/claude/settings.json" ]; then
  mkdir -p "$HOME/.claude"
  cp -p "$FAMILIAR_BACKUP_DIR/claude/settings.json" "$HOME/.claude/settings.json"
  cmp -s "$FAMILIAR_BACKUP_DIR/claude/settings.json" "$HOME/.claude/settings.json"
elif [ -f "$FAMILIAR_BACKUP_DIR/claude/settings.absent" ]; then
  rm -f "$HOME/.claude/settings.json"
  test ! -e "$HOME/.claude/settings.json"
fi

if [ -f "$FAMILIAR_BACKUP_DIR/codex/hooks.json" ]; then
  mkdir -p "$FAMILIAR_CODEX_DIR"
  cp -p "$FAMILIAR_BACKUP_DIR/codex/hooks.json" "$FAMILIAR_CODEX_DIR/hooks.json"
  cmp -s "$FAMILIAR_BACKUP_DIR/codex/hooks.json" "$FAMILIAR_CODEX_DIR/hooks.json"
elif [ -f "$FAMILIAR_BACKUP_DIR/codex/hooks.absent" ]; then
  rm -f "$FAMILIAR_CODEX_DIR/hooks.json"
  test ! -e "$FAMILIAR_CODEX_DIR/hooks.json"
fi

mkdir -p "$FAMILIAR_OPENCODE_DIR"
for name in tui.json opencode.json; do
  if [ -f "$FAMILIAR_BACKUP_DIR/opencode/$name" ]; then
    cp -p "$FAMILIAR_BACKUP_DIR/opencode/$name" "$FAMILIAR_OPENCODE_DIR/$name"
    cmp -s "$FAMILIAR_BACKUP_DIR/opencode/$name" "$FAMILIAR_OPENCODE_DIR/$name"
  elif [ -f "$FAMILIAR_BACKUP_DIR/opencode/$name.absent" ]; then
    rm -f "$FAMILIAR_OPENCODE_DIR/$name"
    test ! -e "$FAMILIAR_OPENCODE_DIR/$name"
  fi
done
```

Every command above must succeed before marking restoration `yes` in `notes.md`.

## 11. Send and clean up after receipt

Send exactly the five files listed in step 9 as file attachments, not pasted
text, in the Signal direct-message thread that delivered this handoff. Do not
send the raw directory or the execution-witness file. Wait for the recipient to
confirm that all five attachments were saved intact.

After confirmation, validate every deletion target before removing the local
copies and clone:

```sh
case "$FAMILIAR_BACKUP_DIR" in
  "$FAMILIAR_NODE_TMP"/familiar-macos-config.*) ;;
  *) printf 'refusing unexpected backup path: %s\n' "$FAMILIAR_BACKUP_DIR" >&2; exit 1 ;;
esac
test "$FAMILIAR_PROBE_DIR" = "$FAMILIAR_NODE_TMP/familiar-macos-process-spike"
test "$FAMILIAR_RETURN_DIR" = "$FAMILIAR_NODE_TMP/familiar-macos-process-return"
test "$FAMILIAR_HANDOFF_ROOT" = "$HOME/familiar-macos-handoff"
cd "$HOME"
rm -rf -- \
  "$FAMILIAR_BACKUP_DIR" \
  "$FAMILIAR_PROBE_DIR" \
  "$FAMILIAR_RETURN_DIR" \
  "$FAMILIAR_HANDOFF_ROOT"
```

Delete the Signal direct-message thread after both sides confirm their required
local copy is safely stored. Do not merge this branch. Its only durable output
is the later reviewed and redacted
`docs/ref/2026-08-22-macos-agent-process-spike.md` evidence note.
