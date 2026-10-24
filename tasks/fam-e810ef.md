---
id: fam-e810ef
title: "Coordinate Niri attribution, delivery and health"
status: blocked
priority: 2
size: l
complexity: high
process: direct
created: 2026-10-24T14:35:05Z
updated: 2026-10-24T15:20:52Z
depends: [fam-c58260]
parent: fam-9c8dd1
tags: []
source: "fam-9c8dd1:desktop-attention-plan"
agent: codex
spec: docs/specs/2026-10-24-desktop-attention-design.md
plan: docs/plans/2026-10-24-desktop-attention.md
step: "Task 4: Coordinate Niri attribution, notification delivery and health"
---

Implement this exact plan step only after the new implementation plan has passed its separate user-review gate. Start/arm the task in the retained worktree; preserve the shared interfaces, accepted attribution limits, tests and external activation gates. Execution Setup runs the full-suite baseline before product changes. No live desktop/config activation is authorized.

## Notes

- 2026-10-24T14:35:07Z (feat/desktop-attention): Implementation plan awaits its separate user review; after acceptance the controller unblocks this step and runs execution Setup before code.
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T15:20:52Z (feat/desktop-attention): Plan review requires a separate lock-free immediate topology feed, 100 ms deterministic event-to-widget budget with explicit I/O assumptions, no focus-only presentation lock when no seen state changes, and a bounded Niri socket action by stable workspace ID. New tests cover unfocused-monitor clicks, an older in-flight topology write, and topology/heartbeat continuing through a held presentation lock. Child remains blocked pending revised plan review.
