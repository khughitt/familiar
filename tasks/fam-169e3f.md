---
id: fam-169e3f
title: Implement reviewed worktree pin inheritance
status: todo
priority: 2
size: m
complexity: high
process: planned
created: 2026-10-07T14:55:59Z
updated: 2026-10-07T16:05:07Z
depends: [fam-9ab24c]
parent: fam-74f6e9
tags: []
agent: codex
spec: docs/specs/2026-10-07-worktree-pin-inheritance-design.md
plan: docs/plans/2026-10-07-worktree-pin-inheritance.md
---

Implement the approved worktree identity contract through docs/plans/2026-10-07-worktree-pin-inheritance.md. Spec approved by user at 842c20d; plan review is still required. Preserve remote > path > project, exact worktree overrides, shared remote-less keys, labels, bounded Git discovery, runtime-record fault/recovery and current Codex exclusion behavior. Includes a tested permanent hook benchmark and before/after latency evidence. No live host wiring or upstream publication. Execution steps stay blocked on fam-9ab24c until the design and written plan are reviewed.

## Notes

- 2026-10-07T16:05:07Z (design/worktree-identity): plan: four serial steps recorded under docs/plans/2026-10-07-worktree-pin-inheritance.md: fam-4f90f3 benchmark/baseline; fam-d07bb3 anchors/propagation/old-record guard; fam-449468 pin tiers; fam-f3d48e surfaces/latency/final review. Spec approved; plan awaiting user review. Recommend native inline execution. Steps depend on fam-9ab24c completion and their predecessor; no implementation started.
