---
id: fam-fa17bb
title: Verify the attention pipeline and prepare gated rollout
status: todo
priority: 2
size: m
complexity: high
process: direct
created: 2026-10-24T14:35:15Z
updated: 2026-10-24T16:21:42Z
depends: [fam-f34642, fam-4796ce]
parent: fam-9c8dd1
tags: []
source: "fam-9c8dd1:desktop-attention-plan"
agent: codex
spec: docs/specs/2026-10-24-desktop-attention-design.md
plan: docs/plans/2026-10-24-desktop-attention.md
step: "Task 7: Verify the complete pipeline and prepare gated rollout"
---

Implement this exact plan step only after the new implementation plan has passed its separate user-review gate. Start/arm the task in the retained worktree; preserve the shared interfaces, accepted attribution limits, tests and external activation gates. Execution Setup runs the full-suite baseline before product changes. No live desktop/config activation is authorized.

## Notes

- 2026-10-24T14:35:17Z (feat/desktop-attention): Implementation plan awaits its separate user review; after acceptance the controller unblocks this step and runs execution Setup before code.
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T16:21:04Z (feat/desktop-attention): Accepted plan d1776d0, round-3 minor (deferred) M2: add click-to-focus to native pilot measurements, separately from event-to-widget latency and its 100 ms budget; report startup/socket/focus behavior without claiming builtin-like response from the topology metric. The pilot still requires fresh live desktop approval. Both plan-round-3 minors and spec-round-7 M1 must retain explicit dispositions through final review/rollout.
