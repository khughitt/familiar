---
id: fam-9c8dd1
title: "Synchronize agent attention across familiar popups, workspace pills and desktop toasts"
status: todo
priority: 2
size: l
complexity: high
process: planned
created: 2026-10-24T12:20:07Z
updated: 2026-10-24T12:20:07Z
depends: []
tags: []
agent: codex
---

User approved one shared attention model feeding familiar popups, a custom Noctalia workspace widget and desktop toasts, retaining familiar hue as identity and event-specific shape/motion. Visiting the source stops animation but leaves unanswered input/approval requests statically marked; widget dismissal silences the current alerts without answering or cancelling requests, and later requests can alert again. Produce and review a design spec and implementation plan before building. Reuse relay lifecycle events and existing session/window attribution; avoid a Noctalia fork or a new daemon/repository initially. Include restart/deduplication, multiple sessions, moving windows, native-notification duplication and reduced motion. Coordinate rollout through ops, with live host changes separately approved.
