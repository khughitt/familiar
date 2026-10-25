---
id: fam-6112ac
title: Document the Codex shared-daemon launch requirement
status: doing
priority: 3
size: xs
complexity: low
process: direct
owner: docs/relay-cutover
created: 2026-10-25T01:01:07Z
updated: 2026-10-25T02:10:32Z
started: 2026-10-25T02:05:00Z
depends: []
tags: [docs]
source: fam-3f208e
agent: codex
---

docs/install.md explains installing relay Codex hooks and Familiar pets but omits how to launch Codex when hooks otherwise run under its shared app-server daemon. At reviewed commit 745b291, src/render/harness.js explicitly diagnoses this ancestry as unsupported for terminal attribution and tells the operator to launch codex --no-daemon; src/observe/enrich.js requires provable session and terminal ownership. Add that conditional launch prerequisite to the Codex lifecycle setup, link it from any selection guidance that needs it, and preserve the distinction between Codex-native pet rendering and Familiar presentation/identity convergence. Verify the wording against source and the recorded evidence in fam-ac775c; do not claim daemon-hosted hooks are supported. Finding: rubric v2 criterion 8; source 5ce6be4.

## Notes

- 2026-10-25T01:01:16Z (main): concerns: fam-ac775c extension — document the existing shared-daemon limitation and --no-daemon remedy in the operator setup guide.
- 2026-10-25T02:05:00Z (main): started
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:05:27Z (docs/relay-cutover): resumed
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:07:17Z (docs/relay-cutover): Verified src/render/harness.js, src/observe/enrich.js and run.js against fam-ac775c: daemon-hosted hooks cannot prove terminal ownership; --no-daemon worked in the 0.160.1 pilot, disabling daemon auto-start did not. Document conditional launch prerequisite and link automatic selection guidance, preserving independent Codex-native rendering. Shared worktree .worktrees/docs-relay-cutover; baseline just test: 1341 passed, 5 skipped, zero failures.
- 2026-10-25T02:10:32Z (docs/relay-cutover): review: impl round 1 — verdict: accept; findings: none; reviewer: codex/gpt-6.1-sol
