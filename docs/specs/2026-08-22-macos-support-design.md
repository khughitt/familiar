# macOS Core Support — Design

**Status:** portable core implemented and CI-backed; live-hook ancestry and
executor gate closed 2026-08-23; Darwin adapter activation pending and physical
terminal rendering provisional
**Date:** 2026-08-22

Familiar's portable core now runs in Linux and macOS CI without pretending
GitHub Actions can prove behavior inside a real Kitty or Ghostty window.

The target support claim is deliberately split:

- **Supported once Darwin adapter activation lands:** macOS 14+ on Apple
  Silicon, Node 22, checkout installation, Familiar configuration and themes,
  the CLI, Claude Code lifecycle and status-line configuration, Codex hooks and
  native pets, and the OpenCode hook and installer. Both gates this claim waited
  on have now passed: CI is green, and the live-hook capture in §2 confirmed the
  resolver predicate. The adapters themselves still refuse on Darwin.
- **Provisional until physical-Mac smoke testing:** Familiar-rendered graphics,
  tint, and bell delivery in Kitty and Ghostty, including OpenCode's TUI sprite
  renderer.
- **Expected, not claimed:** Intel Macs and macOS 13.

Linux behavior and its Node 22/26 CI remain supported unchanged.

## 1. Scope

**In:**

- A Darwin implementation of the process, liveness, environment, and terminal
  operations currently provided through Linux `/proc`.
- Deliberate platform-specific theme traversal, preserving the Linux guarantees
  and documenting Darwin's weaker local-source race boundary.
- A portable test-suite lease and stale-root ownership marker.
- One macOS 14 Apple-Silicon / Node 22 GitHub Actions job.
- Checkout-based installation instructions and a new Node 22 engine floor.
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

## 2. Portability spikes and gates

A temporary `macos-14-arm64` / Node 22 Actions probe ran on macOS 14.8.7. Its
[successful run](https://github.com/khughitt/familiar/actions/runs/32606828880)
established these implementation facts:

- A directory opened with `O_DIRECTORY | O_NOFOLLOW` could not be traversed as
  `/dev/fd/N`: `readdir` returned `ENOTDIR`, while child `lstat` and `open`
  returned `ENOENT`. Darwin theme traversal therefore cannot be a path swap.
- Under a pseudo-terminal, `/usr/bin/tty` returned `/dev/ttys000`, and
  `/bin/ps -axo pid=,ppid=,tty=,lstart=,comm=` returned `ttys000`.
- Darwin `comm` can be the full executable path. A probe placed beneath a
  directory containing a space produced that full path, proving that `comm`
  must be the last field and parsed as the remainder of the row.
- Current Claude Code and OpenCode packages installed native arm64 executables;
  the current Codex package installed a JavaScript launcher. Unauthenticated
  startup did not provide a reliable substitute for a live hook ancestor chain.

That pre-resolver spike has been run. On 2026-08-23, a live hook from Claude
Code 2.1.241, codex-cli 0.149.0, and opencode 1.18.21 was captured on macOS
26.6.2 (Apple M4, Kitty 0.46.2) from the disposable `spike/macos-agent-handoff`
branch at `2f592ee`. The reviewed, redacted evidence is
`docs/ref/2026-08-23-macos-agent-process-spike.md`; the raw capture was never
committed. It establishes:

- The terminal-owning ancestor basenames are exactly `claude`, `codex`, and
  `opencode`, each with a non-null TTY, at depth 2, 2, and 1. The approved
  predicate — skip the hook process, then take the first ancestor whose basename
  matches and whose `tty` is non-null — needs no amendment.
- Codex's `comm` is the full vendored executable path, so basename
  normalization is load-bearing rather than cosmetic. The `node` npm launcher
  immediately above it shares the TTY but not the name, leaving the walk
  unambiguous without an additional rule.
- Claude Code executes its hook command through `/bin/sh -c` and honors the
  quoting `setupDocument` emits. Codex executes through `/bin/zsh -c`. That is
  a shell, measured with a deliberately unquoted path and a `; :` canary no
  whitespace-splitting executor could have produced, so Codex setup command
  encoding is unblocked and single-quote quoting is correct under both shells.
- OpenCode spawns Familiar directly, with no shell frame, in all 26 records.
- Familiar's hook process has no controlling terminal under Claude Code, which
  is exactly why the TTY target is read from the resolved agent's record rather
  than from the hook.

Two limits are carried forward rather than closed. No background or
daemon-hosted Claude Code session was observed, so the `tty !== null` half of
the predicate rests on Linux evidence. And the capture ran on macOS 26.6.2 with
Node 25 while CI runs macOS 14 with Node 22, so no single configuration has been
exercised end to end with live agents.

Darwin parser, Claude Code setup, CI, theme, and test-runner work proceeded
independently and are complete. The live-hook gate is now closed, which
authorizes Darwin adapter activation and Codex setup command encoding; neither
is implemented yet. A resolver miss is a named diagnostic at the hook's cosmetic
boundary, not a silent no-op.

The permanent core matrix is green in [run 32631362471](https://github.com/khughitt/familiar/actions/runs/32631362471):
Linux Node 22/26 and smoke passed, while macOS 14 / Node 22 ran all 833 tests
with 828 passing, five non-Darwin skips, and zero failures. Its real process
snapshot, Darwin parser, stable-theme, linked-help, and Claude setup JSON checks
all ran. CI alone never satisfied the live-hook gate; the capture recorded
above is what closed it.

## 3. Process architecture

Keep the protocol, bus, resolver, adapters, renderers, and CLI architecture.
Replace only the operating-system operations beneath them.

The process boundary returns one normalized record:

```js
{ pid, ppid, comm, tty, starttime }
```

`tty` is intentionally not an interchangeable path component:

- Linux returns `null` when `tty_nr === 0` and a non-null presence marker when
  `tty_nr !== 0`. Linux never decodes that device number or builds a path from it.
- Darwin returns `null` for no controlling terminal or a validated, canonical
  pseudo-terminal basename. Only the Darwin terminal operation consumes it.

Adapters test only `tty !== null`. Moving from `ttyNr` to `tty` therefore changes
the Linux parser, all three adapters, and their fixture tests, but not their
selection semantics.

`starttime` is an integer whose scale is platform-private. Equality identifies
one observed process lifetime; values are never compared across platforms.

### Linux

The existing `/proc/<pid>/stat`, `/proc/<pid>/environ`, and
`/proc/<pid>/fd/1` behavior remains the Linux implementation. The parser keeps
its last-parenthesis rule for process names and kernel clock-tick start time.

### Darwin process snapshot

The first process lookup in each top-level CLI invocation memoizes one snapshot
from:

```sh
LC_ALL=C /bin/ps -axo pid=,ppid=,tty=,lstart=,comm=
```

The parser reads the numeric PID and PPID, the TTY token, exactly five `lstart`
tokens, and then the entire remaining `comm` path. It takes `basename(comm)`
only after the row is structurally valid. No delimiter-based split is attempted
inside the command path.

Darwin accepts these TTY forms only:

```text
??                  -> null
ttys<hex digits>    -> ttys<hex digits>
s<hex digits>       -> ttys<hex digits>
```

The first form is the observed no-TTY marker. The second is the form observed on
the macOS 14 runner. The abbreviated third form is normalized conservatively;
all other values are rejected rather than joined beneath `/dev`.

The invocation injects the same snapshot-backed process operations into agent
resolution, `startTimeOf`, bus pruning, and terminal lookup. Lock-token minting
also gets the current process's start time from that snapshot. Consequently the
normal Darwin hook path spawns `ps` once, not once per bus record.

Two narrow cases require fresh targeted reads rather than the invocation
snapshot:

1. Reclaiming another process's lock must not trust a snapshot taken before that
   holder started. A contended lock performs one fresh identity read per
   observed lock token, memoized for that token. An unreadable identity is
   treated as live/unreclaimable, so Familiar may defer cleanup but cannot steal
   a live lock.
2. The test runner must identify the worker it just spawned, which cannot appear
   in the runner's earlier snapshot. It performs one fresh identity read for
   that worker's owner record.

Both reuse the same targeted identity primitive. Neither adds a `ps` spawn to
the normal hook path.

Bus liveness remains process identity, not PID presence:

1. `process.kill(pid, 0)` proves that some process occupies the PID.
2. The invocation snapshot must contain the PID with the stored `starttime`.
3. An absent or mismatched start time is dead/unverifiable and is pruned.

A process that exits after snapshot capture may remain for that invocation and
is pruned by the next one. This is the explicit cost of one consistent snapshot.

Darwin derives `starttime` from `lstart` at one-second granularity. PID reuse in
the same second can therefore collide, unlike Linux's clock-tick identity. The
finite, reused PID space makes that extremely unlikely rather than impossible;
the macOS claim does not pretend parity here.

Unknown operating systems fail with a named unsupported-platform error. There
is no `/proc` probe or Linux fallback on Darwin.

## 4. Terminal target and environment

Darwin opens only `/dev/<canonical tty>` from the validated snapshot record. It
applies the existing `isatty` gate, builds the complete byte plan before open,
and uses the existing complete-write loop. It never builds a path from raw `ps`
output.

Linux continues to derive both the TTY target and graphics environment from
`intent.pid`; its 1,507-sample spike is still the reason the hook environment is
not trusted there.

Node exposes neither process environments through `ps` nor Darwin's
`KERN_PROCARGS2` through core APIs. This milestone rejects a native helper or
dependency solely to recover the agent environment. Darwin therefore has two
explicit sources:

- TTY: the resolved agent's validated process-snapshot record.
- Graphics environment: the hook process's inherited environment, passed into
  the emitter independently of the TTY record.

This can be wrong after a resumed session, an agent re-exec from another
terminal, or environment changes between launcher and hook. Inside tmux it may
correctly classify capability as `none`. Missing or stale graphics markers
degrade only graphics to capability `none`; tint and bell still target the
validated TTY. The emitter seam therefore accepts environment and terminal
target separately instead of deriving both from `intent.pid`.

Both halves of that split are now measured rather than assumed
(`docs/ref/2026-08-23-macos-agent-process-spike.md`). All 30 captured hook
processes inherited `TERM`, `KITTY_WINDOW_ID`, and `KITTY_PID`, which is
sufficient for `graphicsCapability` to return `kitty-animation`. In the same
capture, Familiar's hook process under Claude Code had **no controlling
terminal** — `tty` was `??` at both the hook and its `sh` parent — while the
resolved `claude` process held `ttys000`. Codex and OpenCode hooks did inherit
the TTY, so a design that read the terminal from the hook would have worked for
two agents out of three and silently failed the third. The Ghostty half of the
environment result is still unmeasured.

Codex uses native pets rather than Familiar-rendered sprites. OpenCode's sprite
renderer executes inside OpenCode with its own environment, but remains
provisional until the renderer is loaded and exercised on a physical Mac.

## 5. Theme traversal

Linux retains handle-bound traversal through `/proc/self/fd/N`. It does not move
to `/dev/fd`.

Darwin uses an explicit pathname walker because Node has no `openat` and the
runner proved `/dev/fd/N/child` unusable. For every queued directory it:

1. Retains the expected pathname, device, and inode.
2. Opens the pathname with `O_DIRECTORY | O_NOFOLLOW` and requires `fstat` to
   match the queued device and inode.
3. Enumerates the pathname, rejecting `.git`, symlinks, and non-file/non-directory
   entries as today.
4. Opens every regular file with `O_NOFOLLOW | O_NONBLOCK` and requires `fstat`
   to match the immediately preceding `lstat` before copying.
5. Rechecks the parent pathname's device and inode before and after enumeration
   and fails with `THEME_ENTRY_CHANGED` on any mismatch.

The staging growth scanner uses the same platform walker. Abort, wall-clock,
growth, device/inode, special-file, and destination-containment checks remain.
Platform selection is explicit; Darwin does not attempt `/dev/fd` and then fall
back silently.

This is weaker than Linux. A hostile writer can swap a directory away and back
between pathname checks, and Node cannot close that race without `openat` or a
native helper. Local `theme add` processes a caller-supplied path without
elevation; it is not a security boundary against a writer with equivalent
filesystem access. Darwin may copy a raced readable regular file into private
staging, but still cannot follow symlinks, materialize special files, or write
outside Familiar's controlled destination. The design accepts that documented
ceiling instead of dropping local themes or adding native code.

## 6. Test-runner portability

The test runner replaces its Linux abstract socket on Darwin with the existing
process-identified file lock under the system temporary directory, scoped by
user id and held for the suite lifetime. It uses `staleMs: Infinity` and the
existing default acquisition budget: 600 attempts at 20 ms. That budget exceeds
the five-second reclaim-guard lifetime, so a crashed reclaimer's guard can be
removed before acquisition is refused. A live second suite is refused only
after that bounded wait with an error saying the lease could not be acquired,
not claiming that a live suite was definitely found.

The strict version-2 owner record keeps its existing `pidNamespace` key and
shape. Linux supplies its current namespace link; Darwin supplies one fixed
host-scope value. Because neither the schema nor its meaning as a cleanup scope
changes, no version bump or migration layer is introduced.

The suite worker uses the second fresh-read exception defined in §3 immediately
after spawn; its owner record cannot be minted from the earlier snapshot.

## 7. Public setup interface

The implemented non-mutating setup command is:

```text
familiar setup claude-code
```

Apart from the CLI's universal `--help`, each leaf command accepts no positional
arguments or flags. It writes one valid JSON document to stdout followed by a
newline. Diagnostics go to stderr and failure is nonzero.

- `setup claude-code` returns the settings fragment containing Familiar's
  lifecycle hooks and `statusLine` command.

Generated Codex setup is unimplemented but no longer gated: the §2 capture
measured Codex executing its single-string hook command through `/bin/zsh -c`.
The committed Codex hooks fixture remains the review source until `setup codex`
lands.

Command values use the realpath of `bin/familiar` in the running package. Under
`npm link`, that is the checkout target rather than the npm-prefix symlink.
Claude Code's path is POSIX-shell-quoted for its `sh -c` boundary before the
document is JSON-encoded, so spaces, single quotes, and JSON-significant
characters remain literal. The §2 capture observed that boundary directly and
confirmed the emitted quoting survives it. Codex uses the same encoding: its
boundary is `/bin/zsh -c`, and the single-quote form is correct under both
shells. Nothing here applies to OpenCode, which spawns Familiar with no shell at
all — a future `setup opencode` emitting a quoted command string would be broken
by that path, not merely redundant. The commands never inspect or
write `~/.claude` or `~/.codex`. Users review and merge the output.

The existing mutating commands remain distinct:

- `familiar install pets [--sync-projects]` generates Codex pets and optionally
  managed project pet selections.
- `familiar install opencode` merges the two OpenCode plugin registrations.

## 8. Installation and documentation

The documented checkout installation is:

```sh
git clone <engine-url>
cd familiar
npm install
npm link
familiar scheme set dark
familiar theme add <theme-url-or-directory>
```

`package.json` adds `engines.node: ">=22"`; this is a new declared floor, not a
restatement of existing metadata.

`docs/install.md` is rewritten into shared setup, macOS, and Linux sections. Its
hand-written Claude Code JSON is replaced by `familiar setup claude-code` output.
Codex retains its committed fixture until §2 authorizes a setup command. The
macOS path covers:

1. Checkout installation, scheme, and theme.
2. `setup claude-code` output merged into `~/.claude/settings.json`.
3. `install pets`, project syncing, and a warning that the committed Codex hooks
   fixture is review-only: do not copy, merge, or install it until executor
   evidence resolves its literal path and command encoding.
4. `install opencode`, whose global directory remains `~/.config/opencode` on
   both platforms.
5. An optional user LaunchAgent invoking `familiar reap` every minute.
6. The provisional Kitty/Ghostty smoke checklist.

The Linux section retains Niri, Noctalia, and systemd instructions. User-facing
docs must not imply those integrations exist on macOS.

## 9. CI and tests

The existing Linux matrix remains Node 22 and 26. Add one `macos-14` / Node 22
job that runs `npm ci`, the complete fast suite through `npm test`, and an
installed-command smoke test through `npm link` and `familiar --help`.

The macOS suite includes:

- Fixture tests for Darwin `ps` parsing, `comm` paths containing spaces,
  basename normalization, malformed rows, no-TTY rows, both accepted TTY forms,
  and unsafe TTY values.
- Real-runner checks for a readable process snapshot and stable start-time
  equality, plus fixture checks that mismatched and missing identities fail
  closed.
- A counting test proving one full `ps` spawn serves ancestor walking,
  start-time lookup, and N-record pruning within one invocation.
- Injected terminal-target and environment tests proving the exact
  `/dev/<tty>` open, separate environment source, and graphics-only degradation
  without writing to the runner's terminal.
- Existing adversarial theme-acquisition and growth-scan cases through the
  Darwin pathname walker, including file identity mismatch and parent swap.
- Test-runner exclusion, crashed-guard recovery, dead-holder cleanup, and
  scratch-root cleanup.
- Exact setup-command JSON, `--help`, rejected extra arguments, and a package
  realpath containing spaces.

Fixture tests inject Darwin inputs and run on every platform. Tests that require
the real Darwin process table or filesystem register normally with Node's test
runner and use `{ skip: process.platform !== 'darwin' ? 'requires Darwin' : false }`;
they are never hidden behind a conditional registration. Linux therefore reports
each named skip, while the macOS job discovers the same test IDs and executes
them rather than treating an empty platform group as coverage.

`npm ci` selects `@opentui/core-darwin-arm64`, but no current test loads
`integrations/opencode/sprite-plugin.tsx`. The macOS job therefore backs the
OpenCode hook and installer only. The renderer remains provisional rather than
turning dependency installation into a renderer-support claim.

The job cannot establish a graphical login session, run an authenticated agent
TUI, or prove terminal-device permissions. Green CI is necessary but not a
substitute for the two physical-Mac gates in §§2 and 11.

## 10. Error contract

- `ps` absence, nonzero exit, malformed output, unknown agent ancestry, missing
  start time, or unsafe TTY data is a named error. None becomes an invented
  process record.
- A missing graphics marker means capability `none`; tint and bell can continue.
- Failure to open or validate the selected TTY writes no bytes.
- Hook failures retain the existing cosmetic boundary: one sanitized diagnostic
  and exit zero, so Familiar cannot break an agent turn. Resolver failure must
  reach that diagnostic rather than being swallowed without output.
- User-invoked setup, install, theme, and validation failures remain nonzero.
- A Darwin source identity change aborts acquisition; there is no silent retry
  through a weaker traversal mode.

## 11. Manual promotion gates

The live-hook ancestor capture in §2 was completed on 2026-08-23 and is the
prerequisite for Darwin adapter activation. With implementation CI green, the
remaining physical-Mac smoke pass runs Claude Code, Codex, and OpenCode in
current Kitty and Ghostty releases. For each
applicable pair it checks launch/idle, working, approval, done/error where
exposed, session exit, and `familiar reap` after abnormal termination.

The pass records agent and terminal versions, resolved ancestor basename, raw
and canonical TTY, inherited graphics markers, and concise failures. Two gaps
the §2 capture left open belong to this pass: the Ghostty environment markers,
whose classifier tests values rather than presence, and a background or
daemon-hosted Claude Code session, the case the `tty !== null` predicate exists
for. It also
loads the OpenCode sprite plugin, so the optional native renderer dependency is
exercised rather than merely installed.

Failures keep the affected adapter or renderer provisional. The live-rendering
label is removed only when the smoke evidence exists.

## 12. Alternatives rejected

**State-only Darwin support.** Smaller, but Claude Code would lose Familiar's
terminal surface. The selected platform seam supports it with an explicit
environment limitation.

**Per-terminal companion daemon.** It would own the TTY and environment cleanly,
but adds lifecycle, IPC, installation, and failure modes before native Darwin
primitives have been exercised.

**Drop local-directory themes on Darwin.** Stronger than the selected pathname
walker but breaks the documented route for private repositories. The explicit
local-source race ceiling is the smaller product cost.

**Native `openat` or `KERN_PROCARGS2` helper.** It could close the two Darwin
gaps, but adds native distribution solely for guarantees outside this milestone.
Reconsider only if the documented ceilings produce real failures.

**Homebrew in this milestone.** Distribution machinery does not prove runtime
compatibility. Add it after physical-Mac smoke testing establishes a package
worth distributing.

**Native macOS application directories.** The current paths already align with
OpenCode and preserve one configuration contract across Linux and macOS.

## 13. Current upstream evidence

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

## 14. Decisions

| Decision | Choice |
| --- | --- |
| First support claim | portable core CI-backed; Darwin agent lifecycle authorized by the 2026-08-23 live-hook evidence |
| Live terminal claim | provisional until physical-Mac smoke |
| macOS floor | macOS 14+, Apple Silicon, Node 22 |
| Installation | checkout + `npm install` + `npm link` |
| Familiar paths | existing `~/.config` and `~/.local/state` paths |
| Agent configuration | generated Claude Code JSON; committed Codex fixture pending executor evidence; never auto-merge either |
| Process source | Linux `/proc`; one memoized Darwin `/bin/ps` snapshot on the normal path, plus the two §3 targeted-read exceptions |
| Linux `tty` | presence marker only; never a path component |
| Darwin TTY | strict normalization to `ttys<hex>` and `/dev/<tty>` |
| Darwin environment | inherited hook environment; graphics-only degradation |
| Darwin start time | `lstart`, one-second identity granularity |
| Theme traversal | Linux handle-bound; Darwin verified pathname walker |
| Test lease | existing file lock; default retry budget clears stale guards |
| OpenCode renderer | provisional; CI backs hook and installer only |
| macOS CI | one `macos-14` / Node 22 full-suite and install-smoke job |
| Deferred | native helpers, Homebrew, Intel/macOS 13 claims, other terminals, Niri/Noctalia ports |
