---
id: fam-f3d48e
title: Verify shared surfaces and accept hook latency
status: done
priority: 2
size: m
complexity: mid
process: direct
owner: design/worktree-identity
created: 2026-10-07T15:11:42Z
updated: 2026-10-08T10:31:03Z
started: 2026-10-08T10:10:10Z
completed: 2026-10-08T10:31:03Z
depends: [fam-9ab24c, fam-449468]
parent: fam-169e3f
tags: []
model: claude-opus-5-5
agent: codex
spec: docs/specs/2026-10-07-worktree-pin-inheritance-design.md
plan: docs/plans/2026-10-07-worktree-pin-inheritance.md
step: "Task 4: Verify shared surfaces and accept hook latency"
---

Execute Task 4 of the reviewed plan. Verify real-worktree CLI/bus/Codex parity and shared idempotent exclusions. Create a separately hydrated detached baseline checkout at Task 1 commit and measure it against current code by explicit bin paths in one same-sitting, counterbalanced paired run. Current wrapper patches proc relative to each measured bin. Attach raw evidence immediately; record an evidence-backed timing disposition without a historical-baseline threshold. Update docs, run final fresh review/corrective rounds and integrate locally when settled. No external publication or live host wiring.

## Notes

- 2026-10-07T17:32:49Z (design/worktree-identity): plan correction: Task 4 documentation must update the current spec Latency acceptance section to the approved paired same-sitting protocol, removing separated-run/baseline-variation wording. User accepted plan and paused all execution; do not start until explicit resume.
- 2026-10-08T10:10:10Z (design/worktree-identity): started
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-08T10:13:44Z (design/worktree-identity): aux baseline: .worktrees/identity-benchmark-baseline detached at 437aa7e (Task 1 commit), locked; hydrated with npm ci from inside the checkout (npm --prefix through the .worktrees symlink rewrote every lock key as a file: link; restored, reinstalled, lock unchanged; lock hash equals candidate's). No launcher or node_modules shared.
- 2026-10-08T10:13:51Z (design/worktree-identity): attached: compare-pilot-report.json (11826 bytes): One-pair compare pilot (1 sample, 0 warm-ups): every gate exercised; not latency evidence
- 2026-10-08T10:20:11Z (design/worktree-identity): attached: latency-compare-report.json (546967 bytes): Complete paired latency comparison: baseline 437aa7e vs candidate aecce62, 30 samples/5 warm-ups/4 pairs, main + linked
- 2026-10-08T10:20:11Z (design/worktree-identity): run: 1.5 min (est 2, none); compare 86s; passed
- 2026-10-08T10:20:11Z (design/worktree-identity): latency: accepted. Paired same-sitting compare 437aa7e→aecce62 (30/5/4, fresh fixture, Linux, Node v26.5.0, load ~5 from another session's test suite; its tracy captures were waited out first). Structural: pass — Git spawns 2/2 baseline, 2/3 candidate, no worktree listing. main: baseline 146.71 ms median (p95 160.20), candidate 146.59 (p95 166.66); paired deltas +2.50/-4.69/+5.72/-1.08 ms, median +0.71 ms (+0.5%), by order +4.11 (baseline-first) vs -2.88 (candidate-first): sign follows order, no consistent slowdown; per-hook Git time unchanged (~10 ms). linked: baseline 147.62 (p95 174.92), candidate 148.85 (p95 165.26); deltas +5.68/+2.32/-6.42/+2.41, median +2.36 ms (+1.6%); probe median 3.44 ms (p95 4.38) and per-hook Git time ~9.6→~13 ms, so the overhead is the extra verification spawn, within pair-to-pair spread (~±6 ms). p95 tails track host outliers (258 ms baseline max), not a version. Boundary: one hook process through the bench wrapper, real Git, fixture process lookup, private pipe; no live-agent or Darwin claim.
- 2026-10-08T10:31:03Z (design/worktree-identity): done
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-08T10:31:03Z (design/worktree-identity): Worktree surfaces verified (installer per-worktree target + shared idempotent exclusion, bulk planner without sibling discovery, convergence, whoami/projects/hook parity); latency accepted from a paired same-sitting compare (main +0.7 ms, linked +2.4 ms vs 3.4 ms probe); docs, spec status/latency protocol and §6.2 addendum updated; Git 2.31 floor named
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
