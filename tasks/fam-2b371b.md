---
id: fam-2b371b
title: Design tmux attach repaint from the brief
status: todo
priority: 3
size: m
complexity: high
process: planned
created: 2026-10-01T12:49:23Z
updated: 2026-10-01T12:49:23Z
depends: []
parent: fam-361178
tags: []
source: docs/notes/2026-10-01-tmux-rendering-followups-brief.md
agent: codex
---

Why: fam-8d0b82 remains unresolved after startup settling landed; settleStatusline only probes provisional evidence and settle refuses a changed transport.

Outcome: Review a design for creating the current image on the newly attached client without inventing a hook event, replaying a notification, or overwriting a newer transition/SessionEnd. Compare a targeted client-attached hook/verb with extending status-line repair; recommend the smallest path that satisfies the single-client scope.

Where to start: docs/notes/2026-10-01-tmux-rendering-followups-brief.md; bin/familiar.js (settleStatusline, emitHookTransition), src/render/term/{emit,tmux,ledger,target}.js, src/bus/seq.js, and test/{emit,tmux,tmux-pty.slow}.test.js. Commits b1df1e1 and 88504c7 establish current behavior.

Done: design specifies attach-to-pane targeting, current intent/decay, owner liveness, client incarnation, locking and ordering against transitions/end, repeat-attach behavior, and hook installation/removal if needed. Name checks for a fresh client without a state transition, stale owners, concurrent SessionEnd, absent client, and passthrough refusal. Write the reviewed spec before an implementation plan.

Ideas it wakes: On completion, run tasks note on fam-8d0b82 with the design decision in the same commit as the result, and update the brief. No host hook installation in this design task.
