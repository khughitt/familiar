---
id: fam-8f0f2b
title: "Status-line pet reflects the flow state: waiting on the user, on a subagent, reviewing, done"
status: idea
priority: 2
created: 2026-10-18T22:39:55Z
updated: 2026-10-18T22:39:55Z
depends: []
tags: [quick-add]
source: "mindful:thought:0082fda09c0ec41dcf9f2ae116727ea5"
agent: claude-code/claude-opus-5-5
---

The status-line cat already changes with session state. Extend it to recognise flow states (waiting for user input, waiting on a subagent, reviewing a design, task finished), in the project's hue.

The user's original thought was a cue inline in the transcript, so review summaries carry a small visual marker that stays visible when scrolling back through a session; the status line is the simpler place to start. Long-term direction: flow templates insert small coloured ASCII glyphs (about 2x2, rows by columns) as easily found inline markers at flow-state boundaries; flows owns those templates.
