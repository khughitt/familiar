Verdict: **accept**. Open findings: **Critical 0, Important 0, Minor 0**. All six round-5 findings are addressed. This accepts the technical specification; the written user-review and implementation-plan gates remain.

Reviewer: **codex/gpt-6.1-sol**, printed by a fresh successful `timeout 2 relay model --harness codex --pretty`.

Reviewed frozen commit `2b58b29009267ac0978945515cdadc3309736a74`, using `git show`, at `.worktrees/desktop-attention/docs/specs/2026-10-24-desktop-attention-design.md`. Compared against `4fdcb54ae7335e594b95b9578360cdcdbaac02e1` and read the full incoming round-5 review. Line references below identify the reviewed revision.

1. **Claude sub-agent attribution — resolved through an explicit limitation.**
   Spec lines 80–86 and 139–152 correctly state that same-session Claude events share one normalized source. Pinned relay’s `normalizeEvent` uses `workerIdOf` when available; Claude has none, while Codex supplies it. The correction explicitly accepts possible early closure, requires truthful tooltip wording, rejects invented attribution, and requires planning to record the parallel-permission runtime check. Lines 505–508 require an aliasing regression that demonstrates the limitation rather than falsely asserting marker retention. No separate Claude worker identity is promised.

2. **Missing worker completion — resolved through a persistent diagnostic.**
   Relay’s transaction records worker process identity through the same harness-process resolver, removes associated workers on root teardown, and prunes rows through process liveness without an age timeout. The revised rule therefore correctly avoids treating age or the shared process as independent evidence that a worker ended. Spec lines 163–184 provide a static diagnostic even without a request episode or an unfocused workspace, a global fallback for unmapped roots, stable blocker-set identity, separate dismissal, retained tooltip status, restart persistence, and no replay when blockers clear. Lines 328–333 keep it visible beside higher-priority requests and protect changed blocker sets from stale dismissals. Lines 509–514 require the missing-`SubagentStop` regression. Dismissal never unlocks completion or mutates relay.

   Actual Codex interrupt hook guarantees remain explicitly unverified at lines 88–92. The conservative policy works without that guarantee; the required regression tests its absence.

3. **Completion history after marker removal — resolved.**
   Lines 198–200 explicitly record initially focused completions. Lines 220–240 retain completed-turn identity and dispositions independently of visibility, including focus, dismissal, passive idle, reconciliation and restart. Delayed same-turn idle-input preserves the episode’s delivery or suppression decisions and cannot create another popup/toast opportunity. Genuine root activity ends that association. Lines 521–525 require the focused, later-seen, dismissed, restart and new-activity control cases. This also remains consistent with OpenCode’s pinned reduction, where successive idle events can produce `done → idle`.

4. **Heartbeat contention — resolved.**
   Familiar currently serializes projection under `presentationLockPath` in `src/observe/run.js`. Lines 461–466 now require a separate atomically replaced `attention-health.json`, explicitly outside the presentation/episode lock, attention revision and lifecycle projection. Lines 544–545 require a held-lock regression and verify that heartbeat refresh does not trigger projection. The episode/control locking rule at lines 380–381 no longer accidentally includes heartbeat writes.

5. **Unknown DND queue behavior — resolved.**
   Lines 431–438 explicitly suppress queued and future not-yet-started popup/toast opportunities while DND is unknown or on, persist the affected decisions, stop attention motion, and prohibit recovery replay. The in-flight-send exception is bounded and consistent with the existing delivery boundary. The same rule covers queued health notices. Lines 531–532 require unknown-to-off queue suppression testing.

6. **Approval wording across harnesses — resolved.**
   Lines 252–256 explicitly apply “Approval requested — response unconfirmed” to all three harnesses and identified workers. This correctly distinguishes the wording of a displayed observation from OpenCode’s normally faster reply-driven closure. Pinned OpenCode code tracks `permission.replied` and recomputes its aggregate state. Lines 531–532 require all-harness wording coverage.

I found no new consequential contradiction introduced by these corrections. Familiar’s current projection folds newer worker state into the root; the spec continues to require the new lifecycle path to consume raw rows before that fold. The corrected attribution and suppression rules fit that boundary.

Runtime Claude scheduling, native Codex interrupt behavior, Noctalia gestures, plugin notifications and live DND behavior were not verified here. The spec requires the relevant planning and validation work without claiming it passed; the Codex missing-hook policy deliberately avoids needing a native interrupt guarantee.

No tests, task mutations, file changes, notifications or live desktop actions were performed. No background processes were started; the worktree was left unchanged.
