---
id: fam-f9bc64
title: Tidy the worktree identity review minors
status: todo
priority: 3
size: s
complexity: low
process: direct
created: 2026-10-08T10:54:48Z
updated: 2026-10-08T10:54:48Z
depends: []
parent: fam-74f6e9
tags: [identity]
agent: claude-code/claude-opus-5-5
---

Six Minor findings from the fam-169e3f final reviews, deferred from that branch: (1) tools/bench-hook.mjs missing-dependencies hint says `npm install --prefix <root>`, which rewrote every lock key through the .worktrees symlink; suggest `npm ci` inside the checkout. (2) src/bus/transaction.js comment says Git spawns up to two subprocesses; now three, six with newline framing. (3) docs/install.md says a remote-less key is the main checkout's path; for a bare-backed worktree it is the bare repository. (4) Add a test that pre-seeds the shared info/exclude (managed line plus custom content) from the main checkout, then applies from a worktree, and asserts one managed line and preserved content. (5) The spec's Git discovery section should state the Git 2.31 floor and its named error, checked before framing. (6) README and docs/install.md say familiar requires Git 2.31; only repository identity needs it.
