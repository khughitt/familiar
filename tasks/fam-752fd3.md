---
id: fam-752fd3
title: Report stale dependencies instead of failing with a module-resolution stack trace
status: todo
priority: 2
size: m
complexity: low
process: direct
created: 2026-10-16T18:38:02Z
updated: 2026-10-17T21:13:08Z
depends: []
parent: fam-ebff9c
tags: [hooks]
agent: claude-code/claude-opus-5
---

Why: when the installed `familiar-theme` does not match the one package.json and the lockfile pin, every familiar invocation dies at module load with a raw Node SyntaxError naming a missing export. As a SessionStart hook that surfaces to the user as 'hook error' plus a file:line, which says nothing about the actual cause or the fix.

Observed on europa, 2026-10-16: node_modules held familiar-theme v0.2.0 (installed Sep 8) while the dependency was bumped to v0.3.0 on 2026-10-14 (fe8ec93, a270ac4); src/theme/acquire.js imports packEntryRole and parseThemePack, which v0.2.0 does not export. `npm install` fixed it. Nothing had told the host its install was stale.

Established 2026-10-17 (scope):
- The seam exists. fb4b929 (2026-09-09) made bin/familiar and bin/familiar-opencode launchers that call requireDependencies() from src/deps.js before importing the CLI; it reports only a MISSING node_modules/<name>, never a stale one. Of the idea's two directions, a preflight there is chosen over a hook-level catch: it already runs on every hook, and a catch after the failed import cannot tell staleness from any other load failure.
- The comparison is cheap. npm writes node_modules/.package-lock.json on every install; comparing its `packages["node_modules/<name>"]` entry with package-lock.json's for each direct dependency costs about 0.4 ms per run here (two ~50 KB JSON parses).
- `version` alone is not enough. On titan today the installed familiar-theme says 0.3.0, as the lockfile does, but its hidden-lockfile `resolved` is commit f1ec639 while package-lock.json pins the v0.3.0 tag at 4e876bc. Comparing `resolved` (and `version`) catches that; the check will fire on titan until `npm ci` is run there, which is intended.

Done:
1. requireDependencies also reports stale dependencies: for each name in package.json `dependencies`, the package-lock.json entry's `version` and `resolved` must equal node_modules/.package-lock.json's. On mismatch, one stderr line naming familiar, each stale dependency with installed and pinned versions (and short commits when only `resolved` differs), and `run \`npm ci --prefix <root>\``; exit 1. A missing hidden lockfile while node_modules exists is reported the same way (cannot verify; run npm ci), never skipped. Missing dependencies keep their current message. The launchers keep importing nothing but src/deps.js, and deps.js keeps to node: builtins.
2. test/deps.test.js covers: in sync; version differs; only resolved differs; hidden lockfile absent; missing still reported first.
3. A `just setup` recipe per the ops template (templates/justfile in ops: setup_cmd, recorded through tt), running `npm ci`, so a fresh worktree or a new host has a named hydration step; follow the template's work-link and Dropbox-ignore lines as ops-9c7dab's notes describe. That closes familiar's gap in ops-9c7dab's list (filed there, not here).

Where: src/deps.js, bin/familiar, bin/familiar-opencode, test/deps.test.js, justfile. Brief: docs/notes/2026-10-17-host-install-recovery-brief.md.
