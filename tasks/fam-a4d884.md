---
id: fam-a4d884
title: Close desktop attention test-proof gaps
status: todo
priority: 3
size: xs
complexity: low
process: direct
created: 2026-10-24T21:32:10Z
updated: 2026-10-25T02:10:36Z
depends: [fam-9c8dd1]
tags: [attention, testing]
agent: claude-code/claude-opus-5-5
---

From fam-9c8dd1's final review rounds 3: the model test's claim-after-recover assertion passes regardless of the fix — test the focus path instead (a focus-style desktop input after recover leaves a new episode pending, no claim); add a Luau contract test for a root with only a dismissed unmapped diagnostic ('·' node, no panel Dismiss button); add a CI check that the plugin's Luau uses nothing newer than the host's vendored Luau 0.724 (tests run 0.743).

## Notes

- 2026-10-25T02:10:36Z (main): from fam-8c5e1c reviews (deferred): plugin contract scenes switch the heartbeat instance before the saved state, the reverse of the real recover-then-beat order — add one scene in the real order; Luau accepts crashedAt [null] / [1,null] that Node rejects — record it beside the {} note or add a parity case; Luau crashCount parity uses a hand-copied case list (export the Node list); DND case list duplicated between the two notice tests; the future-crash coordinator test does not itself assert the seeded entry was carried
