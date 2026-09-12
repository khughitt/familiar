---
id: fam-2bd19b
title: Test + CI iteration cost audit
status: doing
priority: 2
size: m
complexity: mid
owner: test-ci-audit
created: 2026-09-04T21:44:54Z
updated: 2026-09-12T16:42:30Z
depends: [ops-31f038]
tags: [testing]
---

Piece of ops-65837b (the cross-project audit in the ops hub). 1. Measure: full-suite wall time, and roughly how often agent full-suite runs fail here. 2. Add a fast or affected-only test target for the inner loop and point AGENTS.md at it; keep the full suite for commit and CI. 3. Use a quiet reporter so test output does not flood agent context. 4. Fix suite hygiene: sleeps, real network, unshared fixtures. Record the before and after numbers in a note on this task.

## Notes

- 2026-09-05T02:38:40Z (main): design: ops docs/specs/2026-09-04-test-ci-audit-design.md; follow §5: (1) justfile + vendored tools/tt, route existing hooks, CI, and documented test commands through it, verify a line lands under each agent; (2) after a week of runs, add a note reading 'baseline <date>: <tt-report --project numbers>'; (3) gates to §4.6, AGENTS.md line, hygiene; (4) close with before/after numbers
- 2026-09-05T09:07:17Z (test-ci-audit): step 1 (instrument, no policy change): justfile front door, vendored tools/tt, .githooks + core.hooksPath, CI and the documented test commands routed through tt; measured full suite 859 tests, ~10.1s median wall, 0 failures; verified one line each under claude (shared log), codex (worktree .tt fallback, harvested), and by hand
- 2026-09-12T16:42:30Z (main): Complexity mid: read the ops test/CI audit design and prior instrumentation evidence; justfile, tools/tt, hooks and CI wiring exist, and fast currently selects the full non-slow suite. Remaining baseline/after measurements, gate/reporting choices and evidence-directed hygiene are bounded investigation under the existing design, not a new architecture.
