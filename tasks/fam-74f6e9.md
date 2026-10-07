---
id: fam-74f6e9
title: Resolve project identity ownership and worktree pins
status: todo
priority: 2
size: m
complexity: high
process: planned
lane: true
created: 2026-10-07T13:05:24Z
updated: 2026-10-07T13:05:24Z
depends: []
tags: []
source: docs/notes/2026-10-07-project-identity-brief.md
agent: codex
---

Keep a project's familiar consistent across checkouts and hosts while preserving explicit visual choices. First milestone: establish how Git worktrees inherit pins and which pin fields belong in local storage; reuse ops-b31634 for the shared visual mapping question.

Members: fam-60d716, fam-a940d1, fam-a877b3. Handoff: docs/notes/2026-10-07-project-identity-brief.md. Existing fam-6e8321 owns relay presentation migration; this effort does not replace it.
