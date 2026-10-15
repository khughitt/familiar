---
id: fam-053b0d
title: Paint familiar's project label in the project's tasks colour
status: idea
priority: 2
created: 2026-10-15T16:49:02Z
updated: 2026-10-15T16:49:02Z
depends: []
tags: []
agent: claude-code/claude-opus-5-5
---

Why: every registered project now has one authored colour, exposed by the tasks CLI as color on tasks where / tasks resolve / tasks projects JSON (ops-30b965). familiar shows a project label (basename of repo root or cwd, src/bus/identity.js:184-186) in the HUD/status line (src/render/term/statusfields.js:62, hud.js:102-108, the project: pen at hud.js:92) and in familiar whoami / familiar projects (bin/familiar.js:741-758,781,803; cells.js), coloured from its own slot ramp, never the project colour.

Open: whether the label should take the project colour while the pet keeps its identity hue (the slot ramp is a separate concept and stays); how to map a repo root to a prefix (tasks where <path>) and read the colour without a CLI call on every hook-bus render (cache, or resolve at session start); what an unregistered directory shows.
