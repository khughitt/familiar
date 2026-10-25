---
id: fam-9ca497
title: Reconcile the graphics reference's self-date with its content
status: doing
priority: 3
size: xs
complexity: low
process: direct
owner: docs/relay-cutover
created: 2026-10-25T01:01:24Z
updated: 2026-10-25T02:10:29Z
started: 2026-10-25T02:04:50Z
depends: []
tags: [docs]
source: fam-3f208e
agent: codex
---

Only the self-date was judged; the document body was outside this pass's 800-line reference budget. docs/ref/kitty-graphics-protocol.md line 3 says Current as of 2026-07-17, while d597b27 (2026-09-18) substantively replaced its tmux-rejection text with the implemented passthrough probe, per-command wrapping and buffer limit. Remove the misleading whole-document self-date or scope and refresh it after reviewing the text it purports to date. Do not mark the entire reference current based on this date-only finding. Finding: rubric v2 criterion 10 at reviewed commit 745b291; the next curation pass must read this previously unread guide before returning to the README-first order.

## Notes

- 2026-10-25T02:04:50Z (main): started
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:05:25Z (docs/relay-cutover): resumed
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:07:15Z (docs/relay-cutover): Scope: remove only the misleading whole-reference self-date; no claim that the graphics reference body was revalidated. Shared worktree .worktrees/docs-relay-cutover; hydrated with npm ci and pinned Luau fetch. Baseline just test: fast 1336 tests (1331 passed, 5 skipped), slow 10 passed, zero failures.
- 2026-10-25T02:10:29Z (docs/relay-cutover): review: impl round 1 — verdict: accept; findings: none; reviewer: codex/gpt-6.1-sol
