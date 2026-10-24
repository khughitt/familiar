---
id: fam-4796ce
title: Build the native Noctalia workspace consumer
status: done
priority: 2
size: l
complexity: high
process: direct
owner: feat/desktop-attention
created: 2026-10-24T14:35:12Z
updated: 2026-10-24T18:49:49Z
started: 2026-10-24T18:08:33Z
completed: 2026-10-24T18:49:49Z
closed: 2026-10-24T18:49:49Z
depends: [fam-e810ef]
parent: fam-9c8dd1
tags: []
source: "fam-9c8dd1:desktop-attention-plan"
agent: codex
spec: docs/specs/2026-10-24-desktop-attention-design.md
plan: docs/plans/2026-10-24-desktop-attention.md
step: "Task 6: Build the native Noctalia workspace consumer"
---

Implement this exact plan step only after the new implementation plan has passed its separate user-review gate. Start/arm the task in the retained worktree; preserve the shared interfaces, accepted attribution limits, tests and external activation gates. Execution Setup runs the full-suite baseline before product changes. No live desktop/config activation is authorized.

## Notes

- 2026-10-24T14:35:13Z (feat/desktop-attention): Implementation plan awaits its separate user review; after acceptance the controller unblocks this step and runs execution Setup before code.
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T15:20:54Z (feat/desktop-attention): Plan review requires direct Niri polling fallback for navigation during coordinator/feed failure, real pinned Luau 0.743 contract execution for every production entry/callback, 16 ms finite arrivals followed by 200 ms sustained pulse and 2000 ms static cadence, and an independent live Noctalia DND query before health notices. Child remains blocked pending revised plan review.
- 2026-10-24T16:20:59Z (feat/desktop-attention): Accepted plan d1776d0, round-3 minor (deferred) M1: cite and verify the pinned Noctalia 5.3 Luau runAsync timeout binding for fallback, DND and focus calls, or implement an explicit bounded result policy and late-callback guard without silently overlapping live queries. Candidate binding source is retained under the parent evidence record; docs/binary strings alone are not proof. This does not block execution Setup; no live plugin/gesture/notification use is authorized.
- 2026-10-24T18:08:33Z (feat/desktop-attention): started
  provenance: {"harness_session":"claude-code:bb2801be-ba4f-4fd5-b4f1-81c6742ca304","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-24T18:49:49Z (feat/desktop-attention): done
  provenance: {"harness_session":"claude-code:bb2801be-ba4f-4fd5-b4f1-81c6742ca304","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-24T18:49:49Z (feat/desktop-attention): Noctalia plugin (manifest, service, widget, panel, presentation) with Luau 0.743 contract tests; lint clean; just test-fast 1282 pass/0 fail.
  provenance: {"harness_session":"claude-code:bb2801be-ba4f-4fd5-b4f1-81c6742ca304","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
