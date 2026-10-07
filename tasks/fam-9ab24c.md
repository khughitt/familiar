---
id: fam-9ab24c
title: Design worktree pin inheritance from the brief
status: todo
priority: 2
size: m
complexity: high
process: planned
created: 2026-10-07T13:05:48Z
updated: 2026-10-07T13:05:48Z
depends: []
parent: fam-74f6e9
tags: []
source: docs/notes/2026-10-07-project-identity-brief.md
agent: codex
---

Why: fam-a940d1 shows path pins, project-name pins and remote-less project keys diverging between a checkout and its worktrees. Filesystem ancestry is insufficient when .worktrees is a symlink to external storage.
Outcome: A reviewed design and implementation plan for the smallest consistent worktree identity rule, starting from docs/notes/2026-10-07-project-identity-brief.md and docs/specs/2026-09-05-codex-identity-parity-design.md section 6.2.
Current lean: inherit through Git repository/worktree metadata; preserve exact-worktree overrides and remote > path > project specificity. Resolve conflicts, bare repositories, remote-less keys and labels explicitly before implementation.
Where to look: src/bus/{identity,pins,resolve,transaction}.js, bin/familiar.js identityResolver, src/install/codex.js; test/{identity,pins,resolve,transaction,install-codex-single}.test.js. Coordinate the context boundary with fam-6e8321; do not duplicate relay migration.
Done: Design and plan reviewed, with concrete checks for in-tree and external/symlinked worktrees, unrelated nested repos, explicit overrides, no remote, every pin form and shared surface resolution; retain bounded Git subprocesses. No live host wiring.
On completion, run tasks note on fam-a940d1 with the agreed contract in the same commit as the design result, and update the brief.
