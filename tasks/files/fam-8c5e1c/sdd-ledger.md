# SDD ledger — plan: docs/plans/2026-10-24-attention-crash-history.md

Spec: docs/specs/2026-10-24-desktop-attention-design.md ("Repeated crashes"), accepted ee3b32a. Plan accepted 3d6da97.
Step tasks: T1 fam-f3dba6, T2 fam-bdc129, T3 fam-dd911d, T4 fam-12b0da, T5 fam-f9cd46. Execution start HEAD f78a93e.

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1-T2 | T1: store.js constants + validHealth, coordinator beat writes minimal schema 2; T2 rewrites beat with normaliseCrashes/carriedCrashes using T1's constants | consistent |
| T1-T4 | T1: CRASH_WINDOW_MS, CRASH_HISTORY_MAX (store + P.*); T4 crashCount/P.crashCount use them | consistent |
| T2-T3 | T2: stop path, final record, per-run fakeStream harness; T3 extends fakeStream with ended and changes stream-end handling in lifetime | consistent; T3 must keep T2 harness API |
| T2-T4 | coordinator toast-gate test (T2) vs reader gate tests (T4) | disjoint files except store.js (additive) |
| T4-T5 | T4 behaviour documented by T5 | consistent |
| T1 self | fixture migration list vs files touched; Step 5 runs just test for cadence.slow | agrees |
| T2 self | harness steps precede tests; just test at Step 6 | agrees |
| T3 self | bin/familiar-niri + new slow test; just test | agrees |
| T4 self | widget restructure matches widget.luau:138-146; just test | agrees |
| T5 self | docs only; just check | agrees |

Scan clean; no rulings needed.
Task 1: dispatched implementer (sonnet), BASE b9439e9
Task 1: review (reviewer claude-sonnet-5-5) — spec ✅, quality Approved; 0 Critical/Important, 4 Minor
Task 1: minor (deferred): logic.js validHealth repeats the writtenAt check (dead second check) and its 600000/8 literals lack a mirror comment
Task 1: minor (deferred): parity lists lack missing-stopped / missing-crashedAt cases (only store test covers missing stopped)
Task 1: minor (deferred): no Luau case with crashedAt a number or string
Task 1: minor (deferred): presentation.luau crash constants split the HEALTH_* block
Task 1: complete (commits b9439e9..0cc1dc5, review clean)
Task 2: dispatched implementer (opus), BASE 401a18a
Task 2: review (reviewer claude-opus-5-5) — spec ✅, quality Approved; 0 Critical/Important, 6 Minor
Task 2: minor (deferred): age-out test's hand-rolled poll fails with a TypeError on timeout instead of a named assertion (test/attention-coordinator.test.js:644)
Task 2: minor (deferred): stop-during-recovery test relies on a 50 ms real-time sleep before SIGTERM; poll signals.count() instead (test:726)
Task 2: minor (deferred): store.js:120 comment on parsed null reads backwards
Task 2: minor (deferred): doubled blank line test/attention-store.test.js:219
Task 2: minor (deferred): coordinator.js:222 `return 0` could be `return exitCode`
Task 2: minor (deferred): pre-existing — heartbeat interval keeps running if watch()/eventStream() throws during setup
Task 2: complete (commits 401a18a..c0083b1, review clean)
Task 3: dispatched implementer (opus), BASE 7f369ea
Task 3: review (reviewer claude-opus-5-5) — spec ✅, quality Approved; 0 Critical/Important, 6 Minor
Task 3: minor (deferred): real-process group tests cannot force child-first order (passed on old code); add a deterministic pin: SIGTERM child, ~200 ms, SIGTERM coordinator → exit 0, stopped: true
Task 3: minor (deferred): loose stderr regexes in alone/hang/spawn-error tests could match other branches
Task 3: minor (deferred): hang test cannot tell the hang-path close() from cleanup's
Task 3: minor (deferred): closedStream flag currently unreachable as a decision input; its comment overstates
Task 3: minor (deferred): hang kill is SIGTERM only (fine for niri msg, weaker than "is killed")
Task 3: minor (deferred): garbled header comment test/attention-signals.slow.test.js:1
Task 3: note: filed fam-186451 for an intermittent theme-acquire growth-scan test failure seen once in just test
Task 3: complete (commits 7f369ea..747f0c9, review clean)
Task 4: dispatched implementer (opus), BASE 2a52c2e
Task 4: Ruling: the published unstable flag (and so the widget node) follows the open unstable episode, not the instantaneous reading — the spec calls the node persistent and clears it only when crashes fall below two, which is exactly when the episode ends; a crash loop would otherwise blink the node off ~2 s per restart — cost if wrong: the node shows during a brief mismatched reading where the health rule would not call the coordinator unstable
Task 4: ruling applied by implementer in b337da5 before review
Task 4: review (reviewer claude-opus-5-5) — spec ✅, quality Approved; 0 Critical/Important, 7 Minor
Task 4: minor (deferred): store.js crashCount restates the live-epoch comparison instead of sharing it with healthStatus (Luau factored liveEpoch)
Task 4: minor (deferred): attention-store test comment claims Luau parity uses the same cases; contract.test.mjs has a hand-copied list
Task 4: minor (deferred): DND case list duplicated in contract.test.mjs for disconnected and unstable notices
Task 4: minor (deferred): no test pins the accepted <=3 s node blink when crashes become uncountable (missing/other-epoch record) during an episode
Task 4: minor (deferred): service.luau module-level `unstable` could be local to evaluate
Task 4: minor (deferred): contract.test.mjs grew 899 -> 1266 lines; the unstable section could move to its own file
Task 4: minor (deferred): restart test's mismatched-sample floor (>= 4) is weak
Task 4: complete (commits 2a52c2e..b337da5, review clean)
Task 5: dispatched implementer (sonnet), BASE 0bd93f6
Task 5: note: implementer left a background 'bfs /' search for noctalia-api-report.md; controller killed pids 3423304/3423302/3423277
Task 5: review (reviewer claude-sonnet-5-5) — spec ✅ (content), quality Needs fixes; 2 Important, 6 Minor
Task 5: minor (deferred): consider `noctalia msg plugins disable/enable` on khughitt/familiar as a narrower reload before a full restart (unverified)
Task 5: minor (deferred): pgrep for the watcher may match an sh -c wrapper too; say take the node pid
Task 5: minor (deferred): confirm command should say "within 10 s" of restart
Task 5: minor (deferred): kill-then-freeze check must target the new main pid after a SIGKILL restart
Task 5: minor (deferred): upgrade could mention the expected one-line "health record unusable; crash history reset" log after reading the schema-1 record
Task 5: Ruling: reviewer Minor 3 (watcher relaunch shares the shell-scope problem) is the same defect as Important 1 and goes into the fix round with it — splitting them would leave one of two parallel commands wrong — cost if wrong: a slightly larger fix diff
Task 5: fix round 1/5 (2 addressed, 0 open — Niri relaunch + bounded wait; whole-shell restart warning; commits dfc1f40..fb1fda7; re-reviewer claude-sonnet-5-5)
Task 5: minor (deferred): upgrade pgrep lines can return several pids (use pgrep -o)
Task 5: minor (deferred): a failed stop_and_wait does not stop the following relaunch line (chain with && or say stop here)
Task 5: minor (deferred): pre-existing — Rollback restore line and step 6 still relaunch from the operator shell (terminal scope)
Task 5: complete (commits 0bd93f6..fb1fda7, review clean after 1 fix round)
Final review: dispatched (opus) over 745b291..ae62c22
Final review (reviewer claude-opus-5-5): Ready to merge with fixes; 0 Critical, 0 Important, 6 Minor; proposes 2 Task 5 deferred minors as fix-before-merge
Final: Ruling: confirm re-grade of Task 5 minors "pgrep may return several pids" and "a failed stop_and_wait does not stop the relaunch" (final Minor 1) to Important — they sit on this merge's activation step on the live desktop and a timeout can start a second Noctalia or popup daemon — cost if wrong: three extra lines of runbook shell
Final: Ruling: re-grade final Minor 2 (future-dated carried crash reappears once the clock passes it) to Important — the spec's writer step 2 says the writer drops entries later than its clock, and a per-beat filter that keeps the source contradicts that and can raise a spurious unstable notice after a large backward clock step — cost if wrong: a one-line change and one test
Final: Ruling: final Minors 3-6 (plugin scene restart order, Luau null entries, second signal during drain, revert note) stay minor (deferred); recorded for the final message
Final: Ruling: Task 2 deferred minor "stop-during-recovery test 50 ms real-time sleep" filed as a follow-up task rather than fixed here — it can only fail, never falsely pass, and is outside the corrective scope — cost if wrong: an occasional fast-suite flake until fixed
Final: corrective round 1 dispatched (fix subagent sonnet), FIX_BASE ae62c22
Final: corrective round 1/5 (2 addressed, 0 open — stop_and_wait refuses failed stops and relaunches chained; persisted normalised history; commits ae62c22..e6c6dff; re-reviewer claude-opus-5-5)
Final: minor (deferred): stop_and_wait accepts pid 0 (kill 0 signals the caller's group); unreachable from the runbook's pgrep call sites
Final: minor (deferred): the future-crash test does not itself assert the seeded entry was carried (validity rests on the recorded RED run)
Final: review clean after corrective round 1
