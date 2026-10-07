---
id: fam-2b8fff
title: Update an installed theme in place
status: todo
priority: 2
size: m
complexity: mid
process: planned
created: 2026-10-07T19:49:48Z
updated: 2026-10-07T19:49:48Z
depends: []
tags: [theme]
agent: claude-code/claude-opus-5-5
---

Shipping new art for an installed theme (cats matte-v1, 2026-10-07) has no command: theme add refuses an installed id ('already installed at … — remove it first'), there is no theme remove, and the receipt must go too or add refuses an orphan receipt. The person hand-deletes ~/.config/familiar/themes/<id> and theme-receipts/<id>.json, re-adds, then reruns familiar install pets once per Codex home (CODEX_HOME=~/.codex and ~/.codex-work here), since pets are compiled copies under $CODEX_HOME/pets.

Wanted: an update (or add --replace) that stages and validates the new pack, then swaps theme dir and receipt atomically, and either refreshes compiled Codex pets for every known Codex home or names each one still stale. Claude Code needs nothing more: its hooks and status line read the theme dir at render time.
