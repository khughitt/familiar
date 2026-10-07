---
id: fam-f3d48e
title: Verify shared surfaces and accept hook latency
status: todo
priority: 2
size: m
complexity: mid
process: direct
created: 2026-10-07T15:11:42Z
updated: 2026-10-07T17:32:49Z
depends: [fam-9ab24c, fam-449468]
parent: fam-169e3f
tags: []
agent: codex
spec: docs/specs/2026-10-07-worktree-pin-inheritance-design.md
plan: docs/plans/2026-10-07-worktree-pin-inheritance.md
step: "Task 4: Verify shared surfaces and accept hook latency"
---

Execute Task 4 of the reviewed plan. Verify real-worktree CLI/bus/Codex parity and shared idempotent exclusions. Create a separately hydrated detached baseline checkout at Task 1 commit and measure it against current code by explicit bin paths in one same-sitting, counterbalanced paired run. Current wrapper patches proc relative to each measured bin. Attach raw evidence immediately; record an evidence-backed timing disposition without a historical-baseline threshold. Update docs, run final fresh review/corrective rounds and integrate locally when settled. No external publication or live host wiring.

## Notes

- 2026-10-07T17:32:49Z (design/worktree-identity): plan correction: Task 4 documentation must update the current spec Latency acceptance section to the approved paired same-sitting protocol, removing separated-run/baseline-variation wording. User accepted plan and paused all execution; do not start until explicit resume.
