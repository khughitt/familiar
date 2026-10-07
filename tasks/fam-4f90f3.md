---
id: fam-4f90f3
title: Add a tested paired hook benchmark and run a pilot
status: todo
priority: 2
size: m
complexity: high
process: direct
created: 2026-10-07T15:10:56Z
updated: 2026-10-07T17:34:19Z
depends: [fam-9ab24c]
parent: fam-169e3f
tags: []
agent: codex
spec: docs/specs/2026-10-07-worktree-pin-inheritance-design.md
plan: docs/plans/2026-10-07-worktree-pin-inheritance.md
step: "Task 1: Add a tested paired hook benchmark and run a pilot"
---

Execute Task 1 of the reviewed plan after fam-9ab24c closes its review gate. Deliver a permanent paired-checkout just benchmark, measured-bin-relative CLI wrapper, regular suite/tool/recipe tests, and just installation and its check in the Ubuntu test job only. Run one pilot, measure added test-fast cost and attach raw pilot results immediately. No long-lived timing baseline and no product identity changes. Record the Task 1 code commit for Task 4 to hydrate as a detached baseline source.

## Notes

- 2026-10-07T17:34:19Z (design/worktree-identity): parked (waiting on user, session): User explicitly resumes execution; then agent hydrates .worktrees/worktree-identity, runs deferred baseline and starts this tested-tool/CI/pilot step. Plan is accepted; all execution is paused at user request.
  provenance: {"harness_session":"codex:01a1167e-58c0-7021-ac6d-a3f665af2bb3","harness_session_source":"CODEX_THREAD_ID"}
