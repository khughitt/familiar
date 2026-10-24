---
id: fam-dac984
title: Fix desktop attention runbook gaps
status: todo
priority: 2
size: xs
complexity: low
process: direct
created: 2026-10-24T21:32:13Z
updated: 2026-10-24T21:32:13Z
depends: [fam-9c8dd1]
tags: [attention, docs]
agent: claude-code/claude-opus-5-5
---

docs/runbooks/desktop-attention-rollout.md from fam-9c8dd1: make step 3's popup backoff check runnable (how to remove and restore familiar on the popup's PATH, how to count attempts — e.g. a scratch PATH dir with a familiar symlink, Quickshell log lines or strace -f -e execve); correct the start-limit text (it only ends fast crash loops; see the slow crash-loop task); add a recovery note for a corrupt attention.json (remove it; the next observation restores current requests as static markers); add to the pilot checklist clicks racing a 16/200 ms motion re-render (the host drops superseded handlers) and a separate click-to-focus timing (familiar niri focus cold start measured ~120 ms before any socket work).
