---
id: fam-2bd19b
title: Test + CI iteration cost audit
status: doing
priority: 2
size: m
complexity: mid
process: direct
owner: test-ci-audit
created: 2026-09-04T21:44:54Z
updated: 2026-09-28T10:26:53Z
depends: [ops-31f038]
tags: [testing]
---

Piece of ops-65837b (the cross-project audit in the ops hub). 1. Measure: full-suite wall time, and roughly how often agent full-suite runs fail here. 2. Add a fast or affected-only test target for the inner loop and point AGENTS.md at it; keep the full suite for commit and CI. 3. Use a quiet reporter so test output does not flood agent context. 4. Fix suite hygiene: sleeps, real network, unshared fixtures. Record the before and after numbers in a note on this task.

## Notes

- 2026-09-05T02:38:40Z (main): design: ops docs/specs/2026-09-04-test-ci-audit-design.md; follow §5: (1) justfile + vendored tools/tt, route existing hooks, CI, and documented test commands through it, verify a line lands under each agent; (2) after a week of runs, add a note reading 'baseline <date>: <tt-report --project numbers>'; (3) gates to §4.6, AGENTS.md line, hygiene; (4) close with before/after numbers
- 2026-09-05T09:07:17Z (test-ci-audit): step 1 (instrument, no policy change): justfile front door, vendored tools/tt, .githooks + core.hooksPath, CI and the documented test commands routed through tt; measured full suite 859 tests, ~10.1s median wall, 0 failures; verified one line each under claude (shared log), codex (worktree .tt fallback, harvested), and by hand
- 2026-09-12T16:42:30Z (main): Complexity mid: read the ops test/CI audit design and prior instrumentation evidence; justfile, tools/tt, hooks and CI wiring exist, and fast currently selects the full non-slow suite. Remaining baseline/after measurements, gate/reporting choices and evidence-directed hygiene are bounded investigation under the existing design, not a new architecture.
- 2026-09-17T00:51:35Z (main): Tracker check during relay scheduling found the missing process field. Set direct from the existing 2026-09-12 assessment: remaining bounded baseline/after measurements and hygiene follow the already adopted ops audit design; no new design decision or implementation performed here.
- 2026-09-28T08:34:21Z (main): baseline 2026-09-28 (tt-report --project fam --since 2026-09-05 --until 2026-09-24; 15 active days, before step 3): test 32 runs median 14.4s p90 19.5s fail 0.19, 7 min total; test-fast 7 runs median 14.1s p90 16.1s fail 0.00, 2 min total; check 35 runs median 0.1s p90 0.1s fail 0.00, 0 min total; hook-pre-commit 112 runs median 0.1s p90 0.2s fail 0.00, 0 min total; hook-pre-push 7 runs median 10.4s p90 14.4s fail 0.14, 1 min total; front-door total 0.17 h (1 min per active day), ad-hoc targets 0 min; fast/full by agents 0.19; bypasses 50
- 2026-09-28T08:34:43Z (main): Baseline window 2026-09-05..09-24 closes the day before ops host-budget worker sizing (09-25), the first timing change after step 1; no step-3 change had landed. Front-door total counts wrapper seconds of test, test-fast, check and both hooks. Next: step 3 (gates to ops design §4.6, the AGENTS.md inner-loop line, hygiene the numbers point at), then an after-window read with tt-report --since/--until.
- 2026-09-28T10:26:53Z (main): Step 3 now follows ops docs/specs/2026-09-28-test-ci-act-design.md: copy templates/justfile's test-one, docs_paths/docs_check_cmd/hook-pre-commit-docs, ci_suite_refs/ci_remote/push_fast_cmd/hook-pre-push-fast and both templates/githooks; set ci_suite_refs from the refs CI actually runs the full suite for (say which in a note); add the AGENTS.md Gates line (templates/AGENTS.md). Then the after-window against this piece's baseline note.
