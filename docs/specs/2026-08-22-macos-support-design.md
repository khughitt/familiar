# macOS Core Support — Design

**Status:** proposed; revised after macOS CI spike, awaiting approval
**Date:** 2026-08-22

Familiar currently develops and tests against Linux. This milestone makes its
portable core a CI-backed macOS product without pretending GitHub Actions can
prove behavior inside a real Kitty or Ghostty window.

The target support claim is deliberately split:

- **Supported after CI and the process spike gates pass:** macOS 14+ on Apple
  Silicon, Node 22, checkout installation, Familiar configuration and themes,
  the CLI, Claude Code lifecycle and status-line configuration, Codex hooks and
  native pets, and the OpenCode hook and installer.
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

One pre-resolver spike remains. On a physical Mac, a live hook from each current
Claude Code, Codex, and OpenCode release must capture its full ancestor chain
with both commands below, along with the agent version:

```sh
LC_ALL=C /bin/ps -axo pid=,ppid=,tty=,lstart=,comm=
LC_ALL=C /bin/ps -axo pid=,ppid=,tty=,lstart=,command=
```

Both free-form fields stay last. The capture must cover a real interactive
session, not an unauthenticated launch. Darwin resolver names are taken only
from that evidence. If a terminal-owning ancestor basenames to `node`, a shim,
or another name, the implementation must specify and test the smallest exact
rule that distinguishes that process; it must not silently reuse Linux's names.

Darwin parser, setup, CI, theme, and test-runner work may proceed independently.
Darwin adapter activation and the Supported claim remain gated on the live-hook
capture. A resolver miss is a named diagnostic at the hook's cosmetic boundary,
not a silent no-op.

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

Lock contention is the narrow exception: reclaiming another process's lock must
not trust a snapshot taken before that holder started. A contended lock performs
one fresh, targeted identity read per observed lock token, memoized for that
token. An unreadable identity is treated as live/unreclaimable at this boundary,
so Familiar may defer cleanup but cannot steal a live lock.

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

## 7. Public setup interface

Add one non-mutating command family:

```text
familiar setup claude-code
familiar setup codex
```

Apart from the CLI's universal `--help`, each leaf command accepts no positional
arguments or flags. It writes one valid JSON document to stdout followed by a
newline. Diagnostics go to stderr and failure is nonzero.

- `setup claude-code` returns the settings fragment containing Familiar's
  lifecycle hooks and `statusLine` command.
- `setup codex` returns the complete Familiar hooks document.

Command values use the realpath of `bin/familiar` in the running package. Under
`npm link`, that is the checkout target rather than the npm-prefix symlink. JSON
encoding handles spaces and JSON-significant characters; the commands never
inspect or write `~/.claude` or `~/.codex`. Users review and merge the output.

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
current hand-written Claude Code and Codex JSON is replaced by the corresponding
`familiar setup` output so generated and documented commands cannot drift. The
macOS path covers:

1. Checkout installation, scheme, and theme.
2. `setup claude-code` output merged into `~/.claude/settings.json`.
3. `install pets`, project syncing, and `setup codex` output for
   `$CODEX_HOME/hooks.json`.
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

The live-hook ancestor capture in §2 occurs before Darwin adapter activation.
After implementation CI is green, a physical-Mac smoke pass runs Claude Code,
Codex, and OpenCode in current Kitty and Ghostty releases. For each applicable
pair it checks launch/idle, working, approval, done/error where exposed, session
exit, and `familiar reap` after abnormal termination.

The pass records agent and terminal versions, resolved ancestor basename, raw
and canonical TTY, inherited graphics markers, and concise failures. It also
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
| First support claim | CI-backed core after live-hook ancestry evidence |
| Live terminal claim | provisional until physical-Mac smoke |
| macOS floor | macOS 14+, Apple Silicon, Node 22 |
| Installation | checkout + `npm install` + `npm link` |
| Familiar paths | existing `~/.config` and `~/.local/state` paths |
| Agent configuration | generated JSON only; never auto-merge Claude/Codex files |
| Process source | Linux `/proc`; one memoized Darwin `/bin/ps` snapshot per invocation |
| Linux `tty` | presence marker only; never a path component |
| Darwin TTY | strict normalization to `ttys<hex>` and `/dev/<tty>` |
| Darwin environment | inherited hook environment; graphics-only degradation |
| Darwin start time | `lstart`, one-second identity granularity |
| Theme traversal | Linux handle-bound; Darwin verified pathname walker |
| Test lease | existing file lock; default retry budget clears stale guards |
| OpenCode renderer | provisional; CI backs hook and installer only |
| macOS CI | one `macos-14` / Node 22 full-suite and install-smoke job |
| Deferred | native helpers, Homebrew, Intel/macOS 13 claims, other terminals, Niri/Noctalia ports |
