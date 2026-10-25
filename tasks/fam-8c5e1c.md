---
id: fam-8c5e1c
title: Detect a slow crash-looping attention coordinator
status: done
priority: 2
size: s
complexity: mid
process: planned
owner: feat/attention-health
created: 2026-10-24T21:32:07Z
updated: 2026-10-25T02:01:55Z
started: 2026-10-24T21:41:33Z
completed: 2026-10-25T02:01:55Z
closed: 2026-10-25T02:01:55Z
depends: [fam-9c8dd1]
tags: [attention]
agent: claude-code/claude-opus-5-5
spec: docs/specs/2026-10-24-desktop-attention-design.md
plan: docs/plans/2026-10-24-attention-crash-history.md
---

Final review round 3 of fam-9c8dd1 found that a familiar-niri watch coordinator which dies 15 s or more after each start never trips the runbook's StartLimitBurst=5/60 s, and because every restart writes a fresh heartbeat (restarts every ~2 s, under the 10 s stale threshold) it reads healthy indefinitely while each recover drops queued work. Once native agent toasts are suppressed this hides a broken coordinator. Design how health proves the coordinator is doing attention work (e.g. heartbeat or a health field tied to completed passes) without coupling the heartbeat to the presentation lock; the health schema is in the accepted spec, so this needs a spec amendment and review.

## Notes

- 2026-10-24T21:41:33Z (feat/attention-health): started
  provenance: {"harness_session":"claude-code:bd545b63-145e-4536-a6e1-addc72bbcb4b","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-24T21:41:42Z (feat/attention-health): worktree .worktrees/attention-health on feat/attention-health, stacked on feat/desktop-attention f7bfb48 + main's task records (user chose stacking); hydrated with npm ci + node tools/fetch-luau.mjs --archive (fam-9c8dd1 verified luau-ubuntu.zip); baseline just test: 1299+7 tests, 0 fail, 5 skipped
- 2026-10-24T21:42:55Z (feat/attention-health): parked (waiting on user, decision): User answers the brainstorming question (what the bar should show for a slow crash loop, and how soon); then Claude continues brainstorming and drafts the spec amendment in .worktrees/attention-health
  provenance: {"harness_session":"claude-code:bd545b63-145e-4536-a6e1-addc72bbcb4b","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-24T23:44:24Z (feat/attention-health): resumed
  provenance: {"harness_session":"claude-code:bd545b63-145e-4536-a6e1-addc72bbcb4b","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-24T23:47:35Z (feat/attention-health): user: 'merges approved' (desktop attention merged to main as 6847632); branch rebuilt on main 745b291. Proceeding on own judgement (bar question unanswered). Spec amendment frozen at f2a317a (sha256 48dc5c65…): heartbeat schema 2 with stopped + crashedAt; unstable = healthy and >=2 crashes in 10 min; warning only, gates unchanged. Spec review round 1 dispatched.
- 2026-10-24T23:54:25Z (feat/attention-health): review: spec round 1 — verdict: revise; findings: Important 4, Minor 8; reviewer: claude-code/claude-opus-5-5
- 2026-10-24T23:55:21Z (feat/attention-health): spec revision e69266c (sha256 4d132aeb…) answers round 1: child-signal clean-stop rule, handlers before recover, writer normalisation, unstable episodes, explicit upgrade activation; round 2 review dispatched
- 2026-10-25T00:02:09Z (feat/attention-health): review: spec round 2 — verdict: revise; findings: Important 1, Minor 7; reviewer: claude-code/claude-opus-5-5
- 2026-10-25T00:05:53Z (feat/attention-health): review: spec round 3 — verdict: accept; findings: Minor 3; reviewer: claude-code/claude-opus-5-5
- 2026-10-25T00:06:00Z (feat/attention-health): spec round 3 minors applied in ee3b32a (pkill example, bounded ended wait, hot-reload note); spec accepted, writing the plan
- 2026-10-25T00:18:42Z (feat/attention-health): review: plan round 1 — verdict: revise; findings: Important 7, Minor 10; reviewer: claude-code/claude-opus-5-5
- 2026-10-25T00:24:23Z (feat/attention-health): review: plan round 2 — verdict: revise; findings: Important 1, Minor 7; reviewer: claude-code/claude-opus-5-5
- 2026-10-25T00:27:02Z (feat/attention-health): review: plan round 3 — verdict: accept; findings: Minor 3; reviewer: claude-code/claude-opus-5-5
- 2026-10-25T00:27:05Z (feat/attention-health): plan accepted at 3d6da97; executing subagent-driven (own call: interacting interfaces and timing races justify per-task review)
- 2026-10-25T01:45:43Z (feat/attention-health): review: impl round 1 — verdict: revise; findings: Minor 6; reviewer: claude-code/claude-opus-5-5
- 2026-10-25T01:50:57Z (feat/attention-health): review: impl round 2 — verdict: accept; findings: Minor 2; reviewer: claude-code/claude-opus-5-5
- 2026-10-25T02:01:51Z (feat/attention-health): attached: sdd-ledger.md (9254 bytes): SDD ledger: pre-flight scan, per-task reviews, rulings and deferred minors for the crash-history plan
- 2026-10-25T02:01:55Z (feat/attention-health): done
  provenance: {"harness_session":"claude-code:bd545b63-145e-4536-a6e1-addc72bbcb4b","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-25T02:01:55Z (feat/attention-health): heartbeat schema 2 with a crash history; bar warns 'unstable' at 2 crashes in 10 min without changing gates; clean group stops not counted; docs and upgrade runbook
  provenance: {"harness_session":"claude-code:bd545b63-145e-4536-a6e1-addc72bbcb4b","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
