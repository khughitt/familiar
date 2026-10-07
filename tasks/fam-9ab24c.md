---
id: fam-9ab24c
title: Design worktree pin inheritance from the brief
status: doing
priority: 2
size: m
complexity: high
process: planned
owner: design/worktree-identity
created: 2026-10-07T13:05:48Z
updated: 2026-10-07T13:39:44Z
started: 2026-10-07T13:21:16Z
depends: []
parent: fam-74f6e9
tags: []
source: docs/notes/2026-10-07-project-identity-brief.md
agent: codex
spec: docs/specs/2026-10-07-worktree-pin-inheritance-design.md
---

Why: fam-a940d1 shows path pins, project-name pins and remote-less project keys diverging between a checkout and its worktrees. Filesystem ancestry is insufficient when .worktrees is a symlink to external storage.
Outcome: A reviewed design and implementation plan for the smallest consistent worktree identity rule, starting from docs/notes/2026-10-07-project-identity-brief.md and docs/specs/2026-09-05-codex-identity-parity-design.md section 6.2.
Current lean: inherit through Git repository/worktree metadata; preserve exact-worktree overrides and remote > path > project specificity. Resolve conflicts, bare repositories, remote-less keys and labels explicitly before implementation.
Where to look: src/bus/{identity,pins,resolve,transaction}.js, bin/familiar.js identityResolver, src/install/codex.js; test/{identity,pins,resolve,transaction,install-codex-single}.test.js. Coordinate the context boundary with fam-6e8321; do not duplicate relay migration.
Done: Design and plan reviewed, with concrete checks for in-tree and external/symlinked worktrees, unrelated nested repos, explicit overrides, no remote, every pin form and shared surface resolution; retain bounded Git subprocesses. No live host wiring.
On completion, run tasks note on fam-a940d1 with the agreed contract in the same commit as the design result, and update the brief.

## Notes

- 2026-10-07T13:21:16Z (main): started
  provenance: {"harness_session":"codex:01a1167e-58c0-7021-ac6d-a3f665af2bb3","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-07T13:21:18Z (design/worktree-identity): resumed
  provenance: {"harness_session":"codex:01a1167e-58c0-7021-ac6d-a3f665af2bb3","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-07T13:24:26Z (design/worktree-identity): upstream check: searched Git/GitGitGadget issue/PR history and lore for worktree list + separate-git-dir; inspected Git master and next worktree.c get_main_worktree and 2.54–2.56 release notes. Both branches derive the first path from common-dir and strip /.git; no correcting release found in those notes. Source: https://github.com/git/git/blob/master/worktree.c and https://github.com/git/git/blob/next/worktree.c. Temporary fixtures on Git 2.56.0 show separate metadata reported as main even with core.worktree set; design will verify rather than trust that path. No upstream post or patch.
- 2026-10-07T13:26:32Z (design/worktree-identity): upstream search result: Git/GitGitGadget searches across issue/PR states returned no matching issue or list/core.worktree fix. Related open https://github.com/git/git/pull/2208 adds repo info path keys, not a correction to get_main_worktree; not a fixing commit to pin. Choose a verified local discovery rule, no Git patch/dependency change; prepare a report for review without publishing.
- 2026-10-07T13:28:59Z (design/worktree-identity): design: drafted Git-based repositoryRoot with remote > exact checkout path > inherited repository path > exact checkout name > inherited repository name; retain current labels, unify remote-less keys, keep installer targets at actual repoRoot. Includes verified/bare/separated-directory anchors, shared two-second Git deadline, transient-record transition, relay boundary and concrete checks. Spec awaits self-review and user review; no product code or dependencies changed.
- 2026-10-07T13:37:14Z (design/worktree-identity): review: spec round 1 — verdict: revise; findings: Important 1; reviewer: codex (inheritance_spec_review)
- 2026-10-07T13:38:06Z (design/worktree-identity): Ruling: accept Important spec finding. Narrowed implicit-root support to conventional main/.git; separated linked metadata requires core.worktree. Explicitly disclosed that undeclared separated store/.git cannot reliably error or establish original main identity. Follow-up temporary fixture reproduced that ambiguity and declaration recovery; no registry/scan added. Other review exclusions accepted: unwritten implementation, host rollout and upstream publication are outside this draft. No minor (deferred) findings.
- 2026-10-07T13:39:42Z (design/worktree-identity): review: spec round 2 — verdict: accept; findings: none; reviewer: codex
- 2026-10-07T13:39:42Z (design/worktree-identity): Ruling: fresh scoped re-review accepts the support-boundary correction with no findings. Self-review checked placeholders, consistency, scope, existing file paths and acceptance coverage. Product implementation and suite readiness remain outside the draft; no minor (deferred) findings. Git report reproduction and trap cleanup passed; report remains unpublished.
- 2026-10-07T13:39:42Z (design/worktree-identity): parked (waiting on user, review): User reviews docs/specs/2026-10-07-worktree-pin-inheritance-design.md in .worktrees/worktree-identity; after approval, agent resumes here and writes the implementation plan for its separate review. Storage investigation is merged; no product code or host wiring changed.
  provenance: {"harness_session":"codex:01a1167e-58c0-7021-ac6d-a3f665af2bb3","harness_session_source":"CODEX_THREAD_ID"}
