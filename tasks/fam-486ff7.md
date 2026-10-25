---
id: fam-486ff7
title: Remove the 50 ms real-time sleep from the stop-during-recovery coordinator test
status: todo
priority: 3
size: xs
complexity: low
process: direct
created: 2026-10-25T01:45:45Z
updated: 2026-10-25T01:45:45Z
depends: []
tags: [tests]
agent: claude-code
---

test/attention-coordinator.test.js 'a stop during recovery exits 0 with no heartbeat and leaves the predecessor record' sleeps 50 ms of real time before emitting SIGTERM, assuming the singleton lock is taken and handlers registered by then; under load the assertion fails. Poll h.signals.count() === 2 before emitting instead. Deferred from fam-8c5e1c Task 2 review.
