---
id: fam-0cfc63
title: Detect a wedged attention coordinator whose heartbeat outlives its attention work
status: todo
priority: 2
size: s
complexity: high
process: planned
created: 2026-10-25T02:10:28Z
updated: 2026-10-25T02:10:31Z
depends: []
tags: [attention]
agent: claude-code
---

The coordinator's heartbeat runs on its own timer by design (spec: Detecting coordinator failure), so a coordinator whose attention pass chain hangs (an awaited promise that never settles, a stuck lock wait) keeps reading healthy while no popups, toasts or markers are produced. fam-8c5e1c's spec amendment put this out of scope as separate work. Design how health proves passes complete (e.g. the heartbeat publishes the age of the oldest scheduled-but-unfinished pass) without coupling the heartbeat to the presentation lock; needs a spec amendment and review like fam-8c5e1c.

## Notes

- 2026-10-25T02:10:31Z (main): concerns: fam-8c5e1c extension — the crash history detects a coordinator that keeps restarting, not one that hangs without crashing
