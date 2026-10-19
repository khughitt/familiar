---
id: fam-7d9c81
title: "Delete familiar's dead outputs: niri-windows.json, statusline --with and setup claude-code|codex"
status: todo
priority: 3
size: s
complexity: low
process: direct
created: 2026-10-19T11:55:16Z
updated: 2026-10-19T20:49:12Z
depends: [fam-6e8321]
tags: []
source: ops-630a87 boundary-proposal-r3.md A1
agent: claude-code/claude-opus-5-5
---

Why: these outputs have no consumer; hq writes the hook lines, so familiar's setup command duplicates it (survey map fam). Done: consumers checked across the registered projects, code and tests removed, docs updated, suite green. Removes: a second writer of harness settings. Before landing, pass the flow-trial-1 gate (revision 3, change 5): judge the step's effect on what enrolled sessions see and what obs and the verdict tools measure; a step that changes either waits for readout (2027-02-16).

## Notes

- 2026-10-19T20:49:12Z (main): Overlaps the relay consumer branch (fam-6e8321, feat/relay-identity): it already deletes setup codex, keeps setup claude-code, and adds setup relay (subscriber entries, which hq-539508 may write itself). Rescope against the merged CLI; depends on that merge so bin/familiar.js is not edited on both lines.
