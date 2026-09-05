---
id: fam-c5c263
title: Give Codex the same per-project familiar as every other surface
status: todo
priority: 2
size: l
created: 2026-09-05T10:19:59Z
updated: 2026-09-05T10:54:58Z
depends: []
tags: [integration, codex]
spec: docs/specs/2026-09-05-codex-identity-parity-design.md
---

Codex is the only surface Familiar does not render: it draws its own pet from a baked <repo>/.codex/config.toml that 'install pets --sync-projects' writes eagerly over an enumerated list (identities.yaml pins plus the current directory). That artifact has no invalidation and no coverage, so Codex and Claude Code disagree about a project's identity in two ways: stale configs when pins/theme/remote change, and — far more often — no config at all, falling through to the user-wide [tui] pet. Make the project config a derived, self-maintaining artifact resolved from the same inputs as every other surface, and give the no-project case an honest fallback instead of a real member. See the design doc for the ordering constraint that shapes the solution.

## Notes

- 2026-09-05T10:35:34Z (codex-identity-parity): design reviewed 2026-09-05; all five findings confirmed against code and machine. Reworked: single-root planner (planCodexProjectSync is machine-wide and aborts on an unrelated repo's unmanaged config), asset prerequisite + prune (install pets never prunes; 25 pet dirs for a 12-member theme), precedence caveat (nested .codex/config.toml and -c outrank the root file; guarantee narrowed to file agreement), behavioural verification for the hook-ordering question (Codex 0.153.4 documents no pre-config hook and no reload, so convergence-with-lag looks like the ceiling). Worktree pin inheritance was wrong in the first draft and is scoped out to fam-a940d1.
- 2026-09-05T10:54:58Z (codex-identity-parity): second review 2026-09-05; five more gaps, all confirmed, two of them defects in the first round's fixes. Pruning now bounded to stamped Familiar-owned dirs (CODEX_HOME/pets is shared; unstamped orphans reported not removed). Stamp reworked: theme receipts cannot establish freshness (local receipts carry no commit, absent receipts are normal, https receipts survive in-place art edits), so the stamp hashes compiler inputs via fnv1a32Bytes and the hook checks roster only, never content. Drift-report claim about catching beliefs withdrawn: current-pins-plus-cwd cannot discover a project that lost its pin; added a verified-on-read ledger as a discovery hint. Convergence table restated around turns, not launches, incl. launches that never take a turn. Neutral-pet alternative is a migration: 17 managed project configs outrank a user-wide setting, and it needs its own assets.
