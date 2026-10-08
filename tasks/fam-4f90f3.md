---
id: fam-4f90f3
title: Add a tested paired hook benchmark and run a pilot
status: done
priority: 2
size: m
complexity: high
process: direct
owner: design/worktree-identity
created: 2026-10-07T15:10:56Z
updated: 2026-10-08T09:59:10Z
started: 2026-10-08T09:47:03Z
completed: 2026-10-08T09:57:52Z
depends: [fam-9ab24c]
parent: fam-169e3f
tags: []
model: claude-opus-5-5
agent: codex
spec: docs/specs/2026-10-07-worktree-pin-inheritance-design.md
plan: docs/plans/2026-10-07-worktree-pin-inheritance.md
step: "Task 1: Add a tested paired hook benchmark and run a pilot"
---

Execute Task 1 of the reviewed plan after fam-9ab24c closes its review gate. Deliver a permanent paired-checkout just benchmark, measured-bin-relative CLI wrapper, regular suite/tool/recipe tests, and just installation and its check in the Ubuntu test job only. Run one pilot, measure added test-fast cost and attach raw pilot results immediately. No long-lived timing baseline and no product identity changes. Record the Task 1 code commit for Task 4 to hydrate as a detached baseline source.

## Notes

- 2026-10-07T17:34:19Z (design/worktree-identity): parked (waiting on user, session): User explicitly resumes execution; then agent hydrates .worktrees/worktree-identity, runs deferred baseline and starts this tested-tool/CI/pilot step. Plan is accepted; all execution is paused at user request.
  provenance: {"harness_session":"codex:01a1167e-58c0-7021-ac6d-a3f665af2bb3","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-08T09:47:03Z (design/worktree-identity): started
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-08T09:57:43Z (design/worktree-identity): attached: report.json (11400 bytes): Paired benchmark pilot; tool proof, not latency acceptance
- 2026-10-08T09:57:43Z (design/worktree-identity): pilot: just bench-hook pilot <this checkout> x2, 1 sample/0 warm-ups/1 pair; 4 batches proved working agent+intent, 2 Git spawns per hook in every source/context, tt rows bench-hook-{main,linked}-{baseline,candidate} exit 0. Tool proof only, not a latency baseline. test-fast: 1028 pass/5 skip, 17.1s wall (setup baseline 1013/5, 19.6s); the recipe smoke costs ~1.4s inside the parallel run.
- 2026-10-08T09:57:52Z (design/worktree-identity): done
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-08T09:57:52Z (design/worktree-identity): Paired hook benchmark: tools/bench-hook.mjs controller/worker, measured-bin wrapper, shared real-Git fixtures, just bench-hook recipe, setup-just in the Ubuntu test job, 13 suite tests; pilot attached (tool proof only)
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-08T09:59:09Z (design/worktree-identity): detached: report.json: superseded: report carried machine paths the commit gate refuses; tool now writes portable reports, pilot rerun
- 2026-10-08T09:59:10Z (design/worktree-identity): attached: pilot-report.json (10879 bytes): Paired benchmark pilot; tool proof, not latency acceptance
