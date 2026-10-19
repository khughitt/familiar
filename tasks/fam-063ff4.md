---
id: fam-063ff4
title: Group Codex worker rows under their root agent and key renderers by relay id
status: idea
priority: 3
created: 2026-10-19T20:48:55Z
updated: 2026-10-19T20:49:09Z
depends: [fam-6e8321]
tags: []
source: "docs/specs/2026-10-19-relay-consumer-design.md, Out of scope"
agent: claude-code/claude-opus-5-5
---

The relay consumer skips scope: worker rows (src/bus/projection.js) and keeps intent.json keyed by Agent.sessionId; its spec lists worker grouping and moving renderer keys to relay ids as out of scope. Showing a worker beside its root needs the worker-to-root link (root: codex:<R>, a relay Agent.id), which sessionId keys do not carry. Related: relay-29b7a0 shows worker scope and root in relay's own list.

## Notes

- 2026-10-19T20:49:09Z (main): concerns: fam-6e8321 extension — the relay consumer skips Codex worker rows; grouping them needs relay-id renderer keys
