# macOS Core Support — Design

**Status:** proposed; approved in chat, not implemented
**Date:** 2026-08-22

Familiar currently develops and tests against Linux. This milestone makes its
portable core a CI-backed macOS product without pretending GitHub Actions can
prove behavior inside a real Kitty or Ghostty window.

The support claim is deliberately split:

- **Supported:** macOS 14+ on Apple Silicon, Node 22, checkout installation,
  Familiar configuration and themes, the CLI, Claude Code lifecycle and status
  line configuration, Codex hooks and native pets, and the OpenCode integration.
- **Provisional:** live Familiar graphics, tint, and bell delivery in Kitty and
  Ghostty until one physical-Mac smoke pass exercises each agent.
- **Expected, not claimed:** Intel Macs and macOS 13.

Linux behavior and its Node 22/26 CI remain supported unchanged.

## 1. Scope

**In:**

- A Darwin implementation of the process, liveness, environment, and terminal
  operations currently provided through Linux `/proc`.
- Portable handle-bound theme traversal.
- A portable test-suite lease and stale-root ownership marker.
- One macOS 14 Apple-Silicon / Node 22 GitHub Actions job.
- Checkout-based installation instructions and a Node 22 engine declaration.
- Non-mutating, copy-ready Claude Code and Codex setup output.
- macOS documentation, including a `launchd` example for periodic reaping.

**Out:**

- Homebrew, npm publication, or another distribution channel.
- Automatic edits to Claude Code or Codex configuration.
- Native `~/Library` paths; Familiar keeps `~/.config/familiar` and
  `~/.local/state/familiar` on both platforms.
- Ports of Niri or Noctalia integrations.
- Windows support.
- Support claims for tmux, other graphics protocols, additional terminals,
  Intel Macs, macOS 13, or live terminal behavior not exercised on a real Mac.

## 2. Architecture

Keep the protocol, bus, resolver, adapters, renderers, and CLI architecture.
Replace only the operating-system operations beneath them.

The process boundary returns one normalized record:

```js
{ pid, ppid, comm, tty, starttime }
```

`tty` is a validated terminal identifier or `null`; `starttime` is an integer
whose scale is platform-private and whose only contract is stable equality for
one process lifetime.

### Linux

The existing `/proc/<pid>/stat`, `/proc/<pid>/environ`, and
`/proc/<pid>/fd/1` behavior remains the Linux implementation. The parser keeps
its last-parenthesis rule for process names and its kernel start-time field.

### Darwin

Darwin runs `/bin/ps` with `LC_ALL=C` and parses PID, parent PID, command name,
controlling TTY, and long start time. It normalizes the command to its basename,
turns the long start time into an integer timestamp, and rejects malformed or
ambiguous rows. One process-table read supplies ancestor walking; a targeted
read supplies later start-time and terminal checks.

The three adapters retain their existing rule: skip the hook process and choose
the first ancestor whose normalized command is the expected agent name and
whose `tty` is non-null. The expected names remain `claude`, `codex`, and
`opencode`; expanding those names requires evidence from a real release rather
than a speculative alias list.

Liveness remains process identity, not PID presence:

1. `process.kill(pid, 0)` proves that some process occupies the PID.
2. A fresh platform start-time read must equal the stored `starttime`.
3. An absent or mismatched start time means dead/unverifiable and is pruned.

For terminal output, Darwin accepts only a TTY basename matching the macOS
pseudoterminal form and opens `/dev/<tty>`. It applies the same `isatty` gate and
complete-write loop as Linux. It never builds a path from an unchecked `ps`
value. Darwin uses the hook process's inherited environment for Kitty/Ghostty
capability detection; Claude Code documents that hook commands inherit their
parent environment. Codex does not use Familiar-rendered pet graphics, and
OpenCode's renderer already runs inside OpenCode with its own environment.

Unknown operating systems fail with a named unsupported-platform error. There
is no `/proc` probe or Linux fallback on Darwin.

## 3. Data flow

The event path remains:

```text
agent hook/plugin
  -> adapter validates event and resolves terminal-owning agent process
  -> locked bus transaction records pid + starttime and resolves intent
  -> terminal emitter selects the platform environment and TTY target
  -> existing Kitty/Ghostty encoder writes only after the complete byte plan exists
```

Session pruning and lock reclamation call the same platform liveness function,
so the bus, locks, and test runner agree on what identifies a process.

No TTY path or environment is stored in `agents.json`. Both are presentation
facts and are re-read when output is attempted; the durable record continues to
store only PID and start time.

## 4. Filesystem and test-runner portability

Theme acquisition changes its handle-bound path from `/proc/self/fd/<n>` to
`/dev/fd/<n>`. Linux and macOS both expose that POSIX-facing path. The existing
`O_DIRECTORY | O_NOFOLLOW`, device/inode verification, special-file refusal,
abort, and growth-limit behavior remains mandatory. If `/dev/fd` cannot retain
those guarantees, acquisition fails; it does not fall back to a pathname walk.

The test runner replaces its Linux abstract socket with the existing
process-identified file lock under the system temporary directory, scoped by
user id and held for the suite lifetime. It uses `staleMs: Infinity` and one
retry: a live second suite is refused without waiting through the normal bus
lock budget, while a dead holder can be reclaimed and acquired on the retry.
Linux keeps its PID-namespace marker for stale scratch roots. Darwin uses a
fixed host marker because it has no Linux PID namespaces; start-time identity
still prevents PID-reuse mistakes.

This reuses the repository's lock implementation instead of adding a second
cross-platform locking protocol.

## 5. Public setup interface

Add one non-mutating command family:

```text
familiar setup claude-code
familiar setup codex
```

Each command accepts no positional arguments or flags and writes one valid JSON
document to stdout, followed by a newline. Diagnostics go to stderr and failure
is nonzero.

- `setup claude-code` returns the settings fragment containing Familiar's
  lifecycle hooks and `statusLine` command.
- `setup codex` returns the complete Familiar hooks document.

Every command value uses the absolute `bin/familiar` path resolved from the
running package, encoded through `JSON.stringify`; spaces and JSON-significant
characters therefore need no shell escaping. The commands never inspect or
write `~/.claude` or `~/.codex`. Users review and merge the output themselves.

The existing mutating commands remain distinct:

- `familiar install pets [--sync-projects]` generates Codex pets and optionally
  managed project pet selections.
- `familiar install opencode` merges the two OpenCode plugin registrations.

## 6. Installation and documentation

The documented checkout installation is:

```sh
git clone <engine-url>
cd familiar
npm install
npm link
familiar scheme set dark
familiar theme add <theme-url-or-directory>
```

`package.json` declares Node `>=22`. This is the engine floor already exercised
by Linux CI and matches the selected macOS support floor.

`docs/install.md` begins with shared setup, then separates macOS and Linux-only
integration steps. The macOS path covers:

1. Checkout installation, scheme, and theme.
2. `setup claude-code` output merged into `~/.claude/settings.json`.
3. `install pets`, project syncing, and `setup codex` output for
   `$CODEX_HOME/hooks.json`.
4. `install opencode`, whose documented global directory is
   `~/.config/opencode` on both macOS and Linux.
5. An optional user LaunchAgent invoking `familiar reap` every minute.
6. The provisional Kitty/Ghostty smoke checklist.

The Linux section retains Niri, Noctalia, and systemd instructions. User-facing
docs must not imply those integrations exist on macOS.

## 7. CI and tests

The existing Linux matrix remains Node 22 and 26. Add one `macos-14` / Node 22
job that runs:

1. `npm ci`.
2. The complete fast suite through `npm test`.
3. A clean-checkout `npm install` and `npm link`, followed by
   `familiar --help` through the installed command.

The macOS suite must include:

- Fixture tests for Darwin `ps` parsing, basename normalization, malformed
  rows, no-TTY rows, and unsafe TTY values.
- Real-runner checks that the current process has a readable ancestor chain and
  stable start-time identity, and that PID recycling comparisons fail closed.
- Injected Darwin terminal-target and environment tests that prove the exact
  `/dev/<tty>` open and capability selection without writing to the CI runner's
  terminal.
- Existing adversarial local-theme acquisition and growth-scan tests through
  `/dev/fd`.
- Test-runner exclusion, dead-holder cleanup, and scratch-root cleanup.
- Exact setup-command JSON, including a package path containing spaces.

The macOS job cannot establish a graphical login session, run an interactive
agent TUI, or prove terminal-device permissions. A green job therefore promotes
the core support claim but not the provisional live-rendering claim.

## 8. Error contract

- `ps` absence, nonzero exit, malformed output, unknown agent ancestry, missing
  start time, or unsafe TTY data is a named error. None becomes an invented
  process record.
- A missing graphics marker means capability `none`, matching current behavior.
- Failure to open or validate the selected TTY writes no bytes.
- Hook failures retain the existing cosmetic boundary: one sanitized diagnostic
  and exit zero, so Familiar cannot break an agent turn.
- User-invoked setup, install, theme, and validation failures remain nonzero.
- `/dev/fd` failure aborts acquisition without an unsafe traversal fallback.

## 9. Manual promotion gate

After CI is green, a one-time real-Mac smoke pass runs Claude Code, Codex, and
OpenCode in current Kitty and Ghostty releases. For each applicable pair it
checks launch/idle, working, approval, done/error where the adapter exposes it,
session exit, and `familiar reap` after abnormal termination.

Failures do not roll back the CI-backed core claim. They keep terminal rendering
provisional and produce focused fixes backed by captured process names, TTY
values, environment markers, and concise diagnostics. The provisional label is
removed only when the smoke evidence exists.

## 10. Alternatives rejected

**State-only Darwin support.** Smaller, but Claude Code would lose the familiar
surface and terminal tint/bell behavior. The selected platform seam can support
those features without changing the protocol.

**Per-terminal companion daemon.** It would own the TTY and environment cleanly,
but adds process lifecycle, IPC, installation, and failure modes before the
native Darwin primitives have been tried.

**Homebrew in this milestone.** Distribution machinery does not prove runtime
compatibility. Add it after physical-Mac smoke testing establishes a package
worth distributing.

**Native macOS application directories.** The current paths already align with
OpenCode and preserve one configuration contract across Linux and macOS.

## 11. Current upstream evidence

- Claude Code supports macOS 13+ and documents inherited hook environments,
  command hooks through `sh -c` on macOS/Linux, and status lines in
  `~/.claude/settings.json`:
  <https://code.claude.com/docs/en/getting-started>,
  <https://code.claude.com/docs/en/hooks>, and
  <https://code.claude.com/docs/en/statusline>.
- Codex documents lifecycle hooks and terminal pets; terminal pets support
  iTerm2 or Kitty/Sixel-capable terminals and remain unavailable inside tmux:
  <https://learn.chatgpt.com/docs/config-file/config-reference> and
  <https://learn.chatgpt.com/docs/pets>.
- OpenCode documents `~/.config/opencode` and its plugin directories for both
  macOS and Linux:
  <https://dev.opencode.ai/docs/config> and
  <https://dev.opencode.ai/docs/plugins/>.
- GitHub provides a standard Apple-Silicon `macos-14` runner:
  <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>.

## 12. Decisions

| Decision | Choice |
| --- | --- |
| First support claim | CI-backed core; live terminal rendering provisional |
| macOS floor | macOS 14+, Apple Silicon, Node 22 |
| Installation | checkout + `npm install` + `npm link` |
| Familiar paths | existing `~/.config` and `~/.local/state` paths |
| Agent configuration | generated JSON only; never auto-merge Claude/Codex files |
| Process source | Linux `/proc`; Darwin `/bin/ps` with strict parsing |
| Terminal target | Linux process fd; Darwin validated `/dev/<tty>` |
| Theme traversal | `/dev/fd`; no unsafe fallback |
| macOS CI | one `macos-14` / Node 22 full-suite and install-smoke job |
| Deferred | Homebrew, Intel/macOS 13 claims, other terminals, Niri/Noctalia ports |
