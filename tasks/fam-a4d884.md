---
id: fam-a4d884
title: Close desktop attention test-proof gaps
status: todo
priority: 3
size: xs
complexity: low
process: direct
created: 2026-10-24T21:32:10Z
updated: 2026-10-24T21:32:10Z
depends: [fam-9c8dd1]
tags: [attention, testing]
agent: claude-code/claude-opus-5-5
---

From fam-9c8dd1's final review rounds 3: the model test's claim-after-recover assertion passes regardless of the fix — test the focus path instead (a focus-style desktop input after recover leaves a new episode pending, no claim); add a Luau contract test for a root with only a dismissed unmapped diagnostic ('·' node, no panel Dismiss button); add a CI check that the plugin's Luau uses nothing newer than the host's vendored Luau 0.724 (tests run 0.743).
