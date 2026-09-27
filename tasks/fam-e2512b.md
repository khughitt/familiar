---
id: fam-e2512b
title: The status line settles a provisional SessionStart cat so it shows at init
status: doing
priority: 1
size: s
complexity: mid
process: direct
owner: main
created: 2026-09-27T18:51:10Z
updated: 2026-09-27T18:51:10Z
started: 2026-09-27T18:51:10Z
depends: []
tags: [render, bug]
source: fam-a2a392
agent: claude-code/claude-opus-5-5
---

fam-a2a392 left the cat missing until the first event whenever the SessionStart hook beats Claude Code's switch to the alternate screen. Claude Code spawns SessionStart hooks and enters ?1049h without waiting for them (hook ~380ms vs TUI ~370ms: a coin flip), while the status line only runs once the TUI is up. The SessionStart section publishes held with provisional: true; the status line re-creates it once under the transmit lock and publishes ordinary evidence.

## Notes

- 2026-09-27T18:51:10Z (main): started
  provenance: {"harness_session":"claude-code:f9f4c628-5230-4e31-9879-b4cd71eedac7","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
