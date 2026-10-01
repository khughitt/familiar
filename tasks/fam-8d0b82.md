---
id: fam-8d0b82
title: Repaint the cat when a tmux client attaches
status: idea
priority: 3
created: 2026-09-18T11:32:35Z
updated: 2026-10-01T12:50:38Z
depends: []
parent: fam-361178
tags: [tmux]
agent: "claude-code/claude-opus-5[1m]"
---

After docs/specs/2026-09-18-tmux-rendering-design.md lands, attaching a client to a tmux session (or opening a fresh kitty window onto it) shows no cat until the next state transition, because no familiar hook fires on attach (§7.3). tmux offers set-hook client-attached; a run-shell there could call a familiar verb that re-emits a create for every live session whose pane belongs to the attaching client. Needs: a verb that reads the bus and the transmission ledger and emits without a hook event, and setup wiring for the tmux hook. Scope it after fam-fff8c9 lands.

## Notes

- 2026-10-01T12:50:37Z (main): scope: briefed; startup settling leaves changed-client evidence untouched; fam-2b371b owns the attach design; brief: docs/notes/2026-10-01-tmux-rendering-followups-brief.md
