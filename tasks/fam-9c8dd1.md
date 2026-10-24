---
id: fam-9c8dd1
title: "Synchronize agent attention across familiar popups, workspace pills and desktop toasts"
status: doing
priority: 2
size: l
complexity: high
process: planned
owner: feat/desktop-attention
created: 2026-10-24T12:20:07Z
updated: 2026-10-24T12:27:29Z
started: 2026-10-24T12:20:23Z
depends: []
tags: []
agent: codex
spec: docs/specs/2026-10-24-desktop-attention-design.md
---

User approved one shared attention model feeding familiar popups, a custom Noctalia workspace widget and desktop toasts, retaining familiar hue as identity and event-specific shape/motion. Visiting the source stops animation but leaves unanswered input/approval requests statically marked; widget dismissal silences the current alerts without answering or cancelling requests, and later requests can alert again. Produce and review a design spec and implementation plan before building. Reuse relay lifecycle events and existing session/window attribution; avoid a Noctalia fork or a new daemon/repository initially. Include restart/deduplication, multiple sessions, moving windows, native-notification duplication and reduced motion. Coordinate rollout through ops, with live host changes separately approved.

## Notes

- 2026-10-24T12:20:23Z (main): started
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T12:20:56Z (feat/desktop-attention): resumed
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T12:22:41Z (feat/desktop-attention): User accepted the shared-attention approach and visit-to-stop-motion behavior, and requested a widget withdrawal gesture. Design call: right-click dismisses only the current attention episode(s), never answers/cancels a relay request or grants approval; middle-click keeps Noctalia settings. Worktree .worktrees/desktop-attention hydrated with npm ci. Setup reported 5 audit findings (1 low, 1 high, 3 critical), covered by existing fam-2ffd64; no dependency fixes in this task. Planned-work full-suite baseline is deferred to execution Setup before code changes.
- 2026-10-24T12:27:29Z (feat/desktop-attention): review: spec round 1 — verdict: accept; findings: none; reviewer: codex/gpt-6.1-sol
