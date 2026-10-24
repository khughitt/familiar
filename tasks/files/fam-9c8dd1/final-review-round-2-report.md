# Final review, round 2 (scoped re-review of b1ca56a..0110d53)

Reviewer: claude-code/claude-opus-5-5 (fresh read-only subagent), 2026-10-24.
Saved by the controller from the reviewer's final message.

Verdict: one Important finding outstanding (new Important 1, the unmapped-root part of
round-1 Important 2). No Critical. `just test` on 0110d53: fast 1298 (1293 pass, 5 skipped),
slow 7/7.

## Round 1 findings
- Important 1 (false disconnection at login/restart): Resolved. recover records the new
  instance before the first heartbeat (model.js:494); plugin grace for leftover heartbeats
  and 3 s confirmation (service.luau:176-181); tests sound (login at 5 s tests the grace;
  restart both orders; coordinator test checks every heartbeat write). Stale/invalid not
  delayed. Side effect: startup detection now 13 s (new Minor 1).
- Important 2 (dismissed diagnostic vanished): Partly. Works for a known workspace; for an
  unmapped root the widget (widget.luau:149) and panel (panel.luau:45) read only
  unmapped.diagnosticIds, so a dismissed unmapped diagnostic leaves nothing and the hint
  never shows.
- Important 3 (unknown DND invisible): Resolved (status node; log once per distinct error;
  readiness reads published state). Label wording: new Minor 3.
- Re-graded Minor 1 (popup loop/wedge): Resolved by inspection; proof weak (static). No
  dropped/duplicated/misattributed reply found; a request is released only when
  control.running is false. Leftover: the kill branch does not restart the timer (a process
  ignoring SIGTERM could still wedge) — not raised. Runbook lacks the runtime check the
  ledger defers to it (new Minor 4).
- Re-graded Minor 3 (popup state dir): Resolved for absolute paths; a relative override
  behaves three ways (CLI uses it, plugin refuses it, popup silently falls back) — new Minor 5.

## New issues
### Important
1. A dismissed diagnostic for an agent with no known workspace still vanishes entirely
   (widget.luau:149-151, panel.luau:43-47; unmapped.dismissedDiagnosticIds is filled but
   unread). Common for agents inside tmux. Fix: show the unmapped status node when
   dismissed unmapped diagnostics exist, with "(dismissed)" lines plus the hint; Luau test;
   correct docs/attention.md:128.
### Minor
1. Startup grace + 3 s confirmation add up: a never-started coordinator at login is
   reported at ~13 s (spec: ten-second grace). Fix: start the unhealthySince clock during
   the grace for transitional states, or record a ruling.
2. recover vouches for the new instance before it has published its own desktop status
   (model.js:494): between first heartbeat and first pass the coordinator reads healthy
   while desktop.status/dnd hold the previous instance's values; popup claims pass; the
   runbook readiness check can pass on stale values. Fix: also set desktop.status =
   'unknown' in recover; update the model test.
3. Labels promise more than happens: "toasts and popups held back" suggests later delivery
   (spec: dropped, never replayed); the hint's "completions stay withheld until the worker
   reports" suggests the withheld completion appears later. Reword.
4. Runbook lacks the popup backoff check that the ledger defers to it. Add a step-3 check
   (popup with familiar missing from PATH: at most one control process per 2 s, no wedge
   once restored), or rule the static proof sufficient.
5. Popup silently falls back to the default directory on a relative FAMILIAR_STATE_DIR
   (shell.qml:12-15): against fail-early; refuse it as the plugin does (warn, stay idle).

## Declined to judge
- Quickshell Process behaviour on failed start / running=false while starting (runtime).
- A crash-looping coordinator writing one heartbeat per restart reads healthy (predates
  the round).
- Whether the "previous boot" login fixture's saved instance id matches a real login
  state file (fixture design; code path covered either way).
