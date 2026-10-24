# Final review, round 3 (scoped re-review of 0110d53..d0e5c13)

Reviewer: claude-code/claude-opus-5-5 (fresh read-only subagent), 2026-10-24. Saved by the
controller from the reviewer's final message.

Verdict: no Critical or Important finding outstanding (persisting or introduced). `just
test` on HEAD f324415 (d0e5c13 + a task-note commit): fast 1299 (1294 pass, 5 skipped),
slow 7/7; qmllint clean.

Fixes: (1) unmapped dismissed diagnostic — Resolved (shared groupTooltip; dismissed-only
workspace gets a section without a Dismiss button); (2) recover status unknown —
Resolved (first pass always writes; claims, toast dispatch and focus-path classification
wait; plugin markers unchanged in the interval, from predecessor origins); (3) labels —
Resolved; (4) runbook backoff check — Resolved in substance (not runnable as written);
(5) relative FAMILIAR_STATE_DIR — Resolved for relative values; (6) start-limit ruling —
Resolved for fast crash loops.

Minor:
1. The unmapped status node (and panel sections) show the "Right-click to dismiss" hint,
   but right click does nothing there (widget.luau:154-155; presentation.luau:292).
2. Runbook step 3's popup backoff check cannot be run as written (no way to restore
   `familiar` on a running process's PATH, no way to count attempts).
3. The model test's added claim assertion proves nothing (b is pending; claim returns none
   regardless); the focus-path consumer is untested.
4. The new contract test does not cover the dismissed-only unmapped case ("·" node, no
   panel Dismiss button).
5. Between recover and the first pass the focus path can still suppress newly pending work
   on the predecessor's DND reading (coordinator.js:246-248, model.js:401); docs line
   overstates.
6. An empty FAMILIAR_STATE_DIR resolves differently in the popup (default) and the CLI
   (cwd-relative); the plugin refuses it.
7. Start-limit text and ruling cost understate the slow crash loop (a coordinator dying
   ≥15 s after each start never trips the limit and reads healthy indefinitely).
8. The panel's 12-line cap can truncate the unmapped section's dismissed-diagnostic line.

Declined to judge: systemd acceptance of StartLimit properties on transient user units (not
verified, would start a unit); Quickshell FileView behaviour with an empty path (runtime);
panel `pill.output` never set (predates the round).
