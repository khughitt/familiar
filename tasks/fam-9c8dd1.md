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
updated: 2026-10-24T13:49:28Z
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
- 2026-10-24T12:27:42Z (feat/desktop-attention): attached: builder-check-report.md (218 bytes): Read-only builder check of spec eccdaa3 by codex/gpt-6.1-sol; no important unanswered questions; implementation and desktop behavior untested
- 2026-10-24T12:27:44Z (feat/desktop-attention): attached: ledger.md (866 bytes): Spec review round 1 acceptance ruling, reason and cost; no deferred minors; user review remains pending
- 2026-10-24T12:27:45Z (feat/desktop-attention): parked (waiting on user, review): User reviews familiar spec eccdaa36275085a2b70a5d2cb61b42101550bcec at .worktrees/desktop-attention/docs/specs/2026-10-24-desktop-attention-design.md; after approval agent writes and reviews the implementation plan in this worktree. No implementation or checks are running, no host pointers changed. Review report and ledger attached; full-suite baseline deferred until execution Setup.
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T13:02:51Z (feat/desktop-attention): resumed
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T13:02:54Z (feat/desktop-attention): review: spec round 2 — verdict: revise; findings: Important 3, Minor 5; reviewer: claude-code/claude-opus-5-5
- 2026-10-24T13:10:29Z (feat/desktop-attention): Round 2 disposition: accept raw root/worker separation and source-scoped episodes. Choose static Turn finished marker and low-priority notice only for a genuine root completion classified on an unfocused workspace; no synthetic needs-input event. Verify OpenCode qualification: its adapter reduces session.idle after active states to done, and its plugin handles permission.replied then republishes aggregate level. Choose truthful Approval requested — response unconfirmed with age and accepted unbounded observation lag for Claude/Codex, rather than claiming approval pending or treating focus as an answer. Define seen by globally focused workspace; require planning gesture verification/fallback, explicit Noctalia IPC transport/live DND adapter, supervised coordinator and independent widget health detection.
- 2026-10-24T13:13:21Z (feat/desktop-attention): attached: spec-round-2-report.md (5129 bytes): Full round-2 review of eccdaa3 by claude-code/claude-opus-5-5, relayed by user: 3 Important and 5 Minor findings
- 2026-10-24T13:13:23Z (feat/desktop-attention): Revised spec frozen as new commit 929d0a15dcb2a612247d2f628084bf03b16976d0, docs/specs/2026-10-24-desktop-attention-design.md. All eight round-2 findings have recorded dispositions in the retained ledger. Fresh read-only evidence review dispatched against that exact commit, explicitly checking installed relay adapters, reducer/worker attribution, OpenCode permission replies and the Noctalia integration boundaries. No plan, product code or host changes.
- 2026-10-24T13:16:31Z (feat/desktop-attention): review: spec round 3 — verdict: revise; findings: Important 1; reviewer: codex/gpt-6.1-sol
- 2026-10-24T13:17:24Z (feat/desktop-attention): attached: spec-round-3-report.md (5467 bytes): Full evidence review of 929d0a1 by codex/gpt-6.1-sol: eight prior corrections confirmed; 1 Important passive-idle retention contradiction
- 2026-10-24T13:17:25Z (feat/desktop-attention): Round 3 Important accepted: OpenCode queue forwards repeated idle, and adapter reduces done to idle, so generic different-state closure would erase completion. Corrective spec commit 4fdcb54ae7335e594b95b9578360cdcdbaac02e1 explicitly preserves completion ID/dispositions/delivery through passive idle/reconcile/restart and defines genuine new activity; required working→done→idle→idle regression case added. Fresh scoped read-only reviewer dispatched against the new frozen commit. Original eight round-2 corrections otherwise confirmed in the full round-3 evidence review.
- 2026-10-24T13:18:54Z (feat/desktop-attention): review: spec round 4 — verdict: accept; findings: none; reviewer: codex/gpt-6.1-sol
- 2026-10-24T13:18:56Z (feat/desktop-attention): attached: spec-round-4-report.md (2990 bytes): Full scoped re-review of 4fdcb54 by codex/gpt-6.1-sol: accept, no findings; passive idle retention and lifecycle interactions checked
- 2026-10-24T13:18:58Z (feat/desktop-attention): attached: spec-revision-ledger.md (7892 bytes): Round-2 and round-3 rulings with reasons/costs and revision references; round-4 acceptance of 4fdcb54; no deferred minors
- 2026-10-24T13:19:00Z (feat/desktop-attention): parked (waiting on user, review): User reviews replacement familiar spec 4fdcb54ae7335e594b95b9578360cdcdbaac02e1 at .worktrees/desktop-attention/docs/specs/2026-10-24-desktop-attention-design.md. Then agent writes the implementation plan after approval. Full round-2/3/4 reports and spec-revision-ledger attached; round-4 scoped review accepts with no findings, no deferred minors. No plan/product code, host pointers or settings changed; no checks/children running. Full-suite baseline remains deferred to execution Setup.
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T13:40:05Z (feat/desktop-attention): resumed
  provenance: {"harness_session":"codex:01a16dc2-3206-71a0-a1aa-70a9859642a9","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-24T13:40:09Z (feat/desktop-attention): review: spec round 5 — verdict: revise; findings: Important 3, Minor 3; reviewer: claude-code/claude-opus-5-5
- 2026-10-24T13:45:17Z (feat/desktop-attention): Round 5 rulings: document accepted Claude aggregate-source early-closure limitation and require planning confirmation of parallel tool activity during another permission wait; do not promise Codex-style worker isolation for Claude. Keep conservative Codex worker gating without guessed expiry, but expose a static dismissible suppression diagnostic keyed by root/blocker incarnations and test missing SubagentStop. Retain completed-turn metadata independently of marker visibility through focus/dismiss/restart until genuine activity or teardown. Put heartbeat in its own atomically replaced lock-free health file. Persist suppressed delivery and drop queued effects on DND unknown/on, without recovery replay. Use response-unconfirmed approval wording for all harnesses, with reply-driven OpenCode closure.
- 2026-10-24T13:48:07Z (feat/desktop-attention): attached: spec-round-5-report.md (4652 bytes): Full review of 4fdcb54 by claude-code/claude-opus-5-5 relayed by user: 3 Important and 3 Minor findings
- 2026-10-24T13:48:09Z (feat/desktop-attention): Replacement spec frozen in new commit 2b58b29009267ac0978945515cdadc3309736a74 for round 6. Full round-5 review saved/attached; six rulings and their reasons/costs recorded in the retained ledger. Fresh read-only scoped review dispatched against the frozen commit. Read-only installed Niri workspace query additionally confirmed boolean is_focused on every returned workspace and exactly one focused; no names/titles captured, no focus changed. Parallel Claude permission scheduling, Codex interrupt hook behavior and Noctalia runtime gesture/DND checks remain unperformed planning obligations.
- 2026-10-24T13:49:28Z (feat/desktop-attention): Scope clarification for round 6: planning must confirm Claude parallel-permission scheduling; implementation must test a missing Codex SubagentStop. Establishing whether every native Codex interrupt emits that hook is not a prerequisite for the conservative suppression/diagnostic policy and remains explicitly unverified. This corrects the prior note that grouped Codex interrupt behavior with mandatory runtime planning checks; the frozen spec already makes the distinction.
