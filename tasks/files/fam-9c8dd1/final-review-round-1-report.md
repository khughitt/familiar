# Final whole-branch review, round 1

Reviewer: claude-code/claude-opus-5-5 (fresh read-only subagent), 2026-10-24.
Range: d33273739987378d9c0757aced07daaf2ad95c66..b1ca56a (feat/desktop-attention).
Saved by the controller from the reviewer's final message.

**Verdict: ready to merge with fixes, not as it stands.** No Critical issue. The lifecycle
reducer, the store and lock discipline, the delivery reservations, the focus-by-ID path
and the CLI protocol hold up against all five review-focus items. Three Important issues
should be fixed before the merge-as-activation step; all are about what the bar tells the
user: a false "disconnected" alarm at login and on coordinator restart, a
withheld-completion status that disappears once dismissed, and an unknown DND state that
is invisible in the bar.

Re-ran on head b1ca56a: `just test-fast` 1287 tests (1282 pass, 0 fail, 5 skipped);
`just test` the same plus slow 7/7. Reviewed in passes (spec/plan/ledger; core; Niri
side; consumers; tests, host mock, docs, runbook).

## Strengths
- Source isolation and turn history as specified (keys by generation/agent/process
  handle; per-source frontier; envelope-first; passive idle; same-turn upgrade
  model.js:246-249).
- Delivery state machine: reservation before send; recover → uncertain + suppress queued;
  dismissed/closed between claim and send settled suppressed (coordinator.js:127-144);
  no double announcement path found.
- Lock discipline: single mutateAttention lock, no nesting, no cycle with relay;
  heartbeat/topology lock-free; focus path locks only for unseen IDs.
- Navigation independence: feed straight from the event stream via a latest-value writer;
  `familiar niri focus` lock-free, preflight + one action by ID, bounded framing; plugin
  fallback guarded by a generation counter.
- Review focus 4 covered with real artefacts (unmodified production Luau bytes, real CLI
  JSON with nulls dropped, per-render captured IDs).
- Subprocess environments built key by key; rulings mostly well reasoned.

## Important
1. False "Agent alerts disconnected" at login and on every coordinator restart —
   service.luau:191-198; coordinator.js:200,250,258; model.js:489-508; locked in by
   contract.test.mjs:541. Login: a previous boot's heartbeat reads `mismatched` (grace
   covers only `missing`), so the bar shows disconnected and may notify before the new
   coordinator writes. Restart: `beat()` (instance B) precedes the first resync that
   writes desktop.instanceId = B, so consumers (incl. the popup claim gate) see
   `mismatched` for a few hundred ms. Fix: record desktop.instanceId (non-known status)
   in/after recover before the first beat; treat a heartbeat from another boot/session as
   missing for the grace period in plugin and popup; add login and restart tests.
2. A dismissed withheld-completion diagnostic disappears entirely; no tooltip separates
   dismissing it from changing the completion gate — attention.js:73-76;
   presentation.luau:234-241,312,15. Spec: "Keep suppression status available in the
   tooltip after dismissal" and "the tooltip distinguishes dismissing a diagnostic from
   changing the underlying completion gate". Fix: keep dismissed diagnostics in the
   tooltip only (no glyph/count), add a diagnostic-specific hint, Node and Luau tests.
3. Unknown DND is invisible in the bar (only journal lines, repeated every resync) —
   widget.luau:138-143; coordinator.js:80-83; runbook readiness checks DND from the
   operator's shell, not the unit's environment. Fix: status node "Do Not Disturb status
   unknown — toasts and popups held back" while healthy and dnd unknown; log DND failure
   only on change; readiness via `familiar attention status | jq -r '.desktop.status,
   .desktop.dnd'`.

## Minor
1. No backoff on a failed popup claim (shell.qml:118-138, logic.js:150-152): a persistent
   CLI failure becomes a tight loop of `familiar attention popup` processes; a failed
   start may wedge silently. Add backoff and failed-start handling.
2. A failed windows query wipes the window map (coordinator.js:70-79): syncWindows([])
   rewrites niri-windows.json unmapped; previously left alone. Skip syncWindows on failure.
3. The popup ignores FAMILIAR_STATE_DIR (shell.qml:10), so runbook step 3's throwaway
   state dir leaves the popup reading another directory than its CLI writes.
4. A crashed popup's reservation never becomes uncertain (logic.js:117-127 sends only
   pending/eligible at attach; model.js:441 branch unreachable).
5. Panel: pill.output never set (suffix never shows); panel draws attribution in fallback
   mode while the widget withholds it (panel.luau:35-40).
6. Diagnostic-only unmapped text "0 alert(s) with no known workspace"; panel unmapped
   section shows a count but no lines (widget.luau:146-149).
7. Widget `known`/`arrivals` maps never pruned (widget.luau:17-18,45-58).
8. Possible lost clicks during motion re-renders (host drops superseded handlers) — add to
   the native pilot checklist.
9. No documented recovery for a corrupt attention.json (store.js:35-37).
10. Speculative: relay process-identity flapping (handle/null) would start new sources and
    re-announce, even a dismissed request (model.js:155-164,311); not reproduced.

## Recommendations
- One corrective round for Important 1-3 with failing-then-passing tests.
- Integration ordering: tools/cli.toml is adopted from ops e2fd137/bad0b57, which exist
  only in local unpushed ops main (314675f): push ops before or with familiar.
- Runbook: between step 4 (coordinator toasts start) and step 7 (native toasts
  suppressed) both producers are live; say so or reorder.
- Luau parity: a CI grep for constructs newer than 0.724 would make the T6 ruling checkable.

## Declined to judge
- Pixel-level treatment — builder's call per spec, headless previews.
- Native latency, Wayland hit-testing, real gesture interception, notification display —
  gated pilot.
- Owner tasks hq-4c954d, hq-d6e13a, dots-dfecf1 — outside this branch.
- Deferred round-7 minor (legitimate workers withhold completion) — deferred by spec/plan.
- Early closure under Claude aggregate attribution — accepted v1 limitation; disclosure
  checked.
- cli.toml protocol wording and other projects' rows — ops-owned; minors on ops-f800b0.
- Workspace IDs above 2^53 − 1 — explicit adapter limit.
- macOS behaviour of the Niri/Noctalia surfaces — Linux-only by design.
- Reappearance of a diagnostic whose blocker set shrinks (ruling T1) — matches spec;
  cost recorded.

## Assessment
Ready to merge? With fixes. Important 1-3 are user-visible truthfulness problems on the
health and status surfaces, which matter most once native toasts are off; fix them (and
Minors 1-3 if convenient) before the merge, since the runbook treats the merge as
activation.
