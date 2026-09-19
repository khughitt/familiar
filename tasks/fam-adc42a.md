---
id: fam-adc42a
title: familiar projects draws each project's sprite above its caption
status: doing
priority: 2
size: s
complexity: low
process: direct
owner: projects-art
created: 2026-09-19T16:15:27Z
updated: 2026-09-19T16:32:00Z
started: 2026-09-19T16:15:32Z
depends: []
tags: [cli, projects]
agent: "claude-code/claude-opus-5[1m]"
---

Each grid cell becomes sprite-over-caption, as theme show draws one slot: pack.rows tall (--rows N overrides), one kitty placement per cell with c=cellWidth,r=rows,C=1 and a CSI cursor-forward between cells so a wrong CELL_ASPECT costs air inside a cell, never drift across the row (a composed strip per row was rejected for that drift). Column width is the widest caption or boxFor() sprite width. Not a TTY or no graphics capability: today's text grid, with theme show's stderr notice when interactive. Pure gridPlan/layoutRow in cells.js; transmitAcross in kitty.js sharing transmit's chunking.

## Notes

- 2026-09-19T16:15:32Z (main): started
  provenance: {"harness_session":"claude-code:7672b0c4-20f0-48e3-b63c-1fdcd26a28b1","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-19T16:19:32Z (projects-art): parked (waiting on user, review): Eyeball .worktrees/projects-art/bin/familiar projects ~/d/* in kitty (sprites over captions, alignment, --rows 8); on approval fast-forward main and remove the worktree
  provenance: {"harness_session":"claude-code:7672b0c4-20f0-48e3-b63c-1fdcd26a28b1","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-19T16:32:00Z (projects-art): resumed
  provenance: {"harness_session":"claude-code:7672b0c4-20f0-48e3-b63c-1fdcd26a28b1","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
