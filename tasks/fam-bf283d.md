---
id: fam-bf283d
title: Pass relay's process readers to resolveTerminalPid when upgrading past relay v0.1.1
status: todo
priority: 3
size: xs
complexity: low
process: direct
created: 2026-10-22T18:07:25Z
updated: 2026-10-22T18:07:25Z
depends: [relay-cfd24b]
tags: []
agent: claude-code/claude-opus-5-5
---

relay's claude-code resolveTerminalPid now also reads executableOf and argvOf (a terminal-owning versioned process and its parent), defaulting to real /proc reads. src/observe/enrich.js passes only ancestors. On upgrade, pass executableOf: relayProcess.executableOf and argvOf: relayProcess.argvOf as the resolveSessionPid call does, so fixture chains never read the test host's /proc. Also decide whether a PROCESS_UNREADABLE from those reads should become a refused(...) reason rather than escaping to run.js as a fault.
