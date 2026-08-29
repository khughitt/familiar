# macOS terminal gate — corrections to the runbook

Twelve amendments to `docs/ref/2026-08-24-macos-terminal-gate-handoff.md`, each traceable
to a recorded deviation from the 2026-08-24 execution of that runbook. The `Deviation N`
labels are provenance, not links: they number the tester's returned notes, which are not
committed here because no raw capture from that run reaches this repository. **Read this
before running the gate.** The runbook text has deliberately not been edited in place: it is the
document the recorded run was executed against, and rewriting it would break that
correspondence. These are the corrections it needs.

Item 1 is a stop-the-run defect — followed literally, the runbook fails all six cells with
a message that reads exactly like the wrong-target resolver defect the gate exists to
detect. Items 4 and 5 have since been fixed in Familiar itself: `install pets` now selects
a pet in the current repository, and `install opencode` no longer lets one config's
refusal block the other. They are kept here because the runbook text still describes the
old behaviour.

The ten scripts written during that run are in `tools/gate/`. They are not a supported
interface; they are what one tester needed to run this protocol without repeating its
mistakes. `tools/gate/gate-rdev.sh` implements item 1, `gate-cell.sh` item 3, and
`gate-probe2b.sh` item 7.

---


## 1. §2's `terminal-rdev` capture is wrong by construction  (Deviation 4 — critical)

    export FAMILIAR_GATE_RDEV="$(node -e '...fstatSync(1).rdev')"

`$( )` replaces fd 1 with the capture pipe, so `fstat(1)` measures the pipe. It returns 0
on every machine, every run. This run recorded `terminal-rdev=0` and would have failed all
six cells with `reached rdev N, but this run's terminal is 0` — textually identical to the
wrong-target resolver defect the whole gate exists to detect.

Guard 3 is not wrong, only narrower than it reads: command substitution is correct for
version *strings* because it denies the child a seekable fd. The device capture is the one
value where the redirection **is** the measurement.

Replace with a path-based capture — `tty(1)` reads fd 0, which `$( )` leaves alone:

    FAMILIAR_GATE_TTY="$(tty)"
    case "$FAMILIAR_GATE_TTY" in /dev/*) ;; *) printf 'STOP: no controlling tty\n' >&2 ;; esac
    export FAMILIAR_GATE_RDEV="$(node -e '
      const s = require("node:fs").statSync(process.argv[1]);
      if (!s.isCharacterDevice()) throw new Error("not a character device");
      if (!s.rdev) throw new Error("implausible rdev 0");
      process.stdout.write(String(s.rdev));
    ' "$FAMILIAR_GATE_TTY")"

Add a stop-check: a `terminal-rdev` of 0 is never valid. See `tools/gate/gate-rdev.sh`.

## 2. §5 tells testers to reach `error` in a way that cannot work  (Deviations 5, 10)

§5 says to "provoke a failing tool call (or, for Claude Code, a `StopFailure`) for
`error`". A failing tool call cannot produce `error` for **either** agent that exposes it:

  - Claude Code's `StopFailure` payload carries a required `error` field whose enum is
    entirely API-level: authentication_failed, oauth_org_not_allowed, account_on_hold,
    billing_error, rate_limit, overloaded, invalid_request, model_not_found, server_error,
    unknown, max_output_tokens. A tool error is an ordinary result; the turn ends `Stop`
    -> `done`. An interrupt is an abort, not a failure.
  - OpenCode's `session.error` comes from `Session.Event.Error` (`SessionProcessor.halt`),
    a session-level halt. Same reasoning.

Both were induced by cutting Wi-Fi mid-request. Say so, and note the state is an
API-failure state not reachable in ordinary use.

## 3. §5 needs a window guard  (Deviation 11)

Two cells were invalidated by driving an agent from the second tab — the tab §5 effectively
requires, since the agent occupies the gate shell during the reap step. `FAMILIAR_GATE_TRACE`
is exported into a shell and never checked against the window whose device
`versions-<terminal>.txt` recorded, so one paste silently invalidates a cell and produces
the wrong-target message. Add, at cell-open time:

    compare statSync("$(tty)").rdev against $FAMILIAR_GATE_RDEV; refuse on mismatch

See `tools/gate/gate-cell.sh`.

## 4. §4's `install pets` selects no pet  (Deviation 8)

Its own help says: "Without `--sync-projects`, this command does not change the user-owned
`[tui] pet` setting." §4 runs it bare, so all 12 pets compile into `~/.codex/pets/` and
Codex has none selected — and for Codex the pet is the entire state signal.

`--sync-projects` is a no-op on a fresh machine: it iterates `catalog.identities` for
entries with a `path` pin, and `identities.yaml` does not exist after a clean `theme add`.

**Since fixed** (`fix/codex-pet-sync-cwd`): `--sync-projects` now also selects a pet in the
repository you run it from, so it is no longer a no-op without `identities.yaml`. §4 still
needs to pass the flag. The config it produces (note the mandatory `custom:` prefix):

    # Managed by Familiar. Run `familiar install pets --sync-projects` to update.
    [tui]
    pet = "custom:familiar-<member>"

## 5. §4's `install opencode` cannot be satisfied as described  (Deviation 2)

It refuses whenever `opencode.jsonc` exists — even once the plugin is registered — and
exits before writing `tui.json`. Following §4 literally leaves `sprite-plugin.tsx`
uninstalled, so the OpenCode cells run with no sprite renderer at all and §5's "the trace
will be enormous" expectation quietly does not materialise.

**Since fixed** (`fix/opencode-install-partial`): a `.jsonc` is now a hand-off for its own
file only, so `tui.json` is written and the renderer is registered even when
`opencode.jsonc` must be edited by hand. §4 should still tell testers to expect the
hand-off and the nonzero exit.

## 6. §3's backup set is incomplete  (Deviation 7)

Not backed up, not restored, still present after §11:

    ~/.codex/config.toml     modified: project trust + per-hook trusted_hash entries
    ~/.codex/pets            created by `install pets` (2.5 MB)
    ~/.local/state/familiar  Familiar's own bus and intent files, created by the run

Add all three to §3, or list them in §11 as manual cleanup.

## 7. §7 probe 2 cannot exercise its own contract  (Deviation 14)

Probe 2 runs `claude -p` under launchd. On 2.1.241 that fires no level-bearing hook, so
`resolveAgentPid` is never called, no resolver failure exists, and results 2 and 3 (`exit
0`, empty trace) pass vacuously while result 1 fails. The agent genuinely ran —
`probe2-stdout.txt` contains `probe`.

Run `familiar hook SessionStart` **itself** under launchd instead: no claude ancestor, no
controlling terminal, so the resolver must fail. That variant passed here
(`tools/gate/gate-probe2b.sh`). Note it exercises the `comm === AGENT_COMM` half of the
predicate; the `tty !== null` half that `claude-code.js` flags "NOT measured on Darwin"
needs a launchd-hosted claude that fires a level-bearing hook, and remains unmeasured.

## 8. §7's ancestry read needs a warning  (Deviation 1 of probe 1)

Four `claude` processes were alive at capture: the desktop app, a detached binary, the gate
session, and a helper. Grepping for `claude` finds the wrong one three times in four. Say
explicitly: follow the ppid chain up from the backgrounded `sleep`.

## 9. Bell observations need a precondition  (Deviation 13)

`enable_audio_bell no` in this machine's `kitty.conf` made every "bell heard" field
unanswerable by ear, though every BEL byte was correct in the log. Ask testers to confirm
`enable_audio_bell` (and `visual_bell_duration`) before recording a bell observation, and
say that the byte log is the stronger evidence — it proves a BEL reached the correct device
at the correct state, which is Familiar's whole responsibility.

## 10. Tint observations need the same treatment  (observation)

The backdrop is a near-black wash (`#1a151e` here) and, more importantly, **does not vary
with state** — backdrop and cursor are byte-identical across all six Claude Code states.
"Did the window tint?" cannot be answered by watching for a change during a session. Point
testers at the cursor colour, which is vivid, and say the tint carries identity not state.

## 11. Agent versions should be pinned or drift-checked  (Deviation 15)

Claude Code auto-updated between the two halves of the matrix (2.1.241 on Kitty, 2.1.248 on
Ghostty), so no Kitty-vs-Ghostty difference can be attributed to the terminal alone. Have
§2 compare against the previous terminal's versions file and warn on drift.

## 12. Smaller items

  - §5's spot-check offers `nvm deactivate` / `nvm use system`. On a machine with no system
    Node that leaves no `node` on PATH, breaking `bin/familiar`'s shebang and every hook —
    an empty trace with nothing on screen to say why. Say `nvm use default` and verify
    `node` resolves. (Deviation 12)
  - §5's OpenCode state table claims five states. Only four are reachable on 1.18.21.
    (Deviation 10)
  - `probe2-stderr.txt` being empty is a *result*; §8's non-empty inventory check reports
    it as MISSING. Note the exception. (Deviation 14)
  - Both Codex and Ghostty left the shell with output post-processing disabled after a TUI
    session. `stty sane` recovered Kitty; nothing recovered Ghostty. Since the cell device
    is pinned to the window, it cannot be replaced — tell testers to read verifier results
    from the trace files rather than the terminal. (observation)
  - `gate-verify` throws an uncaught `TypeError` on a `kind:"write"` record with no
    `escapes` array: no summary, no VIOLATION lines, and every other finding in that file
    discarded. `parseTrace` already anticipates torn lines from the two-process OpenCode
    cells. One fail-closed guard fixes it. (Deviation 3)
