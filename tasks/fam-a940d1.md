---
id: fam-a940d1
title: Decide whether a worktree inherits its parent checkout's identity pin
status: idea
priority: 2
created: 2026-09-05T10:35:25Z
updated: 2026-10-07T17:32:50Z
depends: [fam-9ab24c]
parent: fam-74f6e9
tags: [identity, pins]
---

matchPin (src/bus/pins.js) compares a path: pin to repoRoot by exact canonical equality, with no ancestry, so a pinned project's worktrees do not match its pin and fall through to autoSlot. Confirmed live: niri-material is pinned to slot 7 (chartreux) while .worktrees/glass-noise-saturation and .worktrees/ring-light-design both resolve to slot 11 (odd-eyed-white). Two related exceptions: a project: pin matches basename(repoRoot), which differs per worktree, and a repository with no remote has projectKey = repoRoot, so parent and worktree do not even share a key. So 'one project, one familiar' is already false on Familiar's own surfaces, with no Codex involved. Decide whether inheritance is wanted; if it is, path pins would resolve by ancestry, which touches the identity core and every surface. Scoped out of fam-c5c263 (see docs/specs/2026-09-05-codex-identity-parity-design.md section 6.2).

## Notes

- 2026-10-07T13:06:41Z (main): scope: briefed; retained idea; fam-9ab24c owns Git-based worktree inheritance design, including overrides and remote-less identity; directory ancestry is insufficient for external worktrees; brief: docs/notes/2026-10-07-project-identity-brief.md
- 2026-10-07T17:32:50Z (design/worktree-identity): finding: user approved Git-based repository anchor spec and implementation plan. Remote > exact checkout path > inherited repository path > exact checkout name > inherited name; current labels retained, remote-less keys shared, own-field guard faults old records, Codex exclusions stay shared. Artifacts: docs/specs/2026-10-07-worktree-pin-inheritance-design.md and docs/plans/2026-10-07-worktree-pin-inheritance.md. Implementation goal fam-169e3f is explicitly paused before execution; no code or host wiring changed.
