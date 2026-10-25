---
id: fam-2fc04c
title: Update surface ownership after the relay cutover
status: doing
priority: 3
size: xs
complexity: low
process: direct
owner: main
created: 2026-10-25T01:00:20Z
updated: 2026-10-25T02:05:03Z
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
