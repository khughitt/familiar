---
id: fam-6112ac
title: Document the Codex shared-daemon launch requirement
status: todo
priority: 3
size: xs
complexity: low
process: direct
created: 2026-10-25T01:01:07Z
updated: 2026-10-25T01:01:07Z
depends: []
tags: [docs]
source: fam-3f208e
agent: codex
---

docs/install.md explains installing relay Codex hooks and Familiar pets but omits how to launch Codex when hooks otherwise run under its shared app-server daemon. At reviewed commit 745b291, src/render/harness.js explicitly diagnoses this ancestry as unsupported for terminal attribution and tells the operator to launch codex --no-daemon; src/observe/enrich.js requires provable session and terminal ownership. Add that conditional launch prerequisite to the Codex lifecycle setup, link it from any selection guidance that needs it, and preserve the distinction between Codex-native pet rendering and Familiar presentation/identity convergence. Verify the wording against source and the recorded evidence in fam-ac775c; do not claim daemon-hosted hooks are supported. Finding: rubric v2 criterion 8; source 5ce6be4.
