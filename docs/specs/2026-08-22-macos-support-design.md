# macOS Core Support — Design

**Status:** portable core implemented and CI-backed; live-hook ancestry and
executor gate closed 2026-08-23, the Darwin adapters activated and `setup codex`
implemented on that evidence; the §11 terminal gate executed 2026-08-24 to
2026-08-28 (`docs/ref/2026-08-24-macos-terminal-smoke.md`), promoting Claude Code
and Codex rendering in Kitty and Ghostty and leaving the OpenCode sprite renderer
provisional on two recorded failures
**Date:** 2026-08-22

Familiar's portable core now runs in Linux and macOS CI without pretending
GitHub Actions can prove behavior inside a real Kitty or Ghostty window.

The target support claim is deliberately split:

- **Supported:** macOS 14+ on Apple Silicon, Node 22, checkout installation,
  Familiar configuration and themes, the CLI, Claude Code lifecycle and
  status-line configuration, generated Codex hooks and native pets, and the
  OpenCode hook and installer. Both gates this claim waited on have passed — CI is green, and
  the live-hook capture in §2 confirmed the resolver predicate — and the Darwin
  adapters are active on that evidence.
- **Confirmed by physical-Mac smoke testing (2026-08-24):** Familiar-rendered
  graphics, tint, and bell delivery for Claude Code and Codex in Kitty 0.46.2 and
  Ghostty 1.3.1.
- **Provisional:** OpenCode's TUI sprite renderer, which failed that gate.
- **Expected, not claimed:** Intel Macs and macOS 13.

Linux behavior and its Node 22/26 CI remain supported unchanged.

**Remaining work**, in the order it unblocks things:

1. **Verifying the two OpenCode fixes on hardware.** The §11 gate ran on 2026-08-24
   and promoted Claude Code and Codex; `familiar setup codex` was exercised live for
   the first time and fired all six configured events. The OpenCode renderer failed on
   two findings, and **both have since been root-caused and fixed**: the frozen pose
   was a watch callback filtered on a filename Darwin never reports
   (`f1d2be0`, confirmed by macOS CI), and the unreachable
   `needs-approval` was an ask bound to nothing on the stable event stream
   (`6605327`, diagnosed from the SDK types). Neither fix has been
   exercised against a live OpenCode, so the renderer keeps its provisional label until
   its two cells are re-run. That re-run is the only thing standing between OpenCode and
   the same claim Claude Code and Codex now hold.
2. **The `tty !== null` predicate in a live launchd context.** §11.4's probes ran
   and carried most of the way. Probe 1 observed the case directly on a Mac for the
   first time: seven background and daemon-hosted `claude` processes — pty hosts,
   spares, the app bundle, a detached CLI — every one of them owning no controlling
   terminal, against two foreground sessions that did. The predicate's premise holds
   on Darwin. The fail-closed contract is closed too, by a replacement probe that ran
   `familiar hook` under launchd with no controlling terminal: the diagnostic reached
   stderr, the hook exited 0, and no bytes were written. What remains open is narrow:
   that chain contained no `claude` process at all, so the resolver failed on the
   `comm` half. Exercising the `tty !== null` half in situ needs a launchd-hosted
   `claude` that fires a level-bearing hook, and `claude -p` does not — `SessionEnd`
   carries `level === null` and skips the resolver entirely.

   **Parked, not scheduled.** This needs a physical Mac and no further Mac-hosted
   experiments are planned. The runbook, its corrections, the offline checker and the
   tester's scripts are on `main` so that someone with the hardware can pick it up; §11.7
   describes the shape of the run.

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
independently and are complete. The live-hook gate is closed. Darwin adapter
activation followed it on the same day, and `familiar setup codex` was
implemented on the same evidence, replacing the review-only hooks fixture. A
resolver miss is a named diagnostic at the hook's cosmetic boundary, not a
silent no-op.

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

Row failure is scoped to one PID, not to the snapshot. `-axo` returns every
process on the machine, including other users', so mapping a strict parser
across the whole table would make Familiar's correctness depend on several
hundred unrelated rows: a single `tty console` row — a real BSD tty name — threw
out of snapshot construction and disabled every hook on the machine behind a
cosmetic exit-zero diagnostic. Each row is therefore parsed independently. A row
that fails is remembered against its PID, so a lookup for that process raises
the named error rather than reporting it missing; a parseable row always wins
over an unparseable one for the same PID; and a row too damaged to name a PID
answers no question and is dropped. This is a scoping rule, not a fallback:
nothing is guessed, and the process actually being asked about still fails
closed.

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
two agents out of three and silently failed the third.

A second capture on the same day in Ghostty 1.3.1 closed the other half: all 12
records carried `TERM=xterm-ghostty`, `TERM_PROGRAM=ghostty`, and both
`GHOSTTY_*` markers into the hook, classifying as `static-graphics`. The hook
environment is therefore a sound capability source on Darwin for both supported
terminals. tmux remains unmeasured and unclaimed.

Codex uses native pets rather than Familiar-rendered sprites. OpenCode's sprite
renderer executes inside OpenCode with its own environment. The §11 gate loaded and
exercised it on a physical Mac and it **failed**: the sprite transmits three images
per session and then re-places them thousands of times without ever changing pose,
on both terminals and both graphics capabilities. Root cause found and confirmed by
macOS CI — the runtime filtered its watch callback on a filename Darwin never
reports — and fixed on `f1d2be0`. The renderer stays provisional
until its cells are re-run, since a second failure, an unreachable `needs-approval`,
is untouched by that fix.

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

The implemented non-mutating setup commands are:

```text
familiar setup claude-code
familiar setup codex
```

Apart from the CLI's universal `--help`, each leaf command accepts no positional
arguments or flags. It writes one valid JSON document to stdout followed by a
newline. Diagnostics go to stderr and failure is nonzero.

- `setup claude-code` returns the settings fragment containing Familiar's
  lifecycle hooks and `statusLine` command.
- `setup codex` returns the hooks fragment for `~/.codex/hooks.json`, carrying
  the six events the Codex adapter maps and no `statusLine`: Codex draws its own
  pet and exposes no cells to print into.

Both documents come from one generator, so the events Codex is configured for
cannot drift from the events its adapter maps. The committed
`integrations/codex/hooks.json` fixture is deleted; its literal path placeholder
is exactly what generation removes.

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
hand-written Claude Code JSON and its copied Codex fixture are replaced by
`familiar setup claude-code` and `familiar setup codex` output. The macOS path
covers:

1. Checkout installation, scheme, and theme.
2. `setup claude-code` output merged into `~/.claude/settings.json`.
3. `setup codex` output merged into `~/.codex/hooks.json`, plus `install pets`
   and project syncing for the pet art Codex draws itself.
4. `install opencode`, whose global directory remains `~/.config/opencode` on
   both platforms.
5. An optional user LaunchAgent invoking `familiar reap` every minute.
6. The Kitty/Ghostty checklist, now scoped to the combinations the §11 gate did
   not cover.

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

- `ps` absence, nonzero exit, wholly malformed output, unknown agent ancestry,
  missing start time, or unsafe TTY data is a named error. None becomes an
  invented process record.
- An unparseable row inside an otherwise readable snapshot is a named error for
  that PID alone (§3). Unrelated rows cannot disable the hook path.
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
prerequisite for Darwin adapter activation. The physical terminal gate — Claude
Code, Codex, and OpenCode exercised in current Kitty and Ghostty releases on a
real Mac — **was executed 2026-08-24 to 2026-08-28**. This section specifies that
pass; `docs/ref/2026-08-24-macos-terminal-smoke.md` records what it found. The
runbook implementing it lived on the disposable capture branch, as §2's did.

Outcome: Claude Code and Codex passed every cell, the capability `none` control
passed, all six reap sets proved removal by identity, and probe 1 confirmed on
hardware that background and daemon-hosted `claude` processes own no controlling
terminal — the premise the `tty !== null` predicate rests on. OpenCode failed both
cells. Two Familiar installer defects surfaced that are outside this gate's scope;
§11.8 records them.

### 11.1 Evidence standard

§2's checks produced text a reviewer could verify without being present. §11's
do not. A sprite drawn, a window tinted, a bell rung are things a person sees,
and a gate resting on "the tester said it looked right" would promote a subtly
wrong byte stream that still looked plausible. Every claim is therefore split
into a machine-checked half and a half only the tester can answer, and a cell
passes only if both hold.

The machine-checked half comes from an opt-in tee at `writeAllSync`
(`src/render/term/io.js`). That is the one choke point every terminal write
already passes through: the hook's `emit()`, which opens `/dev/ttys<hex>` on
Darwin and writes with an explicit fd, and the OpenCode sprite plugin, which
calls the same function with the default `fd = 1` inside OpenCode's own
process. One tee therefore covers both the hook path and the renderer that has
never been loaded, without editing either call site. Because `writeAllSync`
receives an fd and not a path, `emit()` records the resolved `terminal.path`
and the probe correlates the two.

Records are one JSON line per write: timestamp, pid, agent, event, target path,
the `rdev` of the written fd, and each escape decomposed into introducer, control
keys, payload length, and payload SHA-256. The device is identified by `rdev`
rather than by name because Node exposes no `ttyname`; comparing
`fstat(fd).rdev` against `stat(/dev/<tty>).rdev` is also the stronger check, being
device identity rather than a string that matched.

That internal comparison is necessary and not sufficient. It proves the emitter
wrote to the device it opened, which a resolver that picked the *wrong* terminal
also satisfies — it would open that terminal and write to it consistently. So the
run captures its window's device independently, before any agent starts, and every
write is checked against that value too. This is what moves "the bytes land in this
window" from the tester's column into the machine-checked one; the tester's
observation becomes corroboration rather than the only evidence. Tint, cursor, reset, and bell bytes
are short and constant and are recorded verbatim. Graphics payloads are recorded
as length and digest only, because they are bulk; the digest and the control keys
are what verification needs, never the pixels.

The escape vocabulary is closed and small. From the hook's emitter it is exactly
what `osc.js` exports — `OSC 11`, `OSC 12`, `OSC 111`, `OSC 112`, and `BEL` —
alongside the Kitty graphics `APC`. Anything else in a hook write fails the cell.
In particular Familiar takes no ownership of the terminal title, which two
emitter tests assert directly, so a title escape appearing in a capture is a
defect rather than a tolerated extra.

The OpenCode sprite renderer adds one further form, and only there. `placeAt` in
`integrations/opencode/sprite.js` wraps its placement `APC` in `ESC 7`, one
absolute `CSI <row>;<col> H`, and `ESC 8`, so the visible cursor returns to where
OpenTUI left it between frames. That envelope is admitted for that writer alone,
and its *order* is checked, not merely its balance: a save, exactly one move, the
placement, then the restore. The same escapes appearing in a hook write are a
defect — the hook emitter never moves the cursor — and a reversed or unclosed
envelope leaves the cursor where the sprite put it, which is a visible bug that
counting saves and restores would not catch.

| Claim | Machine-checked from the byte log | Tester only |
| --- | --- | --- |
| Sprite transmitted | APC `_G` keys well formed; every chunk that names an image names `imageIdFor(sessionId)` and at least one does; the transmit chunk's `c=`/`r=` equal the `boxFor` placement box; the chunk count matches the encoder's own | a sprite is on screen, positioned correctly, covering no dialog |
| Tint applied | `OSC 11` and `OSC 12` carry the active theme's backdrop and base colours | the window colour actually changes |
| Bell rung | `BEL` present for exactly the ringing states that cell exposes, and absent otherwise | the bell is perceptible |
| Correct terminal | `fstat(fd).rdev` equals `stat(target).rdev`, **and** every write's device equals the window device captured independently before the run | corroboration only: the sprite appears in this window |
| Graphics correctly suppressed | at capability `none`, zero APC `_G` bytes, while the `OSC 11`/`OSC 12` and any bell bytes still reach the validated TTY | the window still tints and rings with no sprite |

The tester's column is irreducible. The point of the first column is that a
passing tester note over a malformed byte log is a failure.

Two boundaries on that first column, stated here rather than discovered during a
run. **Frame-by-frame sequence is not machine-checked.** The placement box comes
from `boxFor` and the frame count from `planAnimation`, so both are recorded and
the box is verified; but validating the frame *sequence* would mean
reimplementing `encodeKittyProgram`'s chunking rules inside the checker, and a
second copy of the encoder is not an independent check of the first. Instead the
checker is proved against real encoder output by a golden test, and the
independent properties — image identity across every chunk, key grammar, and the
placement box — are what carry the claim. **OpenCode's graphics are checked more
shallowly than the hook's**, because its renderer plans and encodes inside
`sprite-runtime.js` and its records therefore carry no planned frame count or
placement; image identity, key grammar, and envelope order are what apply there.
The evidence note records both boundaries.

### 11.2 The matrix is not uniform

The three adapters expose different states and send different bytes, so a row
of `pass` does not mean the same thing across the table:

| Agent | States exposed | Bytes Familiar sends | Sprite drawn by |
| --- | --- | --- | --- |
| Claude Code | six: `idle`, `working`, `needs-input`, `needs-approval`, `done`, `error` | graphics, tint, bell | Familiar: the hook transmits, `familiar statusline` prints the placeholder cells |
| Codex | four: `idle`, `working`, `needs-approval`, `done` | tint, bell | Codex natively, from `install pets` |
| OpenCode | five: adds `error`, omits `needs-input` | tint, bell | `integrations/opencode/sprite-plugin.tsx`, inside OpenCode's process |

Codex maps six events onto four states: it has neither a failure event nor an
idle-prompt notification. OpenCode's `needs-input` would require question events
that are not on the stable server stream. These exclusions are structural, so
the evidence note records them inline beside the cell rather than leaving three
full `pass` rows to be read as six states everywhere. The bell rule narrows with
them: Claude Code can ring on all three ringing states, OpenCode on
`needs-approval` and `error`, and Codex on `needs-approval` alone.

Two behaviours the runbook states in advance so they are not recorded as
failures. Codex's `SessionStart` fires at the first turn, not at window open, so
an opened but unspoken-to Codex window showing nothing is correct. OpenCode's
hook path observes no tool events at all — §7 of
`docs/ref/2026-08-23-macos-agent-process-spike.md` — so `working` comes from
`session.busy` and `done` only from the `reduceState` idle-after-active path.

Claude Code is the only cell that exercises the hook and status-line
rendezvous: two processes, with no channel between them, agreeing on
`imageIdFor(sessionId)`. It is the mechanism most likely to break inside a real
TUI, so it is checked explicitly rather than folded into "sprite: yes".

Two per-cell checks are deliberately not states, and enumerating states alone
would skip both.

**Session exit.** `SessionEnd` and `dispose` map to `null`, not to a state, and
`renderTransition` returns `oscReset()` on exactly that null transition. The
colour restore therefore has one and only one trigger. Each cell ends with a
normal session exit and requires `OSC 111` and `OSC 112` in the byte log; a
matrix that promoted six correct states while leaving a terminal permanently
tinted would be worse than no promotion.

**Abnormal termination and `familiar reap`.** A force-terminated session emits
no event at all, so nothing restores the colours and nothing removes the bus
record. This check has no byte component, and observing an absent record after
`reap` would not establish anything: `pruneDead` also runs inside the ordinary
hook commit path (`src/bus/transaction.js`), so any hook fired by any agent
anywhere on the machine removes dead records as a side effect. Absence is
therefore consistent with `reap` having done nothing at all.

The check is a four-step sequence, and each step exists to close that hole:

1. `SIGKILL` the agent, never a graceful quit, which would emit `SessionEnd`
   and take the normal cleanup path instead.
2. Before anything else runs, read the bus and require the killed session's
   record to still be **present**. This is the step that gives the later
   absence meaning, and it is why no other agent session may be running on the
   machine during the check.
3. Run `familiar reap` and require its stdout to name that session:
   `reaped <id>`. `reap` prints nothing when it removes nothing, so this line
   is the positive evidence that `reap` itself did the removal.
4. Read the bus again and require the record to be gone.

That the terminal stays tinted throughout is expected and is recorded as such —
the tinting is cleared by the next session's transitions, not by reaping — so
the tester does not log it as a failure.

### 11.3 The capability `none` negative control

Every cell in the matrix runs in Kitty or Ghostty and therefore classifies as
graphics-capable, so the suppression rule in §11.1 would be defined and never
executed. One negative control run closes that, in a real terminal rather than
a fixture.

Launch the agent from a shell with every marker the classifier reads cleared —
`GRAPHICS_MARKERS` in `src/render/term/capability.js` is exported so that
scrubbing clears exactly the source of truth `graphicsCapability` consumes —
and with `TERM` set to a non-graphics value such as `xterm-256color`. The TUI
keeps working, the resolved TTY is still a genuine terminal device, and the
inherited hook environment classifies as `none`. Darwin reads the graphics
environment from the hook's inherited environment (§4), so scrubbing at agent
launch is what reaches the classifier.

The control covers Claude Code and OpenCode, because those are the only two
transmitters and their suppression sites differ: the hook's `emit()` skips the
graphics block, while `sprite-plugin.tsx` returns before registering anything
with the renderer. Codex is excluded because it transmits no graphics for a
`none` classification to suppress.

Required in one run, in Kitty: zero APC `_G` bytes in the byte log; `OSC 11`
and `OSC 12` still present; a bell still present on a ringing state; and the
tester confirming the window tints and rings with no sprite drawn. A control
that produces graphics bytes is a failure of the same severity as a missing
sprite in a normal cell — it means Familiar transmits into terminals that
cannot decode it.

The pass is also the first live exercise of `familiar setup codex` (§7). The §2
capture used a hand-written command string with a deliberate canary; the
generated document has never configured a real agent. The runbook generates it,
merges it into `~/.codex/hooks.json`, and all six mapped events firing is what
verifies that the generator and the adapter agree.

### 11.4 The background and daemon appendix

The gap §2 carried forward is a background or daemon-hosted Claude Code
session, the case the `tty !== null` half of the predicate exists for. Two
probes close it, run once, under Kitty; the predicate is terminal-independent.

**Probe 1 — induce the real case.** Inside an interactive session, drive
Claude Code into a background subtree and capture the chain from a hook firing
under it. Darwin raises the stakes relative to Linux: there, the pty host
reports `comm` as the version string and never matches, whereas Darwin `comm`
is an executable path whose basename may well be `claude`. A process whose
purpose is hosting pseudo-terminals is a plausible owner of one. Three
outcomes, all recorded: the intermediate process appears with a null TTY and is
correctly skipped, closing the gap; it appears owning a TTY, which is a
resolver defect that halts the gate and reopens this design; or the case cannot
be induced on the installed version, in which case the predicate's second half
remains Linux-evidenced. The third outcome does not block the rendering
promotion — resolver discrimination and terminal rendering are independent
claims.

**Probe 2 — the fail-closed contract.** A headless `claude -p` under `launchd`
with stdio fully detached, hooks configured, and no controlling terminal
anywhere in the chain. Expected: the named `could not find the claude-code
process` diagnostic, exit zero, and zero writes in the byte log. This is the
only Darwin exercise of §10's rule that resolver failure reaches the cosmetic
diagnostic rather than being swallowed.

### 11.5 Configuration exercised

The full matrix runs under Node 22, matching both `engines.node` and the
version CI tests, so promoted claims and the supported configuration agree. One
cell — Claude Code in Kitty — is then repeated under the Mac's installed Node
to confirm nothing is version-specific.

The macOS half of §2's configuration gap stays open. CI runs macOS 14 with no
live agents; the physical Mac is macOS 26. No promotion may state or imply that
macOS 14 has run a live agent, because it has not.

### 11.6 Promotion rule

A cell passes when three things hold: every state that adapter structurally
exposes was exercised, with its byte log verified and its tester observation
recorded; the normal session exit produced `OSC 111` and `OSC 112`; and an
abnormally terminated session was proven removed by `familiar reap` through the
four-step sequence in §11.2. All three are required, because the first alone can
be satisfied while cleanup is entirely untested.

The pass as a whole additionally requires the §11.3 capability `none` negative
control. It is not a cell and does not belong to any terminal row, but no
promotion may proceed without it: without it the graphics-suppression rule is
asserted and never tested. A failing cell keeps **that adapter or
renderer** provisional and does not hold back the ones that passed: promotion is
per-adapter, and the evidence note records the failures alongside the promotions
rather than being committed alone. What a failing cell never does is narrow into a
caveat on a promoted claim — the adapter it belongs to stays provisional outright
until its cells are re-run and pass.

A complete pass promotes only what was exercised: physical Kitty and Ghostty
rendering on the tested macOS and Node versions, named. It removes the
corresponding provisional warnings from `docs/install.md` and nothing else.
tmux, Intel, macOS 13, other terminals, and macOS 14 live-agent behaviour remain
unclaimed.

A probe 1 result showing an intermediate `claude` owning a TTY overrides all of
the above: it is a wrong-target defect, and no rendering evidence promotes
anything while it stands.

### 11.7 Execution shape

One runbook, parameterized by terminal, run twice — Kitty, then Ghostty — with
the §11.4 appendix run once. Setup, configuration backup, and restore are
written once, and the second run re-tests the script. That matters: the
2026-08-23 Ghostty run caught a `ghostty --version` file-description seek that
had silently overwritten five lines of already-written evidence, with exit
status 0 throughout.

The capture branch is disposable and never merged. It is pushed to `origin`
only as transport to the test machine, exactly as `spike/macos-agent-handoff`
was, and deleted from the remote once artifacts are received; a `git bundle`
is the offline alternative. The tester pushes nothing back — no branch, no
capture, no amended commit. Only the reviewed, redacted evidence note
`docs/ref/2026-08-24-macos-terminal-smoke.md` reaches `main`, together with any
promotion it earns.

Four guards carry forward from that run's recorded deviations, as rules rather
than notes:

1. The suite-green stop condition names the known status-line
   `BRANCH_TIMEOUT_MS` failure in advance, so a real regression is
   distinguishable from the known one.
2. No shell loop variable is named `path`; zsh ties it to `PATH`, and last time
   the loop wiped `PATH` mid-script after printing a success line.
3. Every version is captured through a command substitution, never inside a
   redirected block.
4. The hook command carries a run-scoped environment gate, so a second agent
   session picking up the temporary hook from shared configuration cannot write
   uncorrelated records.

### 11.8 Findings outside the gate's scope

The run surfaced two installer defects that are not terminal-rendering findings and
do not bear on any promotion above. Both are recorded here because the gate is where
they were found and reproduced, not because §11 owns their fix.

`familiar install pets` compiles every pet into `~/.codex/pets` but selects none, and
Codex draws nothing without a `[tui] pet` setting. For Codex the pet is the entire
state signal, since Familiar sends only tint and bell — so on a fresh machine the
documented install steps leave Codex rendering nothing at all. The documented remedy
is also a dead end there: `--sync-projects` iterates catalog identities holding a
`path` pin, and `identities.yaml` does not exist after a clean `theme add`, so it is a
no-op on exactly the machines that need it. The gate worked around it by hand-writing
the project-local config that sync would have produced. **Fixed** on
`d53b59f`: the current repository is now a sync target alongside the
pins, guarded so it can never reach the user-wide config.

`familiar install opencode` refuses whenever an `opencode.jsonc` exists — the correct
refusal, since rewriting a commented file as plain JSON would lose the comments — but
it exits before writing `tui.json`, so the refusal takes the sprite renderer's
registration down with it. Following §8's install steps literally on a machine with a
`.jsonc` config leaves the renderer uninstalled, and the OpenCode cells would then run
with no sprite and no indication why. The refusal should still write the half it can,
or name both files it did not write. **Fixed** on `bf088b8`: each config is now handled
independently, so a `.jsonc` hand-off for one no longer blocks the other.

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
| First support claim | portable core CI-backed; Darwin agent lifecycle and Codex setup authorized by the 2026-08-23 live-hook evidence |
| Live terminal claim | Claude Code and Codex promoted for Kitty 0.46.2 and Ghostty 1.3.1 on macOS 26.6.2, Node 22 and 25, by the 2026-08-24 gate; OpenCode renderer still provisional |
| macOS floor | macOS 14+, Apple Silicon, Node 22 |
| Installation | checkout + `npm install` + `npm link` |
| Familiar paths | existing `~/.config` and `~/.local/state` paths |
| Agent configuration | generated Claude Code and Codex JSON from one generator; never auto-merge either |
| Process source | Linux `/proc`; one memoized Darwin `/bin/ps` snapshot on the normal path, plus the two §3 targeted-read exceptions |
| Linux `tty` | presence marker only; never a path component |
| Darwin TTY | strict normalization to `ttys<hex>` and `/dev/<tty>` |
| Darwin environment | inherited hook environment; graphics-only degradation |
| Darwin start time | `lstart`, one-second identity granularity |
| Theme traversal | Linux handle-bound; Darwin verified pathname walker |
| Test lease | existing file lock; default retry budget clears stale guards |
| OpenCode renderer | provisional; CI backs hook and installer only, and the 2026-08-24 gate recorded a frozen pose and an unreachable `needs-approval` |
| Terminal gate evidence | byte-level tee at `writeAllSync` plus tester observation; a cell needs both |
| Gate cleanup coverage | per cell: `oscReset` on normal exit; stored pid+starttime verified, SIGKILL, record present, `reaped <id>` on stdout, record absent |
| Gate terminal identity | internal target/fd agreement plus every write checked against the run's independently captured window device |
| Gate negative control | one marker-scrubbed physical-terminal run over Claude Code and OpenCode; required for any promotion |
| Gate escape recording | tint, cursor, reset, and bell verbatim; graphics as length and digest; the OpenCode placement envelope order-checked for that writer alone; any other escape fails the cell |
| Gate graphics depth | image identity, key grammar, and placement box are machine-checked; frame sequence is not, and OpenCode carries no planned frame count |
| Background-session evidence | one induced-subtree probe and one headless fail-closed probe (§11.4) |
| Gate configuration | full matrix on Node 22, one cell repeated on the installed Node; the macOS 14 live-agent gap stays open |
| Gate execution | one runbook parameterized by terminal, run twice; disposable capture branch, redacted note only on `main` |
| macOS CI | one `macos-14` / Node 22 full-suite and install-smoke job |
| Deferred | native helpers, Homebrew, Intel/macOS 13 claims, other terminals, Niri/Noctalia ports |
