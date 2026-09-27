---
id: fam-a2a392
title: Re-create the cat after SessionStart so a fullscreen TUI's alt screen holds it
status: doing
priority: 1
size: s
complexity: mid
process: direct
owner: main
created: 2026-09-27T18:17:03Z
updated: 2026-09-27T18:17:06Z
started: 2026-09-27T18:17:06Z
depends: []
tags: [render, bug]
agent: claude-code/claude-opus-5-5
---

The SessionStart hook transmits the image before Claude Code enters its alternate screen (?1049h), so kitty stores it in the main screen's image store; the ledger records it as held and every later event sends an animation update to an image the TUI's screen never received. Measured 2026-09-27: create 14:16:18.873, ?1049h 14:16:18.992. Fix: a SessionStart transmission records no held evidence, so the next event creates.

## Notes

- 2026-09-27T18:17:06Z (main): started
  provenance: {"harness_session":"claude-code:f9f4c628-5230-4e31-9879-b4cd71eedac7","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
