# macOS terminal promotion gate — evidence

**Status:** executed 2026-08-24 to 2026-08-28 on a physical Apple Silicon Mac. Every
artifact below was re-verified locally against the returned files; no result in this
note rests on the tester's transcription. Claude Code and Codex pass in both terminals.
**OpenCode fails and stays provisional**, on two independent findings — both since
root-caused and fixed, neither yet verified against a live OpenCode.

**Provenance**

- Capture branch: `spike/macos-terminal-gate` at `8e824ab`, disposable and never merged.
  Pushed to `origin` only as transport to the test machine and deleted from the remote
  afterwards; the tester pushed nothing back. Every returned trace records
  `familiar-commit=8e824ab7d0c3dad20b622dc50d907bd45d0be965`.
- Runbook: `docs/ref/2026-08-24-macos-terminal-gate-handoff.md`, with the corrections it
  needs in `docs/ref/2026-08-24-gate-runbook-amendments.md` and the tester's scripts in
  `tools/gate/`. The offline checker is `tools/gate-verify.mjs`. The byte-level tee those
  depend on stayed on the capture branch — it adds an inert branch to a production write
  path — so anyone re-running this restores or re-implements it first.
- Evidence per cell: one `<terminal>-<agent>.jsonl` trace plus seven reap artifacts.
  Returned inventory: 57 evidence files plus `notes.md`, matching §8 exactly
  (`probe2.jsonl` absent by design, `probe2-stderr.txt` empty — see §3). Raw artifacts are
  not committed; this note is the record.
- Host: Apple Silicon, arm64, macOS 26.6.2 (25G83).
- Node: matrix v22.23.2; spot-check v25.8.2. The machine has no separately installed
  system Node, so the spot-check used nvm's default rather than `nvm deactivate`, which
  would have left no `node` on `PATH` and broken every hook's shebang.
- Kitty 0.46.2, `/dev/ttys004`, `rdev` 268435460, capability `kitty-animation`.
  Ghostty 1.3.1, `/dev/ttys000`, `rdev` 268435456, capability `static-graphics`.
- Agents: Codex CLI 0.149.0, OpenCode 1.18.21, Claude Code 2.1.241 for the Kitty pass and
  2.1.248 for the Ghostty pass. **The agent auto-updated between the two halves**, so a
  Kitty-versus-Ghostty difference cannot be attributed to the terminal alone; both passes
  are individually valid and the cross-terminal comparison carries this caveat.

## 1. Matrix

Under Node 22. A cell passes only when every state that adapter exposes was exercised
with its byte log verified and its tester observation recorded, the normal exit produced
`OSC 111`/`OSC 112`, and an abnormally terminated session was proven removed by
`familiar reap`.

| Agent | States exercised | Kitty | Ghostty |
| --- | --- | --- | --- |
| Claude Code | six | pass | pass |
| Codex | four; no `needs-input`, no `error` | pass (bytes); no pet on screen | pass |
| OpenCode | five; no `needs-input` | **fail** | **fail** |

All nine verifier invocations exit 0, each asserted against the device recorded in its
own `versions-<terminal>.txt`. Re-run locally against the returned artifacts: 9/9 exit 0,
no `VIOLATION` line anywhere.

| Trace | Records | APC chunks | Bells | Restores | States |
| --- | --- | --- | --- | --- | --- |
| `kitty-claude-code` | 29 | 3991 | 7 | 3 | six |
| `ghostty-claude-code` | 14 | 572 | 4 | 1 | six |
| `kitty-codex` | 6 | 0 | 1 | 1 | four |
| `ghostty-codex` | 13 | 0 | 2 | 1 | four |
| `kitty-opencode` | 1125 | 1240 | 1 | 2 | four of five |
| `ghostty-opencode` | 5988 | 6094 | 1 | 2 | four of five |
| `spot-check` (Node 25) | 10 | 1457 | 5 | 1 | six |

Bell counts match the ringing set the verifier owns, not the one `emit.js` holds: Claude
Code rings on all three ringing states, Codex on `needs-approval` alone, OpenCode on
`error` alone in practice (see the OpenCode findings). The escape vocabulary across every
returned trace is closed as specified — `APC`, `OSC` 11/12/111/112, `BEL`, and the
OpenCode placement envelope's `ESC 7`/`CSI`/`ESC 8`, nothing else. `OSC 111` and `OSC 112`
appear 13 times each, always paired. The envelope counts balance exactly: 14120 `ESC`
against 7060 `CSI`, two saves-and-restores per absolute move.

**Graphics track state on the hook path.** Signing the graphics payload of each write
gives, for both Claude Code cells, exactly six distinct images across six states — one per
state, no state sharing an image with another. The Kitty image *id* is reused across states
within a session, as `kitty-animation` re-uses one handle and swaps frames beneath it, so
identity has to be read from the payload rather than the `i=` key. The resting-pose image
is byte-identical across both terminals and both OpenCode cells.

**Reap: six of six sets pass, 10 of 10 checks each.** Each set proves removal by identity,
not absence: the session id is a bare opaque string, present in the pre-reap bus; the
recorded pid matches the bus record; the identity line's pid *and* `starttime` both match
the bus before the kill; the reap target names that pid; the reap output is exactly
`reaped <session id>`; and the post-reap bus no longer contains it. Every pre-reap bus held
exactly one session, so no other agent's pruning could account for the removal. Darwin's
`comm` returned a full executable path for Codex — the vendored
`aarch64-apple-darwin/bin/codex` — confirming on hardware that the `basename()`
normalization in the resolver is load-bearing rather than cosmetic.

### Codex: bytes pass, pet did not render on Kitty

Familiar's own responsibility for Codex is tint and bell only; the pet is drawn by Codex
from `familiar install pets`. Both Codex cells verify clean at the byte level with zero
graphics, as the design requires. The pet was visible and changed with state on Ghostty;
it was absent on Kitty, and the cause is a Familiar installer gap rather than anything
about the terminal: **`familiar install pets` compiles all twelve pets but selects none**,
and its documented remedy `--sync-projects` was a no-op on a fresh machine because it
iterated identity entries with a `path` pin and `identities.yaml` does not exist after a
clean `theme add`. Following the runbook exactly, Codex rendered nothing on a fresh Mac.
The Ghostty pass hand-wrote the project config that sync would have produced. An installer
defect, not a terminal-rendering failure — which is why the Codex row reads `pass` on the
bytes: what Familiar sends for Codex is tint and bell, and both were correct on both
terminals. Fixed on `d53b59f`: `--sync-projects` now also selects a pet in
the repository it is run from.

### OpenCode: two findings, renderer stays provisional

**`needs-approval` is unreachable.** Confirmed by live bus observation rather than
inference: with the bus polled every 200 ms while an approval was driven, the sequence was
`idle` → `working` → `done`, with the permission dialog on screen for 28 seconds inside
the `working` stretch. No transition, no flicker — so not a precedence race and not a
polling artifact. Familiar's side is wired correctly: the installed plugin package declares
`permission.ask`, `integrations/opencode/plugin.js` registers it, and every other event
that file hosts reached the bus in the same session. Both cells therefore top out at four
of the five states OpenCode structurally exposes. This is a recorded failure, not an
undriven cell. It also means OpenCode can only ever ring on `error`, since `needs-approval`
is one of its two ringing states.

**Root-caused after the run.** The stable event union this plugin binds types
`permission.updated` and `permission.replied`; `permission.asked` exists only in the v2
union. `LEVEL_EVENTS` carried the reply but nothing for the ask, so the ask rested entirely
on the `permission.ask` hook — and when that hook does not fire, nothing fills the
permission set, the reply drains a set that was always empty, and the window runs
busy → idle with the dialog on screen. Fixed on `6605327` by folding
`permission.updated` into the same window action. Diagnosed from the SDK types, not from a
live reproduction.

**The sprite never changes pose.** Observed on both terminals and confirmed in the bytes:
each cell transmits exactly three images (`a=t`, three distinct ids) and then re-places them
1108 times on Kitty and 5952 times on Ghostty, while the hook recorded four distinct states
in the same sessions. The
Claude Code hook path in the same trace sends one image per state. Terminal capability is
not the variable — Ghostty is `static-graphics` and takes the `create` path on every
transmission, and its pet froze anyway. What separates the two is which process transmits:
the hook (`source: emit`) tracks state, the plugin (`source: opencode-sprite`) does not.
**Root-caused after the run, and confirmed by CI on `macos-14`.** `sprite-runtime.js`
watched the state directory and filtered its callback on `filename === 'intent.json'`. The
bus never writes that name: it writes `intent.json.tmp.<suffix>` and renames it over the
target, and the platforms describe that rename differently. Linux inotify delivers four
events and names the destination in the last, so the filter matched. Darwin FSEvents
delivers one event and names the *watched directory*, never the entry inside it — so the
filter could not match under any timing. `refresh()` fired once at `start()` and never
again, which is precisely a pet that renders its opening pose and holds it. Fixed on
`f1d2be0` by refreshing on any event in that directory; a
real-filesystem test now prints the observed filenames on both platforms, and the macOS
job asserts the Darwin line is present.

This also explains why nothing upstream of the renderer looked wrong: the hook wrote each
transition to `intent.json` correctly and the bus committed it correctly. Only the reader
was deaf.

Both OpenCode cells pass `gate-verify`, and that is correct behaviour rather than a hole
in the checker. Each record is checked against the emitter's own recorded expectation, and
the emitter genuinely expected to send the pose it held; the defect is upstream of the
write. Catching it takes a comparison *across* records — distinct images against distinct
states — which the evidence contract deliberately does not specify for OpenCode, since its
records carry no planned frame count. The trace holds the proof; the verifier was never
asked to look for it.

## 2. Capability `none` negative control

Required for any promotion (§11.3). **Both pass.** With the capability markers scrubbed,
every record classified `capability: "none"` and carried **zero APC chunks** — graphics
fully suppressed — while tint and bell were untouched: `OSC 11 #1a151e` and
`OSC 12 #9764c4` on every non-terminal record, one `BEL` on the ringing state, and the
`OSC 111`/`OSC 112` pair at session end. The tester saw no familiar on screen, consistent
with the byte count.

The two controls prove *different* suppression paths, which is why the design requires
both. Claude Code's runs through `emit()`. OpenCode's shows **zero `opencode-sprite`
records at all** — the plugin returns before registering anything with the renderer, so it
writes not one byte, against 1111 sprite records in the capable Kitty cell.

Bells were emitted correctly but **not audible**: this machine sets `enable_audio_bell no`
with no visual fallback. Every "bell heard" observation in the run is therefore unreliable,
and the byte log is the stronger evidence — it proves a `BEL` reached the correct device at
the correct state, which is the whole of Familiar's responsibility here.

## 3. Background and daemon appendix

**Probe 1 passes, and the `tty !== null` predicate is confirmed on hardware.** The capture
holds 829 processes. Nine belong to the agent family; the seven background and
daemon-hosted `claude` processes — `bg-pty-host`, `bg-spare`, the `ClaudeCode.app` host,
and a detached `~/.local/bin/claude` — all show no controlling terminal, and only the two
foreground sessions own one. The induced background subtree's intermediate host was
`/bin/zsh -c` with no tty, and the first tty-owning ancestor above it was the gate window
itself. So the resolver skips the TTY-less intermediates and lands on the right target,
which is exactly what the predicate exists to do. No intermediate `claude` owned a TTY;
the §11.6 override does not fire.

Four `claude` processes were alive at capture, so the chain had to be followed by ppid —
matching on the name alone would have found the wrong process three times out of four.

**Probe 2 passed vacuously and was replaced.** The required diagnostic never appeared, and
not because it was swallowed: no resolver failure ever occurred. The headless job really
ran, and the hooks partly ran — `agents.json` and `intent.json` were created, so
`familiar hook` executed and took the bus lock — but `SessionEnd` carries `level === null`,
the one path that skips `resolveAgentPid()` entirely, and the level-bearing hooks did not
fire in `-p` mode on 2.1.241. A replacement probe ran `familiar hook SessionStart` directly
under launchd with no controlling terminal and no `claude` ancestor, and **closed the
fail-closed contract end-to-end on Darwin**: the diagnostic reached stderr, the hook still
exited 0, and not one byte was written.

**Still open, deliberately stated.** That chain contained no `claude` process at all, so
the resolver failed on the `comm` half of its predicate. The `tty !== null` half — the one
`src/adapters/claude-code.js` flags as "NOT measured on Darwin" — is proven here only at
unit level. Measuring it in situ needs a launchd-hosted `claude` that fires a level-bearing
hook, which `claude -p` on 2.1.241 does not.

## 4. Generated configuration

First live exercise of `familiar setup codex`, and it works. **All six configured events
fired**: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (four times), `PermissionRequest`,
`Stop`, and `SessionEnd`, across nine records.

Two configuration findings surfaced during the run. `familiar install opencode` refused
whenever an `opencode.jsonc` existed — even once the plugin was registered — and exited
before writing `tui.json`, while `install pets` selected no pet, as recorded above. Both
are since fixed: independent OpenCode config handling landed in `bf088b8`, and current
repository pet selection landed in `d53b59f`.

## 5. What this evidence does not cover

- macOS 14 with a live agent. CI runs macOS 14 without agents; this capture ran a later
  macOS. The gap stays open.
- The `tty !== null` half of the resolver predicate in a real launchd context (§3).
- OpenCode's `needs-approval` state and its sprite pose transitions, both failing above.
- Whether the Kitty Claude Code pet changed pose visually. Its transmissions were verified
  distinct per state in the bytes, but no visual observation was taken and the window is
  closed. The Ghostty pose change was confirmed by eye.
- Frame-by-frame graphics sequence. The verifier checks image identity across every chunk,
  key grammar, the `boxFor` placement box, and chunk count against the encoder; it
  deliberately does not reimplement the encoder's chunking rules, because a copy of the
  encoder is not an independent check of it.
- OpenCode graphics depth. Its renderer plans and encodes inside `sprite-runtime.js`, so
  its records carry no planned frame count or placement; its graphics are checked for
  image identity, key grammar, and placement-envelope order only.
- The event-to-state mapping, which each adapter's unit tests cover in CI. This gate checks
  that the state the emitter acted on produced the right bytes on the right device.
- tmux, Intel Macs, macOS 13, and terminals other than Kitty and Ghostty.
- Audible bells, suppressed by this machine's terminal configuration (§2).
