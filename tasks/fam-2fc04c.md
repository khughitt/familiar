---
id: fam-2fc04c
title: Update surface ownership after the relay cutover
status: doing
priority: 3
size: xs
complexity: low
process: direct
owner: docs/relay-cutover
created: 2026-10-25T01:00:20Z
updated: 2026-10-25T02:11:47Z
started: 2026-10-25T02:05:03Z
depends: []
tags: [docs]
source: fam-3f208e
agent: codex
---

docs/surfaces.md still lists Familiar hooks and a Familiar OpenCode server plugin as lifecycle sources, says Familiar installs both plugins, and attributes Codex convergence to Familiar-owned hooks. At reviewed commit 745b291, src/install/setup.js emits relay observers and a statusLine-only Claude fragment; src/install/opencode.js installs only the Familiar TUI renderer and removes the retired server plugin. Rewrite the affected surface-table rows and terminal/Codex/OpenCode ownership prose to match relay ownership and the current observer path; retain the documented rendering and platform limits. Check the named paths and command contracts against source and run the existing documentation-reading CLI test through the declared test front door when editing. Finding: rubric v2 criterion 9; cutover code badc3d2.

## Notes

- 2026-10-25T01:00:31Z (main): concerns: fam-6e8321 defect — the landed relay cutover left the current surface guide assigning hooks and the OpenCode server plugin to Familiar.
- 2026-10-25T02:05:03Z (main): started
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:05:30Z (docs/relay-cutover): resumed
  provenance: {"harness_session":"codex:01a170cc-d59c-78d3-86c0-1256b06a0a11","harness_session_source":"CODEX_THREAD_ID"}
- 2026-10-25T02:07:19Z (docs/relay-cutover): Verified src/install/setup.js, src/install/opencode.js and src/observe/run.js: relay owns hooks/server lifecycle; familiar observe owns presentation and Codex convergence; Familiar installs only the OpenCode TUI renderer and removes verified retired server entries. Preserve platform/tmux limits. Shared worktree .worktrees/docs-relay-cutover; baseline just test: 1341 passed, 5 skipped, zero failures. No test-one recipe: use just test-fast for the existing documentation-reading CLI test.
- 2026-10-25T02:10:35Z (docs/relay-cutover): review: impl round 1 — verdict: accept; findings: none; reviewer: codex/gpt-6.1-sol
- 2026-10-25T02:10:57Z (docs/relay-cutover): attached: docs-review-report.md (2867 bytes): Read-only whole-branch review of fc1043d; codex/gpt-6.1-sol accepted with no findings
- 2026-10-25T02:10:59Z (docs/relay-cutover): attached: review-ledger.md (1147 bytes): Controller rulings on the three review scope exclusions; no deferred minors
- 2026-10-25T02:11:47Z (docs/relay-cutover): Verification: post-edit just test-fast ran 1336 tests (1331 passed, 5 skipped), including the documentation-reading CLI test; just check, tasks check and git diff --check passed with zero warnings. Full baseline just test also passed (1331 fast plus 10 slow passed, 5 skipped). Full review and scope rulings attached and byte-verified; temporary review workspace copies removed. No task scratch or off-tree evidence retained.
