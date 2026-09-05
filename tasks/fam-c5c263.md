---
id: fam-c5c263
title: Give Codex the same per-project familiar as every other surface
status: todo
priority: 2
size: l
created: 2026-09-05T10:19:59Z
updated: 2026-09-05T10:21:16Z
depends: []
tags: [integration, codex]
spec: docs/specs/2026-09-05-codex-identity-parity-design.md
---

Codex is the only surface Familiar does not render: it draws its own pet from a baked <repo>/.codex/config.toml that 'install pets --sync-projects' writes eagerly over an enumerated list (identities.yaml pins plus the current directory). That artifact has no invalidation and no coverage, so Codex and Claude Code disagree about a project's identity in two ways: stale configs when pins/theme/remote change, and — far more often — no config at all, falling through to the user-wide [tui] pet. Make the project config a derived, self-maintaining artifact resolved from the same inputs as every other surface, and give the no-project case an honest fallback instead of a real member. See the design doc for the ordering constraint that shapes the solution.
