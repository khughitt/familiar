# macOS terminal-rendering gate — handoff

This runbook closes the physical terminal-rendering promotion gate: Claude Code, Codex,
and OpenCode exercised in current Kitty and Ghostty releases on a real Mac, with sprite
transmission, tint, cursor colour, bell, session-exit colour restore, and forced-kill
cleanup all checked from a machine-recorded byte log rather than from the tester's
memory alone. It does not repeat the ancestry/hook-executor evidence closed by
`docs/ref/2026-08-23-macos-agent-process-spike.md`; that gate is already closed.

**Status: executed 2026-08-24 to 2026-08-28.** Results are in
`docs/ref/2026-08-24-macos-terminal-smoke.md`; corrections this text still needs are in
`docs/ref/2026-08-24-gate-runbook-amendments.md`, which you should read **before** running
anything here — one of them is a stop-the-run defect in §2.

**One piece of tooling is missing from this checkout, and you must restore it before §5
will produce anything.** `src/render/term/trace.js`, and its two call sites in
`src/render/term/io.js` and `src/render/term/emit.js`, are the byte-level tee this whole
runbook depends on. They live on the disposable `spike/macos-terminal-gate` capture
branch, not on `main`, because they add an (inert) branch to a production write path for
a gate that is not part of normal operation. Recover them from that branch if it still
exists, or re-implement per §11.1 of the design. Without the tee, every trace is empty and
every `gate-verify` invocation trivially passes.

The capture branch is disposable and must never be merged. A tester must never push a
branch, a capture, or an amended commit to any remote.

The machine-side checking:

- `src/render/term/trace.js` — **(not on `main`; see above)** an opt-in tee at the one
  choke point every terminal write passes through (`writeAllSync` in
  `src/render/term/io.js`). Inert unless
  `FAMILIAR_GATE_TRACE` names a file, in which case it appends one JSON line per write:
  timestamp, pid, agent, event, the target path and its device, the fd's own device,
  and every escape sequence decomposed into introducer, control keys, payload length,
  and payload SHA-256 (never the pixels). `FAMILIAR_GATE_AGENT` labels records from
  writers that never go through `familiar hook` — OpenCode's sprite renderer runs
  inside OpenCode's own process and calls `writeAllSync` directly.
- `tools/gate-verify.mjs` — **(on `main`)** the offline checker. It never reconstructs intent from the
  byte stream: every record carries the emitter's own expectation (colours, image id,
  ringing state, whether this was a session-end reset) alongside the bytes it produced,
  and the checker compares the two. Usage:
  `node tools/gate-verify.mjs <trace.jsonl> [--expect-rdev N] [--expect-capability none|static-graphics|kitty-animation] [--no-require-restore]`.
  Exit 0 is clean, exit 1 means at least one `VIOLATION` line, exit 2 is a usage error.
- `familiar setup claude-code` / `familiar setup codex` — the generators under test in
  §4; their output is what gets merged into each agent's real configuration.

One trace file per **cell** (`<terminal>-<agent>.jsonl`), never one per terminal. Every
agent gets its own file even inside the same terminal window, because a shared file
would let one agent's colour-restore satisfy another agent's missing one, and
`gate-verify`'s "never restored colours" check would stop meaning anything.

## Prerequisites

- macOS 14 or newer, on Apple Silicon.
- **Node 22, selected through `nvm`, for the whole matrix.** The Mac's separately
  installed Node (whatever `node` resolves to without `nvm`) is used for exactly one
  cell — the §5 spot-check — and nowhere else.
- Authenticated, working installations of Claude Code, Codex, and OpenCode.
- Both Kitty.app and Ghostty.app.
- A checkout path containing no spaces.
- **No other agent session running on the machine for the duration of the run.** The
  §5 abnormal-termination check requires that exactly one session be live on Familiar's
  bus at the moment a process is killed; a second agent anywhere on the machine — even
  in an unrelated project — breaks that precondition and makes the check meaningless
  rather than merely noisy.

Run the entire gate from a shell inside the terminal named by the step you are on, and
do not mix terminals within a cell: a session started under one terminal carries that
terminal's markers into every hook it spawns.

### Transport

The branch is otherwise unreachable, so state this explicitly. The author pushes
`spike/macos-terminal-gate` to `origin` for the duration of the run, exactly as the
2026-08-23 ancestry handoff did. The tester clones it in §1 and **never pushes anything
back**: no branch, no capture, no amended commit. The author deletes the remote branch
once the artifacts in §12 are received and confirmed.

If pushing the branch is not acceptable for a given run, the alternative is
`git bundle create familiar-gate.bundle spike/macos-terminal-gate` transferred out of
band, with §1's clone pointed at the bundle file instead of a URL.

### Four guards, carried forward as rules

These are not advice; each closes a specific failure a previous run actually hit.

1. **The suite-green stop condition names the known status-line failure in advance.**
   `npm test` on this codebase has one known flake: a status-line test racing
   `BRANCH_TIMEOUT_MS`. §1 names it explicitly so a tester sees it happen once and does
   not confuse it with a real regression, and so a *different* failure is never waved
   through as "probably that one."
2. **No shell loop variable is ever named `path`.** zsh ties the lowercase name `path`
   to `PATH` as a tied array; `for path in ...` silently destroys `PATH` for the rest of
   the session, and every later command fails with `command not found` — with no
   indication why. Every loop in this document uses a different name
   (`config_path`, `name`, `agent`) even where that reads slightly verbose.
3. **Every version is captured through a command substitution, never inside a
   redirected block.** Measured on the 2026-08-23 run: `ghostty --version` writes to
   stderr and seeks the shared file description back to offset 0, so inside a
   `{ ... } > file` block it silently overwrote lines already written — with exit
   status 0 throughout. A command substitution gives the child its own pipe, which it
   cannot seek into the evidence file.
4. **The hook command carries a run-scoped environment gate.** `FAMILIAR_GATE_TRACE`
   and `FAMILIAR_GATE_AGENT` are shell-exported per cell, in this one terminal session —
   they are never written into the persisted `~/.claude/settings.json` or
   `~/.codex/hooks.json` hook command strings themselves (§4 merges the generator's
   output verbatim). A second agent process anywhere else on the machine that happens
   to load the same persisted hook configuration therefore cannot write a single byte
   into this run's trace files, because it never inherits `FAMILIAR_GATE_TRACE` — that
   variable lives only in the shell that launches each cell's agent. This is what makes
   "no other agent session running" a precondition for §5's identity check rather than a
   correctness requirement for the trace files themselves: the trace attribution is
   already safe by construction, but a second live session would still add a second
   record to the bus and make "exactly one session is live" false.

## 1. Check out and verify the capture branch

**Do not turn on `set -e` or `set -u` for this session, and do not add them to the blocks
below.** Every block here is pasted into one interactive shell that has to survive to the
end of the run, and zsh's errexit terminates an interactive shell — the same reason §3
gives for never calling `exit`. This document also runs commands that are *expected* to
fail: the `test ! -e` stop-checks exist to fail when an earlier attempt left a file
behind, and §4's and §11's `cmp` comparisons are results to read, not fatal errors. `set
-u` would additionally abort inside `nvm install 22` / `nvm use`, which read unset `NVM_*`
variables. So every check below prints its own verdict in words instead, and **stopping is
your decision, not the shell's**: when a check prints a line beginning `STOP:`, stop.

```sh
cd "$HOME"
git clone --branch spike/macos-terminal-gate --single-branch \
  https://github.com/khughitt/familiar.git familiar-macos-terminal-gate
cd familiar-macos-terminal-gate
```

Select Node 22 for the whole matrix before running anything Node-based:

```sh
nvm install 22
nvm use 22
node --version    # must start with v22.
```

```sh
npm ci
npm test
export FAMILIAR_GATE_ROOT="$(pwd -P)"
export FAMILIAR_GATE_BIN="$FAMILIAR_GATE_ROOT/bin/familiar"
if [ -x "$FAMILIAR_GATE_BIN" ]; then
  printf 'ok: gate binary %s\n' "$FAMILIAR_GATE_BIN"
else
  printf 'STOP: not executable: %s\n' "$FAMILIAR_GATE_BIN" >&2
fi
git rev-parse HEAD
```

`FAMILIAR_GATE_BIN` is *this checkout's own* `bin/familiar`, never whatever `npm link`
or a global install may have put on `PATH`. Every later section invokes it by this
variable, and only by this variable.

The expected branch and commit are recorded in the message that pointed you to this
runbook. Stop here if either differs, or if `npm test` fails with anything other than
the named status-line/`BRANCH_TIMEOUT_MS` flake (guard 1, above).

## 2. Prepare private output and record versions

```sh
export FAMILIAR_NODE_TMP="$(node -e 'process.stdout.write(require("node:os").tmpdir())')"
export FAMILIAR_GATE_DIR="$FAMILIAR_NODE_TMP/familiar-macos-terminal-gate"
# The Kitty run and the Ghostty run share this directory ON PURPOSE: §8's inventory
# needs all six cell traces together. So it is created once and reused, and what must
# NOT already exist is a per-cell FILE, checked per cell in §5 — never this directory.
mkdir -p -m 700 "$FAMILIAR_GATE_DIR"
chmod 700 "$FAMILIAR_GATE_DIR"
export FAMILIAR_GATE_ROOT="$(pwd -P)"
export FAMILIAR_GATE_BIN="$FAMILIAR_GATE_ROOT/bin/familiar"
if [ -x "$FAMILIAR_GATE_BIN" ]; then
  printf 'ok: gate binary %s\n' "$FAMILIAR_GATE_BIN"
else
  printf 'STOP: not executable: %s\n' "$FAMILIAR_GATE_BIN" >&2
fi
export FAMILIAR_TERMINAL=kitty          # or: ghostty
```

`FAMILIAR_GATE_TRACE` is deliberately **not** set here — it is set once per cell, in
§5, immediately before that cell's agent is launched, and unset again (by simply going
out of scope of the `export`, i.e. by exporting a new value for the next cell) once its
two closing checks pass.

Resolve the terminal binary this run is for, exactly as `FAMILIAR_TERMINAL` names it:

```sh
case "$FAMILIAR_TERMINAL" in
  kitty)   FAMILIAR_TERMINAL_APP=/Applications/kitty.app/Contents/MacOS/kitty ;;
  ghostty) FAMILIAR_TERMINAL_APP=/Applications/Ghostty.app/Contents/MacOS/ghostty ;;
  *) printf 'unknown terminal: %s\n' "$FAMILIAR_TERMINAL" >&2; exit 1 ;;
esac
export FAMILIAR_TERMINAL_BIN="$(command -v "$FAMILIAR_TERMINAL" 2>/dev/null || true)"
if [ -z "$FAMILIAR_TERMINAL_BIN" ]; then
  export FAMILIAR_TERMINAL_BIN="$FAMILIAR_TERMINAL_APP"
fi
if [ -x "$FAMILIAR_TERMINAL_BIN" ]; then
  printf 'ok: terminal binary %s\n' "$FAMILIAR_TERMINAL_BIN"
else
  printf 'STOP: not executable: %s\n' "$FAMILIAR_TERMINAL_BIN" >&2
fi
```

Name this run's private version file — one per terminal, because the two runs share
`$FAMILIAR_GATE_DIR`:

```sh
export FAMILIAR_GATE_VERSIONS="$FAMILIAR_GATE_DIR/versions-$FAMILIAR_TERMINAL.txt"
if [ -e "$FAMILIAR_GATE_VERSIONS" ]; then
  printf 'STOP: a previous attempt already wrote %s\n' "$FAMILIAR_GATE_VERSIONS" >&2
else
  printf 'ok: no previous versions file for %s\n' "$FAMILIAR_TERMINAL"
fi
```

If that check says `STOP`, an earlier attempt for this terminal already ran. Move the file
aside under a new name; do not delete it and do not let this run overwrite it.

Every value below is captured through a command substitution (guard 3):

```sh
{
  printf 'captured-at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'os=%s (%s)\n' "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)"
  printf 'architecture=%s\n' "$(uname -m)"
  printf 'node=%s\n' "$(node --version 2>&1 | head -n 1)"
  printf 'node-major=%s\n' "$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  printf 'terminal=%s\n' "$FAMILIAR_TERMINAL"
  printf 'terminal-version=%s\n' "$("$FAMILIAR_TERMINAL_BIN" --version 2>&1 | head -n 1)"
  printf 'claude=%s\n' "$(claude --version 2>&1 | head -n 1)"
  printf 'codex=%s\n' "$(codex --version 2>&1 | head -n 1)"
  printf 'opencode=%s\n' "$(opencode --version 2>&1 | head -n 1)"
  printf 'familiar-commit=%s\n' "$(git rev-parse HEAD)"
} > "$FAMILIAR_GATE_VERSIONS"
chmod 600 "$FAMILIAR_GATE_VERSIONS"
```

Open the file once and confirm every line is present and intact before continuing. A
short or scrambled file means a version command wrote into it directly; capture that
command's output separately and rebuild the line.

Record the device the matrix expects, which the verifier needs to catch the wrong-target
failure — and which the negative control and OpenCode's in-process writes are checked
against just the same:

```sh
export FAMILIAR_GATE_RDEV="$(node -e 'process.stdout.write(String(require("node:fs").fstatSync(1).rdev))')"
case "$FAMILIAR_TERMINAL" in
  kitty)   export FAMILIAR_GATE_CAPABILITY=kitty-animation ;;
  ghostty) export FAMILIAR_GATE_CAPABILITY=static-graphics ;;
esac
# FAMILIAR_GATE_VERSIONS is still the file named above; appended to, not reset.
printf 'terminal-rdev=%s\n' "$FAMILIAR_GATE_RDEV" >> "$FAMILIAR_GATE_VERSIONS"
printf 'expected-capability=%s\n' "$FAMILIAR_GATE_CAPABILITY" >> "$FAMILIAR_GATE_VERSIONS"
```

Both values are asserted **from outside** when traces are verified, never taken from
anything Familiar itself computed — the capability negative control in §6 is precisely
what happens when that classification is wrong, and asserting it from the classifier
under test would make the control check itself against itself.

## 3. Back up configuration, and configure Familiar itself

Do not replace an agent's complete configuration. Back it up, then §4 merges in only
the generated hook entries. Familiar's *own* configuration directory is backed up here
too, because the second half of this section writes into it.

```sh
FAMILIAR_GATE_BACKUP_SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
export FAMILIAR_GATE_BACKUP_DIR="$FAMILIAR_NODE_TMP/familiar-gate-config.$FAMILIAR_GATE_BACKUP_SUFFIX"
mkdir -m 700 "$FAMILIAR_GATE_BACKUP_DIR"
mkdir -m 700 "$FAMILIAR_GATE_BACKUP_DIR/claude" \
  "$FAMILIAR_GATE_BACKUP_DIR/codex" "$FAMILIAR_GATE_BACKUP_DIR/opencode"
export FAMILIAR_CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
export FAMILIAR_OPENCODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
export FAMILIAR_CONFIG_DIR_PATH="${FAMILIAR_CONFIG_DIR:-$HOME/.config/familiar}"
```

`FAMILIAR_CONFIG_DIR_PATH` is named for reading, never exported as `FAMILIAR_CONFIG_DIR`:
exporting that name would redirect every `familiar` command in this session (and every
hook it spawns) at whatever it holds, and this run must exercise the real path
(`src/bus/paths.js`).

The atomic replacements below do not preserve a configuration-file symlink. Stop before
making any change if one of the affected files is a symlink. Do not name the loop
variable `path` (guard 2) — run this exactly as written:

```sh
familiar_symlink_found=
for config_path in \
  "$HOME/.claude/settings.json" \
  "$FAMILIAR_CODEX_DIR/hooks.json" \
  "$FAMILIAR_OPENCODE_DIR/tui.json" \
  "$FAMILIAR_OPENCODE_DIR/opencode.json" \
  "$FAMILIAR_OPENCODE_DIR/tui.jsonc" \
  "$FAMILIAR_OPENCODE_DIR/opencode.jsonc" \
  "$FAMILIAR_CONFIG_DIR_PATH"
do
  if [ -L "$config_path" ]; then
    printf 'stop: configuration is a symlink: %s\n' "$config_path" >&2
    familiar_symlink_found=1
  fi
done
if [ -n "$familiar_symlink_found" ]; then
  printf 'symlink check: FAILED — stop here and do not continue\n' >&2
else
  printf 'symlink check: passed\n'
fi
```

This reports every offending file rather than the first, and deliberately does not call
`exit`: pasted into an interactive shell, `exit` would close the session and discard
every `FAMILIAR_GATE_*` variable exported so far.

Back up each present file; create the corresponding `.absent` marker when it does not
exist:

```sh
if [ -f "$HOME/.claude/settings.json" ]; then
  cp -p "$HOME/.claude/settings.json" "$FAMILIAR_GATE_BACKUP_DIR/claude/settings.json"
else
  : > "$FAMILIAR_GATE_BACKUP_DIR/claude/settings.absent"
fi

if [ -f "$FAMILIAR_CODEX_DIR/hooks.json" ]; then
  cp -p "$FAMILIAR_CODEX_DIR/hooks.json" "$FAMILIAR_GATE_BACKUP_DIR/codex/hooks.json"
else
  : > "$FAMILIAR_GATE_BACKUP_DIR/codex/hooks.absent"
fi

for name in tui.json opencode.json tui.jsonc opencode.jsonc; do
  if [ -f "$FAMILIAR_OPENCODE_DIR/$name" ]; then
    cp -p "$FAMILIAR_OPENCODE_DIR/$name" "$FAMILIAR_GATE_BACKUP_DIR/opencode/$name"
  else
    : > "$FAMILIAR_GATE_BACKUP_DIR/opencode/$name.absent"
  fi
done

# Familiar's own configuration: the scheme, the installed theme packs, the theme
# receipts, and identities.yaml. The next block writes into this directory, and §11 puts
# back exactly what was here.
if [ -d "$FAMILIAR_CONFIG_DIR_PATH" ]; then
  cp -R -p "$FAMILIAR_CONFIG_DIR_PATH" "$FAMILIAR_GATE_BACKUP_DIR/familiar-config"
  printf 'backed up %s\n' "$FAMILIAR_CONFIG_DIR_PATH"
else
  : > "$FAMILIAR_GATE_BACKUP_DIR/familiar-config.absent"
  printf 'no existing Familiar configuration at %s\n' "$FAMILIAR_CONFIG_DIR_PATH"
fi
```

After these backups exist, an aborted run is recovered by closing every agent and going
directly to §11.

### Give Familiar a scheme and a theme

**This engine ships no art and no scheme, and every later section depends on both.**
This checkout has no `themes/` directory: theme packs are published separately, and the
`familiar-theme` npm dependency is the theme *toolkit*, not a pack. Without a scheme,
every `familiar` command — including every hook Codex and Claude Code fire — prints
`familiar: no scheme at …` and does nothing; without an installed pack the same commands
fail resolving the active theme's assets. `familiar hook`'s `--trace` record is written
*after* the event is applied, so a Pass B run on an unconfigured machine reports all six
Codex events as never fired, and §5's traces come out empty, with nothing on screen to say
why (`hook` is cosmetic and exits 0 even when it fails; the diagnostic goes to the agent's
own stderr, which a TUI hides).

Set the scheme, and install the public cats pack unless a pack is already installed:

```sh
"$FAMILIAR_GATE_BIN" scheme set dark
if [ -n "$("$FAMILIAR_GATE_BIN" theme list)" ]; then
  printf 'ok: a theme is already installed; leaving it in place\n'
  "$FAMILIAR_GATE_BIN" theme list
else
  "$FAMILIAR_GATE_BIN" theme add https://github.com/khughitt/familiar-cats
fi
```

`theme add` fetches into staging, validates the whole pack, and promotes it atomically
into `$FAMILIAR_CONFIG_DIR_PATH/themes/<id>`; it needs network access to GitHub. If this
Mac has no network access to that repository, clone the pack by any means available and
pass the clone's directory instead — `familiar theme add /path/to/familiar-cats` takes a
local directory and validates it identically.

`scheme set dark` is run unconditionally, so a machine that was already on `light` changes
for the duration of this run. Both the scheme and any pack installed here are undone in
§11 from the backup taken above: the directory is put back exactly as it was, whether that
means restoring a `light` scheme or removing a configuration this run created outright.
Record in §10 what was already there.

Confirm Familiar is configured before going anywhere near an agent. All three lines must
succeed:

```sh
"$FAMILIAR_GATE_BIN" theme list
"$FAMILIAR_GATE_BIN" theme show
"$FAMILIAR_GATE_BIN" whoami "$FAMILIAR_GATE_ROOT"
```

Expected: `theme list` names an installed pack, `theme show` prints twelve members, and
`whoami` prints this checkout's assigned member. A `familiar: no scheme` or a `realpath`
error from any of them means the configuration did not take — stop and fix it here, not
three sections later with six empty traces in hand.

## 4. Install the generated agent configuration

This is the first live exercise of `familiar setup codex` (and of `familiar setup
claude-code`), so it is a step in its own right, not a preamble to §5. Generate both
documents and validate that each is well-formed JSON before touching any real
configuration:

```sh
"$FAMILIAR_GATE_BIN" setup claude-code > "$FAMILIAR_GATE_DIR/claude-code.json"
"$FAMILIAR_GATE_BIN" setup codex       > "$FAMILIAR_GATE_DIR/codex.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$FAMILIAR_GATE_DIR/claude-code.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$FAMILIAR_GATE_DIR/codex.json"
```

Both commands must print nothing and exit 0. Now merge each generated document into the
real configuration, **without hand-editing either command string** — the generated
encoding is exactly what this gate exists to exercise. Every event array in each
document is appended to whatever the same event already holds in the live
configuration, so an unrelated existing hook is never touched or reordered away:

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function mergeGenerated(target, generated) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`${target}: root must be an object`);
  }
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, entries] of Object.entries(generated.hooks)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...current, ...entries];   // append, never replace
  }
  const next = { ...config, hooks };
  if (generated.statusLine !== undefined) next.statusLine = generated.statusLine;

  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.familiar-gate-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

const claudeGenerated = JSON.parse(
  readFileSync(`${process.env.FAMILIAR_GATE_DIR}/claude-code.json`, 'utf8'),
);
mergeGenerated(`${process.env.HOME}/.claude/settings.json`, claudeGenerated);

const codexGenerated = JSON.parse(
  readFileSync(`${process.env.FAMILIAR_GATE_DIR}/codex.json`, 'utf8'),
);
mergeGenerated(`${process.env.FAMILIAR_CODEX_DIR}/hooks.json`, codexGenerated);
NODE
```

Codex's generated document configures exactly six events: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, `SessionEnd` — it has
neither a failure event nor an idle-prompt notification, structurally. Confirming that
every one of the six actually reaches Familiar cannot be done from the §5 cell trace
alone: `emit()` returns before writing anything when a hook's state transition is a
no-op (`prev === next`, e.g. `PreToolUse` immediately after a `UserPromptSubmit` that
already reached `working`), so a no-op transition leaves no terminal-write record even
though the hook fired and `familiar hook` ran to completion. `familiar hook` has a
second, unconditional trace of its own for exactly this: `--trace FILE` appends one
metadata-only JSONL record — `timestamp, agent, event, prev_state, next_state`, and
identifiers, never prompt or tool contents (`bin/familiar`'s `appendHookTrace`,
asserted by `test/bin-familiar.test.js`) — on every hook invocation, no-op or not.

This needs **two passes**, not one, because the two things being proven are different
and the second cannot be added to the first without invalidating it. Pass A is the
pristine, unedited `~/.codex/hooks.json` this section just installed — its command
strings are exactly `familiar setup codex`'s output, hand-untouched, and Pass A is what
proves that encoding survives Codex's `/bin/zsh -c` executor. Appending `--trace` to
those same command strings would edit them, which is precisely what this section already
committed not to do. So Pass A stays exactly as installed above — its evidence is the
`kitty-codex.jsonl` / `ghostty-codex.jsonl` cell traces §5 captures — and Pass B runs
separately, once, against a throwaway edited copy that is installed only for its own
duration and removed immediately after.

Save the pristine, already-merged document aside — this is *not* the pre-gate backup
from §3, it is this run's own merged output, and it is what gets reinstalled the moment
Pass B is done:

```sh
cp -p "$FAMILIAR_CODEX_DIR/hooks.json" "$FAMILIAR_GATE_DIR/codex-hooks-pristine.json"
export FAMILIAR_GATE_CODEX_EVENTS="$FAMILIAR_GATE_DIR/codex-events.jsonl"
if [ -e "$FAMILIAR_GATE_CODEX_EVENTS" ]; then
  printf 'STOP: a previous Pass B already wrote %s\n' "$FAMILIAR_GATE_CODEX_EVENTS" >&2
else
  printf 'ok: no previous Pass B event trace\n'
fi
```

Build the traced variant and install it temporarily. **Only the entries this run appended
are edited.** The merge above appended the generated entries to the end of each event's
array, so those are the ones the tail of each array holds, and the tester's own hooks —
which are not Familiar's and would break if `--trace` were pasted onto them, and which
need not even carry a `hooks` array — are left exactly as they are:

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const target = `${process.env.FAMILIAR_CODEX_DIR}/hooks.json`;
const tracePath = process.env.FAMILIAR_GATE_CODEX_EVENTS;

const generated = JSON.parse(
  readFileSync(`${process.env.FAMILIAR_GATE_DIR}/codex.json`, 'utf8'),
);
const config = JSON.parse(readFileSync(target, 'utf8'));

for (const [event, entries] of Object.entries(generated.hooks)) {
  const live = Array.isArray(config.hooks?.[event]) ? config.hooks[event] : [];
  const appended = live.slice(live.length - entries.length);
  // Identity, not position alone: if these are not byte-for-byte the entries the merge
  // appended, something else edited this file and guessing which entries are ours would
  // be how an unrelated hook gets a `--trace` argument bolted onto it.
  if (JSON.stringify(appended) !== JSON.stringify(entries)) {
    throw new Error(`${event}: this run's generated entries are not at the end of ${target}`);
  }
  for (const entry of appended) {
    for (const hook of entry.hooks) {
      hook.command += ` --trace ${shellQuote(tracePath)}`;
    }
  }
}
const temp = `${target}.familiar-gate-tracepass-${process.pid}`;
writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(temp, target);
NODE
```

Launch a fresh Codex session and drive **one** turn that reaches a tool call needing
approval and then exits the session normally — that one turn is what gives all six
events a chance to fire: `SessionStart` and `UserPromptSubmit` at the start,
`PreToolUse` and `PermissionRequest` around the tool call, `Stop` at the end of the
turn, `SessionEnd` on exit.

```sh
codex
```

Confirm all six names are present — this is now a real, unconditional check, not the
best-effort grep against the terminal-write trace this section used to make do with:

```sh
node -e '
const fs = require("node:fs");
const required = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"];
const seen = new Set(
  fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l).event),
);
const missing = required.filter((name) => !seen.has(name));
if (missing.length) throw new Error(`never fired: ${missing.join(", ")}`);
console.log("all six Codex events fired:", [...seen].sort().join(", "));
' "$FAMILIAR_GATE_CODEX_EVENTS"
```

Record the result in §10. A genuinely missing event here — after driving a tool call
that needed approval, in one turn, ending the session — is an open finding, not
something to explain away; unlike the §5 terminal-write trace, this one has no no-op
exemption.

Restore the pristine, untraced document before doing anything else — every later
Codex cell in §5, in both terminals, must run the unedited command strings:

```sh
cp -p "$FAMILIAR_GATE_DIR/codex-hooks-pristine.json" "$FAMILIAR_CODEX_DIR/hooks.json"
if cmp -s "$FAMILIAR_GATE_DIR/codex-hooks-pristine.json" "$FAMILIAR_CODEX_DIR/hooks.json"; then
  printf 'ok: the untraced Codex hooks are back in place\n'
else
  printf 'STOP: %s does not match the pristine copy — every later Codex cell would run edited command strings\n' \
    "$FAMILIAR_CODEX_DIR/hooks.json" >&2
fi
```

Finally, run the two installers that are not part of the hook-merge above:

```sh
"$FAMILIAR_GATE_BIN" install pets
"$FAMILIAR_GATE_BIN" install opencode
```

**If `install opencode` refuses, that is correct behaviour, not a failure.** It writes
`tui.json` and `opencode.json` only. If the machine keeps a `tui.jsonc` or an
`opencode.jsonc` instead, it now refuses and prints the exact plugin path to add by
hand — the case the 2026-08-23 ancestry run hit, where a shadow `.json` sibling was
created next to the `.jsonc` file opencode actually reads and went unnoticed until
restore. Add the printed path to that file's `"plugin"` array by hand:

```jsonc
{
  // your existing configuration, untouched
  "plugin": ["/path/to/familiar-macos-terminal-gate/integrations/opencode/plugin.js"]
}
```

`opencode.jsonc` takes `integrations/opencode/plugin.js`; `tui.jsonc` takes
`integrations/opencode/sprite-plugin.tsx`. The refusal message names the right one for
each file. Record in §10 which files, if any, you edited by hand — §11 restores them
from the backups made in §3 and verifies each with `cmp`.

## 5. The Kitty/Ghostty matrix, one trace per cell

Run this whole section once with `FAMILIAR_TERMINAL=kitty` (§2 already exported it).

**Order matters, and it is not the order of the section numbers.** Run §5, then §6, then
§7 — all of them in the *same* Kitty window, without closing it — and only then close
that window, open Ghostty, and come back here for the second pass. §6 and §7 are
Kitty-only and are captured against `versions-kitty.txt`'s `terminal-rdev`, which §8's
final sweep asserts every one of their records against. A tty device belongs to a
*window*: reopening Kitty gives every later capture a different `rdev`, so §6's and §7's
traces would then fail `--expect-rdev` — with a message textually identical to the
wrong-target resolver defect this entire gate exists to detect — and §2's versions-file
stop-check refuses to re-capture the new device under the same name.

The Ghostty pass repeats §2 and this section only. §3's backup, §3's Familiar
configuration, and §4's agent configuration install are **not** repeated — they are
machine-global, already cover both terminals, and re-running §4 would simply append a
second, duplicate copy of every hook entry. §2 **is** repeated inside the new terminal
window, from `export FAMILIAR_TERMINAL=ghostty` through the terminal binary, the
per-run versions file, `FAMILIAR_GATE_RDEV`, and `FAMILIAR_GATE_CAPABILITY` — every one
of those is specific to the window it is captured in, and none of them survive closing
the old terminal.

For each agent in turn — `claude-code`, then `codex`, then `opencode`:

```sh
export FAMILIAR_GATE_AGENT=claude-code        # then codex, then opencode
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/$FAMILIAR_TERMINAL-$FAMILIAR_GATE_AGENT.jsonl"
# never append to a previous attempt's evidence
if [ -e "$FAMILIAR_GATE_TRACE" ]; then
  printf 'STOP: this cell already has a trace: %s\n' "$FAMILIAR_GATE_TRACE" >&2
else
  printf 'ok: fresh trace for %s\n' "$FAMILIAR_GATE_TRACE"
fi
```

If that check says `STOP`, move the earlier file aside under a new name; do not delete it
and do not append to it.

### What each cell exposes

The three adapters expose different states and send different bytes, so a row of "pass"
does not mean the same thing across the table:

| Agent | States exposed | Bytes Familiar sends | Sprite drawn by |
| --- | --- | --- | --- |
| Claude Code | six: `idle`, `working`, `needs-input`, `needs-approval`, `done`, `error` | graphics, tint, bell | Familiar: the hook transmits, `familiar statusline` prints the placeholder cells |
| Codex | four: `idle`, `working`, `needs-approval`, `done` | tint, bell | Codex natively, from `install pets` |
| OpenCode | five: adds `error`, omits `needs-input` | tint, bell | `integrations/opencode/sprite-plugin.tsx`, inside OpenCode's own process |

The bell rule narrows with the exposed states: Claude Code can ring on all three
ringing states (`needs-input`, `needs-approval`, `error`), OpenCode on `needs-approval`
and `error`, and Codex on `needs-approval` alone.

Drive the session, in ordinary use, through every state that agent structurally
exposes — submit a prompt to reach `working`, request something that needs permission
to reach `needs-approval`, let a turn finish to reach `done`, leave Claude Code idle
after a turn until its idle-prompt notification fires for `needs-input`, and provoke a
failing tool call (or, for Claude Code, a `StopFailure`) for `error`. Two behaviours are
expected, stated here so they are not logged as failures:

- **Codex's `SessionStart` fires at the first turn, not at window open.** An opened but
  unspoken-to Codex window showing nothing yet is correct, not a missing event.
- **OpenCode's hook path observes no tool events at all**, so its `working` comes from
  `session.busy` and `done` only from the idle-after-active path in `reduceState`. Do
  not look for a `PreToolUse`-shaped signal from OpenCode; there isn't one.
- **An OpenCode trace is enormous, and that is not a fault.** Its sprite renderer writes
  one placement per rendered frame (`integrations/opencode/sprite-runtime.js`), and each
  of those is one trace record — so `kitty-opencode.jsonl` and `ghostty-opencode.jsonl`
  can hold tens of thousands of lines and run to several megabytes for an ordinary
  session, while the Claude Code and Codex traces hold a few dozen lines. Size is a
  property of the frame rate, not evidence of a runaway write. This matters twice: §8's
  sweep takes proportionally longer on those two files, and §9 asks you to review every
  returned file — for these two, read the *shapes* (the escape kinds present, the image
  ids, a sample of records from the start, middle and end) rather than every line.

Claude Code's cell additionally requires confirming, by eye, that the status-line sprite
is visible in the terminal — the placeholder cells `familiar statusline` prints,
positioned under the pet's placement. This is the only cell that exercises the
two-process rendezvous between the hook (which transmits the image) and the status line
(which prints the cells it lands in, in a *different* process with no channel between
them) agreeing on the same `imageIdFor(sessionId)`. It is the mechanism most likely to
break inside a real TUI, which is why it is checked explicitly here rather than folded
into "sprite: yes."

### Normal exit

Exit the session normally (quit the agent the ordinary way, not a forced kill). This is
what fires `SessionEnd`/`dispose`, which maps to `null` and is the one and only trigger
for the colour restore. Then run the verifier — normal exit is checked by the verifier
rather than by grep, because the verifier is what knows a restore needs *both* halves:

```sh
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_TRACE" \
  --expect-rdev "$FAMILIAR_GATE_RDEV" \
  --expect-capability "$FAMILIAR_GATE_CAPABILITY"
```

Expected: exit 0. A `never restored colours` violation means the session-end transition
did not happen, or happened but restored only one of background/cursor. A `this run's
terminal is` violation means bytes reached a device that is not this window — the
wrong-target failure this whole gate exists to catch. Either violation stops this cell;
record it in §10 rather than continuing to the next agent.

### Abnormal termination and `familiar reap`

The normal-exit check above already ended this cell's session, so **start a fresh one
first**: launch the same agent again, in the same window, drive it to any state so it
reaches the bus, and leave it running.

The session is then identified before anything is killed, and that exact identity is
carried through every remaining step. A nonempty bus record and a nonempty `reap` line
prove nothing on their own — either could belong to a different session — which is
exactly what the identity check closes:

```sh
CELL="$FAMILIAR_TERMINAL-$FAMILIAR_GATE_AGENT"
BUS=~/.local/state/familiar/agents.json
SESSION_FILE="$FAMILIAR_GATE_DIR/reap-session-$CELL.json"
PID_FILE="$FAMILIAR_GATE_DIR/reap-pid-$CELL.txt"

# 0. Name the session and verify the process identity BEFORE anything is killed.
#
#    The session id is written as JSON, not as a line: it arrives verbatim from the
#    agent's payload, which accepts any non-empty string (src/adapters/payload.js), so it
#    may contain whitespace or newlines. Every later comparison decodes this file and
#    compares the exact string in Node. `eval` on it would be a command injection hole,
#    and line-oriented tools would silently mangle it.
#
#    Identity is pid PLUS starttime, which is Familiar's own definition
#    (src/bus/transaction.js: "A pid alone is a number the kernel reuses; the pair is a
#    process"). Comparing the stored start time against a fresh reading is what makes
#    `kill -9` safe: a recycled pid now owned by another instance of the same agent has
#    the same basename and would pass a `comm` check.
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { startTimeOf } from "./src/bus/proc.js";

// `node -e` has NO script path in argv: argv[0] is the executable and argv[1] is the
// first argument passed after the script text. slice(2) would silently drop $BUS and
// leave pidOut undefined.
const [busPath, sessionOut, pidOut] = process.argv.slice(1);
const bus = JSON.parse(readFileSync(busPath, "utf8"));
const ids = Object.keys(bus);
if (ids.length !== 1) {
  throw new Error(`expected exactly one live session, found ${ids.length}`);
}
const record = bus[ids[0]];
if (!Number.isInteger(record.pid) || record.pid <= 1) {
  throw new Error(`refusing to name pid ${JSON.stringify(record.pid)} as a kill target`);
}
const fresh = startTimeOf(record.pid);
if (fresh !== record.starttime) {
  throw new Error(
    `pid ${record.pid} start time is ${fresh}, the bus recorded ${record.starttime}: ` +
    "this pid has been recycled and is NOT the agent. Do not kill it."
  );
}
writeFileSync(sessionOut, JSON.stringify(ids[0]));
writeFileSync(pidOut, `${record.pid}\n`);
process.stdout.write(`session verified, pid ${record.pid} starttime ${fresh}\n`);
' "$BUS" "$SESSION_FILE" "$PID_FILE" | tee "$FAMILIAR_GATE_DIR/reap-identity-$CELL.txt"

AGENT_PID="$(cat "$PID_FILE")"
case "$AGENT_PID" in ''|*[!0-9]*) printf 'not a pid: %s\n' "$AGENT_PID" >&2; exit 1 ;; esac

# 0b. Record what that pid is, for the evidence and for a human sanity check.
ps -p "$AGENT_PID" -o pid=,comm= | tee "$FAMILIAR_GATE_DIR/reap-target-$CELL.txt"
```

The start-time comparison above is the actual guard; the `ps` line is corroboration for
whoever reads the evidence afterward. Its basename should be the agent under test —
`claude`, `codex`, or `opencode`. If step 0 threw, stop here — do not continue and do
not kill anything.

Kill **`<the resolved agent pid>`** — the exact value verified in step 0 and read back
above as `AGENT_PID="$(cat "$PID_FILE")"`:

```sh
kill -9 "$AGENT_PID"

# 1. THAT session must still be on the bus. Any hook from any agent would have pruned
#    it, which is why exactly one session may be live during this check.
cp "$BUS" "$FAMILIAR_GATE_DIR/before-reap-$CELL.json"

# 2. reap must name THAT session.
"$FAMILIAR_GATE_BIN" reap | tee "$FAMILIAR_GATE_DIR/reap-$CELL.txt"

# 3. and THAT session must be the one now absent.
cp "$BUS" "$FAMILIAR_GATE_DIR/after-reap-$CELL.json"

# All three comparisons in Node, against the exact decoded id. No shell, no grep: a
# session id is agent-supplied text and is neither a pattern nor a line.
node -e '
const fs = require("node:fs");
// argv[1] is the first argument after the script text (see step 0): no script path.
const [beforePath, reapPath, afterPath, sessionPath] = process.argv.slice(1);
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
const reaped = fs.readFileSync(reapPath, "utf8");
if (!(session in before)) throw new Error("the session was already gone before reap ran");
// Whole-string equality. `reap`'s eviction lines go to stderr (bin/familiar
// reportEvictions), so the tee'd stdout is exactly its `reaped <ids>` line and nothing
// else -- and with exactly one live session that line is fully determined. Equality also
// survives an id containing a newline, which the payload contract permits.
if (reaped !== `reaped ${session}\n`) {
  throw new Error("reap stdout was not exactly the killed session");
}
if (session in after) throw new Error("the session survived reap");
process.stdout.write("present before, named by reap, absent after\n");
' "$FAMILIAR_GATE_DIR/before-reap-$CELL.json" \
  "$FAMILIAR_GATE_DIR/reap-$CELL.txt" \
  "$FAMILIAR_GATE_DIR/after-reap-$CELL.json" \
  "$SESSION_FILE"
```

The step-0 guard that exactly one session is on the bus is what makes the identity
unambiguous, and it is the mechanical form of the prerequisite that no other agent
session runs during the pass. If it throws, stop and close the other session rather than
picking a bus key by hand.

**The terminal stays tinted after the force-kill, and that is correct, not a failure.**
Nothing restores colours without a `SessionEnd`, and `familiar reap` writes no terminal
bytes at all — the tint is cleared by the *next* session's own transitions, not by
reaping.

Repeat "drive to any state, identify, kill, reap" for each of the three agents in this
terminal, each with its own `CELL` and its own seven reap artifacts
(`reap-session-`, `reap-pid-`, `reap-identity-`, `reap-target-`, `before-reap-`,
`reap-`, `after-reap-`, each suffixed `$CELL`).

### The Node spot-check

After the **Kitty** matrix above completes under Node 22, switch to the Mac's separately
installed Node and repeat the Claude Code / Kitty cell alone, to confirm nothing in the
gate's own findings is specific to the Node version used to run it:

```sh
nvm deactivate    # or: nvm use system — whichever this Mac's nvm install exposes
node --version    # confirm this is NOT v22.x
export FAMILIAR_GATE_AGENT=claude-code
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/spot-check.jsonl"
if [ -e "$FAMILIAR_GATE_TRACE" ]; then
  printf 'STOP: the spot-check already has a trace: %s\n' "$FAMILIAR_GATE_TRACE" >&2
else
  printf 'ok: fresh spot-check trace\n'
fi
```

Drive the same cell — every Claude Code state, the status-line confirmation, a normal
exit — exactly as above, then:

```sh
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_TRACE" \
  --expect-rdev "$FAMILIAR_GATE_RDEV" --expect-capability "$FAMILIAR_GATE_CAPABILITY"
```

Then switch back. On the Kitty pass this is where §6 begins; on the Ghostty pass there is
no spot-check to switch back from, and §5 ends here:

```sh
nvm use 22
node --version    # must start with v22. again
```

**On the Kitty pass, do not close this window.** Go on to §6 and §7, which run in it. On
the Ghostty pass, §5 is the last section that runs in the terminal, and §8 comes next.

## 6. The capability `none` negative control

**Runs in the same Kitty window as §5, before that window is closed** — never in the
reopened one, and never in Ghostty. Both traces below are verified against
`$FAMILIAR_GATE_RDEV`, which is the device of *this* window, and §8's sweep asserts them
against the `terminal-rdev` recorded in `versions-kitty.txt`, which is the same number
only while this window is the one that captured it.

Every cell above runs in Kitty or Ghostty and therefore classifies as graphics-capable,
so the suppression rule that graphics must not be transmitted at capability `none` would
otherwise be defined and never actually executed. Run this once, under Node 22 — once for
the whole gate, not once per terminal:

```sh
export FAMILIAR_GATE_AGENT=claude-code
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/capability-none-claude-code.jsonl"
env -u KITTY_WINDOW_ID -u KITTY_PID -u TERM_PROGRAM \
    -u GHOSTTY_RESOURCES_DIR -u GHOSTTY_BIN_DIR \
    TERM=xterm-256color claude
```

This launches Claude Code from a shell with every marker Familiar's classifier reads
cleared, and `TERM` forced to a value that itself is not graphics-capable. The TUI keeps
working, the resolved TTY is still a genuine terminal device, and the inherited hook
environment classifies as `none`. Drive the session to one ringing state (any state that
would normally ring a bell) and then exit it normally, exactly as in §5.

Repeat with OpenCode in place of Claude Code:

```sh
export FAMILIAR_GATE_AGENT=opencode
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/capability-none-opencode.jsonl"
env -u KITTY_WINDOW_ID -u KITTY_PID -u TERM_PROGRAM \
    -u GHOSTTY_RESOURCES_DIR -u GHOSTTY_BIN_DIR \
    TERM=xterm-256color opencode
```

**Codex is excluded.** It transmits no graphics for any classification to suppress, so
there is nothing here for it to prove.

The two suppression sites under test are different code paths: the hook's `emit()`
skips the entire graphics block, while `sprite-plugin.tsx` returns before registering
anything with the renderer at all — so both transmitters need their own run. Required in
each trace, verified now and again in §8's final sweep:

```sh
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_DIR/capability-none-claude-code.jsonl" \
  --expect-rdev "$FAMILIAR_GATE_RDEV" --expect-capability none
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_DIR/capability-none-opencode.jsonl" \
  --expect-rdev "$FAMILIAR_GATE_RDEV" --expect-capability none --no-require-restore
```

(OpenCode's control is checked with `--no-require-restore`, and the reason is the opposite
of what it looks like. This trace carries no sprite-renderer records at all: at capability
`none` the sprite plugin returns before registering anything with the renderer, so it
writes not one byte, and everything here is a `source: 'emit'` hook record. Those records
*can* carry a restore — the binding's `dispose` resets the colours — but OpenCode does not
call `dispose` on every quit (`integrations/opencode/binding.js`: "opencode may not call
this on a hard quit"), so requiring it would let an unrelated teardown path fail the one
claim this cell exists to make. The restore is proven instead by §5's two OpenCode cells,
which are verified without this flag; here, only the suppression is on trial.)

`--expect-capability none` is the check that matters here: without asserting it from
*outside*, a marker-scrub that silently failed would classify as graphics-capable, emit
graphics, agree with its own recorded expectation, and pass anyway. Required, and
confirmed by eye rather than by the byte log: the window still tints and still rings,
and no sprite appears in either trace's window.

This pass is also the first live exercise of `familiar setup codex` end to end (already
exercised in §4) landing real graphics decisions for Claude Code and OpenCode
specifically at capability `none` — the generated document has never before configured
a real, running agent at this classification.

## 7. The background and daemon appendix

Both probes below run once, in the **same Kitty window as §5 and §6, before it is
closed** — not per terminal, and not in a reopened window. The underlying predicate this
closes (`tty !== null` in Familiar's resolver) is terminal-independent, so it is proven
once; the window matters because probe 2's plist is written from this shell's values and
because §8 checks every Kitty-side trace against `versions-kitty.txt`'s device.

### Probe 1 — induce the real case

§5's Kitty/Claude Code session is gone by now — its normal exit closed it and its
successor was force-killed — so start a fresh one. First stop this shell from tagging it
into a finished cell's evidence: probe 1 is about the process table, not about bytes, and
a Claude Code session launched with §6's `FAMILIAR_GATE_TRACE` still exported would append
its own writes to `capability-none-opencode.jsonl` and fail that trace's
`--expect-capability none` in §8's sweep.

```sh
unset FAMILIAR_GATE_TRACE
unset FAMILIAR_GATE_AGENT
```

Now start Claude Code in this window (plain `claude`, no `env -u` wrapper — §6 is over).
Inside that session, ask Claude Code to run a long-lived
shell command in the background — for example, ask it to run `sleep 120` using its Bash
tool with the background option, and confirm it reports the background shell as
started. **Immediately**, before that background process exits on its own, capture the
whole process table twice, so both the terse and the full command line are on record.
Claude Code owns this shell while it runs, so open a second tab in this same Kitty window
for the two commands below — the process table is machine-wide, and which tab reads it
does not matter. A new tab is a new shell with none of this run's variables, so name the
output directory there first (the same two lines §2 opened with, which resolve to the same
directory rather than creating a new one), and go back to the original tab for probe 2:

```sh
export FAMILIAR_NODE_TMP="$(node -e 'process.stdout.write(require("node:os").tmpdir())')"
export FAMILIAR_GATE_DIR="$FAMILIAR_NODE_TMP/familiar-macos-terminal-gate"
```

```sh
LC_ALL=C /bin/ps -axo pid=,ppid=,tty=,lstart=,comm= > "$FAMILIAR_GATE_DIR/bg-comm.txt"
LC_ALL=C /bin/ps -axo pid=,ppid=,tty=,lstart=,command= > "$FAMILIAR_GATE_DIR/bg-command.txt"
```

Read `bg-comm.txt` and find the chain from the backgrounded `sleep` up through its
parents to the Claude Code process. There are three possible outcomes, and all three are
recorded — the third is a finding, not a failure:

1. **The intermediate process (whatever hosts the background subtree) appears with a
   `??` (no-tty) TTY column.** This is the expected, correct case: Familiar's resolver
   correctly skips a TTY-less ancestor when walking up from a hook firing under this
   subtree, and the gap this probe exists to close is closed.
2. **The intermediate process appears owning a real TTY token** (`ttys<hex>` or
   `s<hex>`, not `??`). **Stop the entire run and report this immediately** — this is a
   wrong-target resolver defect, not a rendering-gate finding, and it reopens the design
   rather than being folded into a promotion. Preserve both `bg-*.txt` files as evidence.
3. **The background subtree cannot be induced on this installed version** (for example,
   the agent's background-execution feature is unavailable or behaves differently).
   Record this plainly in §10. It does not block the rendering promotion this gate is
   otherwise proving — resolver ancestor-discrimination and terminal rendering are
   independent claims, and Linux evidence already covers the ancestor-discrimination
   half in that case.

### Probe 2 — the fail-closed contract

A `launchd` LaunchAgent running one headless `claude -p` prompt with stdio fully
detached and no controlling terminal anywhere in its process chain. `launchd` gives the
job no inherited shell environment at all, so the plist below sets every variable the
job needs itself, including `FAMILIAR_GATE_TRACE` and both output paths.

Resolve the values the plist needs, each through a command substitution (guard 3):

```sh
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/probe2.jsonl"
if [ -e "$FAMILIAR_GATE_TRACE" ]; then
  printf 'STOP: probe 2 already has a trace: %s\n' "$FAMILIAR_GATE_TRACE" >&2
else
  printf 'ok: fresh probe 2 trace path\n'
fi
FAMILIAR_GATE_CLAUDE_BIN="$(command -v claude)"
if [ -x "$FAMILIAR_GATE_CLAUDE_BIN" ]; then
  printf 'ok: claude at %s\n' "$FAMILIAR_GATE_CLAUDE_BIN"
else
  printf 'STOP: claude is not on PATH as an executable\n' >&2
fi
FAMILIAR_GATE_LAUNCHD_PATH="$PATH"
```

Write the plist. Its label and its target filename must match exactly
(`dev.familiar.gate-probe`), and it must live under `~/Library/LaunchAgents/`:

```sh
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/dev.familiar.gate-probe.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.familiar.gate-probe</string>
  <key>ProgramArguments</key>
  <array>
    <string>$FAMILIAR_GATE_CLAUDE_BIN</string>
    <string>-p</string>
    <string>Reply with the single word: probe.</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$FAMILIAR_GATE_LAUNCHD_PATH</string>
    <key>FAMILIAR_GATE_TRACE</key>
    <string>$FAMILIAR_GATE_TRACE</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$FAMILIAR_GATE_DIR/probe2-stdout.txt</string>
  <key>StandardErrorPath</key>
  <string>$FAMILIAR_GATE_DIR/probe2-stderr.txt</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
PLIST
```

Load and run it once:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.familiar.gate-probe.plist
launchctl kickstart -w gui/$(id -u)/dev.familiar.gate-probe
```

Wait for it to finish (`launchctl kickstart -w` blocks until the job's first run exits;
if it returns immediately and the output files are still empty, poll
`launchctl print gui/$(id -u)/dev.familiar.gate-probe` for a few seconds until it
reports the job is no longer running), then check all three required results:

```sh
cat "$FAMILIAR_GATE_DIR/probe2-stderr.txt"
grep -c 'could not find the claude-code process' "$FAMILIAR_GATE_DIR/probe2-stderr.txt"
launchctl print gui/$(id -u)/dev.familiar.gate-probe 2>/dev/null | grep -i 'last exit status'
wc -l < "$FAMILIAR_GATE_DIR/probe2.jsonl" 2>/dev/null || printf '0 (file does not exist)\n'
```

Required: the named `could not find the claude-code process` diagnostic present in
`probe2-stderr.txt` (this is `familiar hook`'s own cosmetic-error text — `hook` is a
cosmetic command and formats every thrown error to stderr while still exiting 0); a last
exit status of 0; and **zero lines** in `probe2.jsonl` — no trace file at all is also an
acceptable zero, since the resolver failure is thrown before any write is attempted, so
`traceWrite` is never reached. This is the only Darwin exercise of the rule that a
resolver failure reaches this cosmetic diagnostic rather than being swallowed silently.

Unload and delete the plist in §11 — do not leave it registered with `launchd` after
this run.

### The Kitty window's work is done — now do the Ghostty pass

Everything that had to happen in the original Kitty window has happened: §5's three cells
and their reap sequences, the Node spot-check, §6's two negative controls, and both probes
above. Close that window now, open Ghostty, and run **§2 and §5 only** there — §3, §4,
§6 and §7 are once-per-gate and are already done. Come back to §8 when the three Ghostty
cells are captured and verified.

## 8. Validate the artifact inventory

The complete inventory this gate returns:

```text
kitty-claude-code.jsonl       ghostty-claude-code.jsonl
kitty-codex.jsonl             ghostty-codex.jsonl
kitty-opencode.jsonl          ghostty-opencode.jsonl
spot-check.jsonl               codex-events.jsonl (Pass B)
capability-none-claude-code.jsonl
capability-none-opencode.jsonl
probe2.jsonl                  probe2-stderr.txt
bg-comm.txt                   bg-command.txt
versions-kitty.txt            versions-ghostty.txt
reap-session-<cell>.json      reap-pid-<cell>.txt     reap-identity-<cell>.txt
reap-target-<cell>.txt        before-reap-<cell>.json reap-<cell>.txt
after-reap-<cell>.json                                    (× 6 cells = 42 files)
notes.md
```

Confirm every non-reap file above exists and is non-empty (`probe2.jsonl` is the one
named exception — it is expected to not exist, or to exist empty):

```sh
node -e '
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAMILIAR_GATE_DIR;
const expected = [
  "kitty-claude-code.jsonl", "kitty-codex.jsonl", "kitty-opencode.jsonl",
  "ghostty-claude-code.jsonl", "ghostty-codex.jsonl", "ghostty-opencode.jsonl",
  "spot-check.jsonl", "codex-events.jsonl",
  "capability-none-claude-code.jsonl", "capability-none-opencode.jsonl",
  "probe2-stderr.txt", "bg-comm.txt", "bg-command.txt",
  "versions-kitty.txt", "versions-ghostty.txt",
];
for (const name of expected) {
  const p = path.join(dir, name);
  const ok = fs.existsSync(p) && fs.statSync(p).size > 0;
  console.log(`${ok ? "present" : "MISSING"}  ${name}`);
}
const probe2 = path.join(dir, "probe2.jsonl");
console.log(fs.existsSync(probe2)
  ? `probe2.jsonl exists, ${fs.statSync(probe2).size} bytes (expected 0)`
  : "probe2.jsonl absent (expected)");
'
```

Each cell trace was already verified as it was captured, in §5, with that cell's own
`--expect-rdev` and `--expect-capability`. This section re-runs every trace together as
a final sweep, reading each run's device from its own `versions-<terminal>.txt` rather
than trusting whatever the current shell's variables still happen to hold:

```bash
KITTY_RDEV=$(sed -n 's/^terminal-rdev=//p' "$FAMILIAR_GATE_DIR/versions-kitty.txt")
GHOSTTY_RDEV=$(sed -n 's/^terminal-rdev=//p' "$FAMILIAR_GATE_DIR/versions-ghostty.txt")
V="$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs"

for agent in claude-code codex opencode; do
  node "$V" "$FAMILIAR_GATE_DIR/kitty-$agent.jsonl" \
    --expect-rdev "$KITTY_RDEV" --expect-capability kitty-animation
  node "$V" "$FAMILIAR_GATE_DIR/ghostty-$agent.jsonl" \
    --expect-rdev "$GHOSTTY_RDEV" --expect-capability static-graphics
done

node "$V" "$FAMILIAR_GATE_DIR/spot-check.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability kitty-animation
node "$V" "$FAMILIAR_GATE_DIR/capability-none-claude-code.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability none
node "$V" "$FAMILIAR_GATE_DIR/capability-none-opencode.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability none --no-require-restore
```

Because the two runs happen in two different terminal windows, `--expect-rdev` differs
between them; that is exactly why it is recorded per run in §2 rather than assumed to be
one value for the whole gate. Record every command's exit code and its `VIOLATION` lines
(if any) in §10 — a nonzero exit on any trace is a failing cell for that trace's row in
the notes, not grounds to silently retry and overwrite the evidence.

The traces carry no tool payloads by construction (they record escape sequences, not
what an agent said or did), which every one of the verifier's clean exits above
corroborates independently of §9's redaction pass.

## 9. Redact

Create a separate return directory, and from here on edit only its copies — never the
originals in `$FAMILIAR_GATE_DIR`:

```sh
export FAMILIAR_GATE_RETURN_DIR="$FAMILIAR_NODE_TMP/familiar-terminal-gate-return"
if [ -e "$FAMILIAR_GATE_RETURN_DIR" ]; then
  printf 'STOP: a return directory already exists: %s\n' "$FAMILIAR_GATE_RETURN_DIR" >&2
else
  mkdir -m 700 "$FAMILIAR_GATE_RETURN_DIR"
  printf 'ok: created %s\n' "$FAMILIAR_GATE_RETURN_DIR"
fi
```

Copy exactly the §8 inventory — never a glob. Four files that must **not** be returned
live in `$FAMILIAR_GATE_DIR` alongside the inventory, and a `*.json`/`*.txt` glob would
silently pull them into the return set even though §10 declares the return directory holds
the §8 inventory and nothing else:

- `claude-code.json` and `codex.json` — §4's generator stdout, already validated there and
  not part of the promoted evidence.
- `codex-hooks-pristine.json` — this run's *merged* Codex configuration. It embeds the
  absolute `/Users/<name>/…` path of this checkout's `bin/familiar` **and every hook the
  tester already had**, which are theirs and are not evidence of anything this gate proves.
- `probe2-stdout.txt` — the live agent's own reply text, from the plist's
  `StandardOutPath`.

Listing the inventory explicitly is also what makes a stray file some other command
dropped into `$FAMILIAR_GATE_DIR` impossible to return by accident:

```bash
FAMILIAR_GATE_RETURN_FILES=(
  kitty-claude-code.jsonl kitty-codex.jsonl kitty-opencode.jsonl
  ghostty-claude-code.jsonl ghostty-codex.jsonl ghostty-opencode.jsonl
  spot-check.jsonl codex-events.jsonl
  capability-none-claude-code.jsonl capability-none-opencode.jsonl
  probe2.jsonl probe2-stderr.txt
  bg-comm.txt bg-command.txt
  versions-kitty.txt versions-ghostty.txt
)
for cell in kitty-claude-code kitty-codex kitty-opencode \
            ghostty-claude-code ghostty-codex ghostty-opencode; do
  FAMILIAR_GATE_RETURN_FILES+=(
    "reap-session-$cell.json" "reap-pid-$cell.txt" "reap-identity-$cell.txt"
    "reap-target-$cell.txt" "before-reap-$cell.json" "reap-$cell.txt" "after-reap-$cell.json"
  )
done
for name in "${FAMILIAR_GATE_RETURN_FILES[@]}"; do
  if [ -e "$FAMILIAR_GATE_DIR/$name" ]; then
    cp -p "$FAMILIAR_GATE_DIR/$name" "$FAMILIAR_GATE_RETURN_DIR/$name"
  else
    printf 'not returning missing file: %s\n' "$name" >&2
  fi
done
chmod 600 "$FAMILIAR_GATE_RETURN_DIR/"*
```

Review every file and apply these rules to the copies:

- Replace the account name in `/Users/<name>/...` with `/Users/REDACTED/...`.
- Replace private repository/workspace names and unrelated command arguments (in
  `bg-comm.txt` / `bg-command.txt`, and in `probe2-stderr.txt` if a longer diagnostic
  quotes a path) with `<REDACTED>`.
- Remove tokens, credentials, private URLs, prompt text, and any other user-provided
  secret completely.
- Preserve every PID, PPID, TTY, `lstart`, executable basename, agent name, event name,
  timestamp, digest, and escape decomposition. These are the evidence; the trace files
  in particular carry no free text to redact at all beyond the `target` path field.
- Keep every `.jsonl` file valid JSON Lines, one object per line, after editing.

Run this mechanical backstop over the return copies after manual redaction. It prints
only filenames and rule names, never the matching secret text:

```sh
export FAMILIAR_GATE_USERNAME="$(id -un)"
node --input-type=module <<'NODE'
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const escapedUser = process.env.FAMILIAR_GATE_USERNAME
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
for (const name of readdirSync(process.env.FAMILIAR_GATE_RETURN_DIR)) {
  const text = readFileSync(join(process.env.FAMILIAR_GATE_RETURN_DIR, name), 'utf8');
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
unset FAMILIAR_GATE_USERNAME
```

Only after that command prints `redaction scan passed` does §10's corresponding answer
become `yes`. Do not commit either directory — the raw one or the return one. The
return directory's contents are sent later as file attachments, never pasted text, in
the same thread that delivered this handoff (§12).

## 10. Tester notes

Create `$FAMILIAR_GATE_RETURN_DIR/notes.md` with this checklist, filled in as you go
rather than reconstructed afterward:

```markdown
# macOS terminal gate notes

- Tester:
- Capture date (UTC):
- Mac model / architecture:
- macOS version:
- Node (matrix) / Node (spot-check):
- Familiar commit:

## Kitty matrix
- kitty-claude-code.jsonl: gate-verify exit code ___, status-line sprite confirmed visible yes/no
- kitty-codex.jsonl: gate-verify exit code ___
- kitty-opencode.jsonl: gate-verify exit code ___
- Reap sequence (all three agents): pass/fail, notes

## Ghostty matrix
- ghostty-claude-code.jsonl: gate-verify exit code ___, status-line sprite confirmed visible yes/no
- ghostty-codex.jsonl: gate-verify exit code ___
- ghostty-opencode.jsonl: gate-verify exit code ___
- Reap sequence (all three agents): pass/fail, notes

## Codex's six configured events (Pass B, codex-events.jsonl)
- All six fired: yes/no
- SessionStart: yes/no   UserPromptSubmit: yes/no
- PreToolUse: yes/no     PermissionRequest: yes/no
- Stop: yes/no           SessionEnd: yes/no

## Node spot-check
- spot-check.jsonl: gate-verify exit code ___
- Installed Node version used:

## Capability `none` negative control
- capability-none-claude-code.jsonl: gate-verify exit code ___, window tinted yes/no, bell heard yes/no, no sprite confirmed yes/no
- capability-none-opencode.jsonl: gate-verify exit code ___, window tinted yes/no, bell heard yes/no, no sprite confirmed yes/no

## Background and daemon appendix
- Probe 1 outcome: (1) no-tty ancestor confirmed / (2) STOP — TTY-owning ancestor found / (3) could not induce
- Probe 2: diagnostic present yes/no, exit status ___, probe2.jsonl line count ___

## Configuration
- Familiar configuration before this run: scheme set yes/no, theme already installed yes/no (id: ___)
- Theme this run installed, if any: ___
- `install opencode` refused and required hand-editing: yes/no — files edited by hand:

## Restoration
- Claude settings byte-for-byte restored: yes/no
- Codex hooks byte-for-byte restored: yes/no
- OpenCode configs byte-for-byte restored: yes/no
- Familiar's own configuration directory restored: yes/no
- LaunchAgent unloaded and plist removed: yes/no

## Privacy
- Mechanical redaction scan passed: yes/no

## Anything else observed that this checklist did not ask about
```

The return directory must contain exactly the inventory listed in §8 plus this
`notes.md` — nothing else.

## 11. Restore configuration

Close every agent, and unload and remove the LaunchAgent from §7 first:

```sh
launchctl bootout gui/$(id -u)/dev.familiar.gate-probe 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/dev.familiar.gate-probe.plist"
launchctl print gui/$(id -u)/dev.familiar.gate-probe 2>&1 | grep -q 'Could not find' \
  && printf 'LaunchAgent unloaded\n' || printf 'WARNING: LaunchAgent may still be loaded\n' >&2
```

Then restore every configuration file that existed before §3–§4; remove only a file
whose matching `.absent` marker proves this run created it. **Every comparison below
prints its own verdict** — `cmp -s` is silent on success *and* on failure, so a bare `cmp`
would leave you nothing to read before ticking a `yes` in `notes.md`:

```sh
if [ -f "$FAMILIAR_GATE_BACKUP_DIR/claude/settings.json" ]; then
  mkdir -p "$HOME/.claude"
  cp -p "$FAMILIAR_GATE_BACKUP_DIR/claude/settings.json" "$HOME/.claude/settings.json"
  if cmp -s "$FAMILIAR_GATE_BACKUP_DIR/claude/settings.json" "$HOME/.claude/settings.json"; then
    printf 'restored: %s\n' "$HOME/.claude/settings.json"
  else
    printf 'RESTORE FAILED: %s\n' "$HOME/.claude/settings.json" >&2
  fi
elif [ -f "$FAMILIAR_GATE_BACKUP_DIR/claude/settings.absent" ]; then
  rm -f "$HOME/.claude/settings.json"
  if [ -e "$HOME/.claude/settings.json" ]; then
    printf 'RESTORE FAILED: %s should not exist\n' "$HOME/.claude/settings.json" >&2
  else
    printf 'removed (absent before this run): %s\n' "$HOME/.claude/settings.json"
  fi
fi

if [ -f "$FAMILIAR_GATE_BACKUP_DIR/codex/hooks.json" ]; then
  mkdir -p "$FAMILIAR_CODEX_DIR"
  cp -p "$FAMILIAR_GATE_BACKUP_DIR/codex/hooks.json" "$FAMILIAR_CODEX_DIR/hooks.json"
  if cmp -s "$FAMILIAR_GATE_BACKUP_DIR/codex/hooks.json" "$FAMILIAR_CODEX_DIR/hooks.json"; then
    printf 'restored: %s\n' "$FAMILIAR_CODEX_DIR/hooks.json"
  else
    printf 'RESTORE FAILED: %s\n' "$FAMILIAR_CODEX_DIR/hooks.json" >&2
  fi
elif [ -f "$FAMILIAR_GATE_BACKUP_DIR/codex/hooks.absent" ]; then
  rm -f "$FAMILIAR_CODEX_DIR/hooks.json"
  if [ -e "$FAMILIAR_CODEX_DIR/hooks.json" ]; then
    printf 'RESTORE FAILED: %s should not exist\n' "$FAMILIAR_CODEX_DIR/hooks.json" >&2
  else
    printf 'removed (absent before this run): %s\n' "$FAMILIAR_CODEX_DIR/hooks.json"
  fi
fi

mkdir -p "$FAMILIAR_OPENCODE_DIR"
for name in tui.json opencode.json tui.jsonc opencode.jsonc; do
  if [ -f "$FAMILIAR_GATE_BACKUP_DIR/opencode/$name" ]; then
    cp -p "$FAMILIAR_GATE_BACKUP_DIR/opencode/$name" "$FAMILIAR_OPENCODE_DIR/$name"
    if cmp -s "$FAMILIAR_GATE_BACKUP_DIR/opencode/$name" "$FAMILIAR_OPENCODE_DIR/$name"; then
      printf 'restored: %s\n' "$FAMILIAR_OPENCODE_DIR/$name"
    else
      printf 'RESTORE FAILED: %s\n' "$FAMILIAR_OPENCODE_DIR/$name" >&2
    fi
  elif [ -f "$FAMILIAR_GATE_BACKUP_DIR/opencode/$name.absent" ]; then
    rm -f "$FAMILIAR_OPENCODE_DIR/$name"
    if [ -e "$FAMILIAR_OPENCODE_DIR/$name" ]; then
      printf 'RESTORE FAILED: %s should not exist\n' "$FAMILIAR_OPENCODE_DIR/$name" >&2
    else
      printf 'removed (absent before this run): %s\n' "$FAMILIAR_OPENCODE_DIR/$name"
    fi
  fi
done
```

Finally, put Familiar's own configuration back exactly as §3 found it — the scheme this
run set, and the theme pack it may have installed, are this run's changes to the tester's
machine and do not survive it:

```sh
if [ -z "$FAMILIAR_CONFIG_DIR_PATH" ]; then
  # A new shell, or a run resumed after a reboot. Nothing below may run against an empty
  # path: rebuild the variable from §3 first.
  printf 'STOP: FAMILIAR_CONFIG_DIR_PATH is empty — re-export it from §3 before restoring\n' >&2
elif [ -d "$FAMILIAR_GATE_BACKUP_DIR/familiar-config" ]; then
  rm -rf -- "$FAMILIAR_CONFIG_DIR_PATH"
  cp -R -p "$FAMILIAR_GATE_BACKUP_DIR/familiar-config" "$FAMILIAR_CONFIG_DIR_PATH"
  if diff -r "$FAMILIAR_GATE_BACKUP_DIR/familiar-config" "$FAMILIAR_CONFIG_DIR_PATH" >/dev/null; then
    printf 'restored: %s\n' "$FAMILIAR_CONFIG_DIR_PATH"
  else
    printf 'RESTORE FAILED: %s\n' "$FAMILIAR_CONFIG_DIR_PATH" >&2
  fi
elif [ -f "$FAMILIAR_GATE_BACKUP_DIR/familiar-config.absent" ]; then
  rm -rf -- "$FAMILIAR_CONFIG_DIR_PATH"
  if [ -e "$FAMILIAR_CONFIG_DIR_PATH" ]; then
    printf 'RESTORE FAILED: %s should not exist\n' "$FAMILIAR_CONFIG_DIR_PATH" >&2
  else
    printf 'removed (absent before this run): %s\n' "$FAMILIAR_CONFIG_DIR_PATH"
  fi
fi
```

Every command above must print a `restored:` or `removed` line before marking restoration
`yes` in `notes.md`. Any `RESTORE FAILED` line means do not mark that line `yes` —
investigate before proceeding to §12; the backup in `$FAMILIAR_GATE_BACKUP_DIR` is still
intact and is the source of truth for a second attempt.

## 12. Send and clean up after receipt

Send exactly the files in the §8 inventory (the redacted copies from §9, in
`$FAMILIAR_GATE_RETURN_DIR`) as file attachments, not pasted text, in the same
direct-message thread that delivered this handoff. Do not send the raw
`$FAMILIAR_GATE_DIR` or its contents. Wait for the recipient to confirm that every
attachment was saved intact before deleting anything.

After confirmation, validate every deletion target before removing local copies and the
clone. Every guard is chained to the deletion with `&&`, inside a subshell — written as
a flat sequence the `test` lines would print nothing and stop nothing, and execution
would fall straight through to `rm -rf`; `set -e` does not fix that either, since a shell
disables errexit inside a compound command used as the left operand of `||`. Only the
explicit chain below is safe, and the subshell keeps a failed guard from closing the
tester's own session:

```sh
(
  case "$FAMILIAR_GATE_BACKUP_DIR" in
    "$FAMILIAR_NODE_TMP"/familiar-gate-config.*) ;;
    *) printf 'refusing unexpected backup path: %s\n' "$FAMILIAR_GATE_BACKUP_DIR" >&2; exit 1 ;;
  esac
  test "$FAMILIAR_GATE_DIR" = "$FAMILIAR_NODE_TMP/familiar-macos-terminal-gate" \
    && test "$FAMILIAR_GATE_RETURN_DIR" = "$FAMILIAR_NODE_TMP/familiar-terminal-gate-return" \
    && test "$FAMILIAR_GATE_ROOT" = "$HOME/familiar-macos-terminal-gate" \
    && cd "$HOME" \
    && rm -rf -- \
      "$FAMILIAR_GATE_BACKUP_DIR" \
      "$FAMILIAR_GATE_DIR" \
      "$FAMILIAR_GATE_RETURN_DIR" \
      "$FAMILIAR_GATE_ROOT"
) || printf 'cleanup refused: nothing was deleted\n' >&2
```

Delete the direct-message thread after both sides confirm their required local copy is
safely stored. Do not merge `spike/macos-terminal-gate`. Its only durable output is the
reviewed and redacted evidence note this handoff's artifacts are used to write, and any
provisional-warning removal in `docs/install.md` that a full pass earns.
