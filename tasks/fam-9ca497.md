---
id: fam-9ca497
title: Reconcile the graphics reference's self-date with its content
status: todo
priority: 3
size: xs
complexity: low
process: direct
created: 2026-10-25T01:01:24Z
updated: 2026-10-25T01:01:24Z
depends: []
tags: [docs]
source: fam-3f208e
agent: codex
---

Only the self-date was judged; the document body was outside this pass's 800-line reference budget. docs/ref/kitty-graphics-protocol.md line 3 says Current as of 2026-07-17, while d597b27 (2026-09-18) substantively replaced its tmux-rejection text with the implemented passthrough probe, per-command wrapping and buffer limit. Remove the misleading whole-document self-date or scope and refresh it after reviewing the text it purports to date. Do not mark the entire reference current based on this date-only finding. Finding: rubric v2 criterion 10 at reviewed commit 745b291; the next curation pass must read this previously unread guide before returning to the README-first order.
