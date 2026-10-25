---
id: fam-06caee
title: Harden desktop attention coordinator edge cases
status: todo
priority: 2
size: s
complexity: mid
process: direct
created: 2026-10-24T21:32:08Z
updated: 2026-10-25T02:10:33Z
depends: [fam-9c8dd1]
tags: [attention]
agent: claude-code/claude-opus-5-5
---

Deferred minors from fam-9c8dd1's final review: (1) a failed 'niri msg -j windows' makes syncWindows([]) rewrite niri-windows.json fully unmapped, where the old watcher left the map alone — skip the window sync on a failed query while still withdrawing attention attribution; (2) between recover and the first pass the focus path reduces a desktop input carrying the predecessor's DND, so a request captured in that window can be suppressed on a stale 'on' reading — skip DND suppression while the desktop status is not known; (3) startup grace plus the 3 s confirmation reports a never-started coordinator at ~13 s instead of the spec's 10 s — start the confirmation clock inside the grace; (4) investigate (not reproduced) whether relay intermittently losing a session's process handle starts new sources and re-announces a dismissed request. Each fix with a failing test first.

## Notes

- 2026-10-25T02:10:33Z (main): from fam-8c5e1c final review (deferred): (a) a second SIGTERM/SIGINT during the shutdown drain hits Node's default action because handlers are unregistered first, skipping the stopped:true record so a double Ctrl-C counts as one crash — keep no-op handlers until after the final write; (b) the heartbeat interval keeps running if watch()/eventStream() throws during setup
