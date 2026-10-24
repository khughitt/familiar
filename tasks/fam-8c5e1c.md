---
id: fam-8c5e1c
title: Detect a slow crash-looping attention coordinator
status: todo
priority: 2
size: s
complexity: mid
process: planned
created: 2026-10-24T21:32:07Z
updated: 2026-10-24T21:32:07Z
depends: [fam-9c8dd1]
tags: [attention]
agent: claude-code/claude-opus-5-5
---

Final review round 3 of fam-9c8dd1 found that a familiar-niri watch coordinator which dies 15 s or more after each start never trips the runbook's StartLimitBurst=5/60 s, and because every restart writes a fresh heartbeat (restarts every ~2 s, under the 10 s stale threshold) it reads healthy indefinitely while each recover drops queued work. Once native agent toasts are suppressed this hides a broken coordinator. Design how health proves the coordinator is doing attention work (e.g. heartbeat or a health field tied to completed passes) without coupling the heartbeat to the presentation lock; the health schema is in the accepted spec, so this needs a spec amendment and review.
