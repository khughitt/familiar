---
id: fam-752fd3
title: Report stale dependencies instead of failing with a module-resolution stack trace
status: idea
priority: 2
created: 2026-10-16T18:38:02Z
updated: 2026-10-16T18:38:02Z
depends: []
tags: [hooks]
agent: claude-code/claude-opus-5
---

When the installed `familiar-theme` does not match the one package.json and the lockfile pin, every familiar invocation dies at module load with a raw Node SyntaxError naming a missing export. As a SessionStart hook that surfaces to the user as 'hook error' plus a file:line, which says nothing about the actual cause or the fix.

Observed on europa, 2026-10-16: node_modules held familiar-theme v0.2.0 (installed Sep 8) while the dependency was bumped to v0.3.0 on 2026-10-14; src/theme/acquire.js imports packEntryRole and parseThemePack, which v0.2.0 does not export. `npm install` fixed it. Nothing had told the host its install was stale.

Two directions, not yet chosen: a cheap preflight at CLI entry that compares the installed dependency against the lockfile and exits with 'run npm install' (must stay cheap — this runs on every hook), or a hook-level catch that turns a module-resolution failure into one actionable line. Either way the hook should fail loudly and legibly rather than leaking a stack trace.

Related: familiar has no `just setup` recipe, so a fresh worktree or a new host has no named hydration step; ops-9c7dab tracks that across projects and does not yet list this one.
