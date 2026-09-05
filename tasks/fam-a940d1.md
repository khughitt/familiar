---
id: fam-a940d1
title: Decide whether a worktree inherits its parent checkout's identity pin
status: idea
priority: 2
created: 2026-09-05T10:35:25Z
updated: 2026-09-05T10:35:25Z
depends: []
tags: [identity, pins]
---

matchPin (src/bus/pins.js) compares a path: pin to repoRoot by exact canonical equality, with no ancestry, so a pinned project's worktrees do not match its pin and fall through to autoSlot. Confirmed live: niri-material is pinned to slot 7 (chartreux) while .worktrees/glass-noise-saturation and .worktrees/ring-light-design both resolve to slot 11 (odd-eyed-white). Two related exceptions: a project: pin matches basename(repoRoot), which differs per worktree, and a repository with no remote has projectKey = repoRoot, so parent and worktree do not even share a key. So 'one project, one familiar' is already false on Familiar's own surfaces, with no Codex involved. Decide whether inheritance is wanted; if it is, path pins would resolve by ancestry, which touches the identity core and every surface. Scoped out of fam-c5c263 (see docs/specs/2026-09-05-codex-identity-parity-design.md section 6.2).
