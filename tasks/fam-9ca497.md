---
id: fam-9ca497
title: Reconcile the graphics reference's self-date with its content
status: done
priority: 3
size: xs
complexity: low
process: direct
owner: docs/relay-cutover
created: 2026-10-25T01:01:24Z
updated: 2026-10-25T02:12:52Z
started: 2026-10-25T02:04:50Z
completed: 2026-10-25T02:11:50Z
closed: 2026-10-25T02:11:50Z
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
- 2026-10-25T02:10:49Z (docs/relay-cutover): attached: docs-review-report.md (2867 bytes): Read-only whole-branch review of fc1043d; codex/gpt-6.1-sol accepted with no findings
- 2026-10-25T02:10:51Z (docs/relay-cutover): attached: review-ledger.md (1147 bytes): Controller rulings on the three review scope exclusions; no deferred minors
- 2026-10-25T02:11:39Z (docs/relay-cutover): Verification: post-edit just test-fast ran 1336 tests (1331 passed, 5 skipped), including the documentation-reading CLI test; just check, tasks check and git diff --check passed with zero warnings. Full baseline just test also passed (1331 fast plus 10 slow passed, 5 skipped). Full review and scope rulings attached and byte-verified; temporary review workspace copies removed. No task scratch or off-tree evidence retained.
- 2026-10-25T02:11:41Z (docs/relay-cutover): retained: {"host":"titan","kind":"worktree","path":".worktrees/docs-relay-cutover","state":"kept","verification":"verified","purpose":"Immediate local merge to main and checked removal in this closing session; ignored node_modules is regenerable, review report and ledger are attached to all three tasks","next_owner":"session:codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","cleanup_trigger":"After local merge succeeds, verify clean Git state and no host pointers, then remove this worktree in the current turn"}
- 2026-10-25T02:11:50Z (docs/relay-cutover): done
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:11:50Z (docs/relay-cutover): Removed the misleading whole-reference self-date without asserting the graphics reference body is current.
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:12:52Z (main): retained: {"host":"titan","kind":"worktree","path":".worktrees/docs-relay-cutover","state":"released","verification":"verified","purpose":"Merged locally into main at 7a8088e; post-merge just check passed and all non-task files match the tested branch. tt-report ran; Git clean, no submodules or host pointers. Discarded regenerable node_modules; full review and ledger preserved in verified task attachments. Worktree and merged branch removed.","next_owner":"none","cleanup_trigger":"none"}
