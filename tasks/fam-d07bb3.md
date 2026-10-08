---
id: fam-d07bb3
title: Discover and propagate repository anchors safely
status: done
priority: 2
size: m
complexity: high
process: direct
owner: design/worktree-identity
created: 2026-10-07T15:11:15Z
updated: 2026-10-08T10:06:35Z
started: 2026-10-08T09:59:46Z
completed: 2026-10-08T10:06:35Z
depends: [fam-9ab24c, fam-4f90f3]
parent: fam-169e3f
tags: []
model: claude-opus-5-5
agent: codex
spec: docs/specs/2026-10-07-worktree-pin-inheritance-design.md
plan: docs/plans/2026-10-07-worktree-pin-inheritance.md
step: "Task 2: Discover and propagate repository anchors safely"
---

Execute Task 2 of the reviewed plan. Implement combined Git discovery with explicit unusual-path recovery, native bare partial-result regression in the normal suite, shared deadline, and atomic propagation to every production caller. Introduce the own-property guard and prove old-record fault/re-admission. Keep labels and installer targets at the actual checkout; inheritance matching follows in Task 3.

## Notes

- 2026-10-08T09:59:46Z (design/worktree-identity): started
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-08T10:06:35Z (design/worktree-identity): done
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-08T10:06:35Z (design/worktree-identity): gitContext returns {remote, repoRoot, repositoryRoot} under one 2s deadline (2 spawns main, 3 linked, framing fallback, bare exit-128 probe, core.worktree diagnostic); projectKeyFor keys on the anchor; CLI, transaction records and Codex planner carry it; resolveIdentities faults records lacking an own repositoryRoot
  provenance: {"harness_session":"claude-code:09674786-ee56-47f3-819c-1e7f778aad4c","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
