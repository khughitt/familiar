---
id: fam-5ecf74
title: Keep multiline tasks failures on one diagnostic line
status: todo
priority: 3
size: xs
complexity: low
process: direct
created: 2026-10-18T10:37:13Z
updated: 2026-10-18T10:37:13Z
depends: []
tags: []
source: fam-053b0d
agent: codex
---

Final whole-branch review found that project-color.js embeds tasks stderr verbatim, so multiline stderr plus usage yields several physical lines at the CLI boundary. Escape embedded newlines in external-command error detail and add a multiline-stderr regression. Preserve the original failure information, cosmetic hook exit status and failure-before-write behavior. This is a deferred minor presentation finding before fam-053b0d closes, not a concern about completed work.
