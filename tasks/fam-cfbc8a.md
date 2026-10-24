---
id: fam-cfbc8a
title: Polish desktop attention plugin and popup presentation
status: todo
priority: 3
size: s
complexity: low
process: direct
created: 2026-10-24T21:32:09Z
updated: 2026-10-24T21:32:09Z
depends: [fam-9c8dd1]
tags: [attention]
agent: claude-code/claude-opus-5-5
---

Deferred minors from fam-9c8dd1's final review: the unmapped status node and panel sections show the 'Right-click to dismiss' hint where right click does nothing (give groupTooltip a gesture-specific hint or bind right click there); diagnostic-only unmapped text; the panel never shows the output suffix (pill.output unset) and draws attribution in fallback navigation where the widget withholds it; the panel's 12-line cap can cut the unmapped section's dismissed-diagnostic line; the widget's known/arrivals maps are never pruned; a crashed popup consumer's reservation stays reserved instead of uncertain (attach sends only pending/eligible IDs).
