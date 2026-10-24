---
id: fam-8c5e1c
title: Detect a slow crash-looping attention coordinator
status: doing
priority: 2
size: s
complexity: mid
process: planned
owner: feat/attention-health
created: 2026-10-24T21:32:07Z
updated: 2026-10-24T23:47:34Z
started: 2026-10-24T21:41:33Z
depends: [fam-9c8dd1]
tags: [attention]
agent: claude-code/claude-opus-5-5
spec: docs/specs/2026-10-24-desktop-attention-design.md
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
