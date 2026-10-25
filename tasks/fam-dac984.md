---
id: fam-dac984
title: Fix desktop attention runbook gaps
status: todo
priority: 2
size: xs
complexity: low
process: direct
created: 2026-10-24T21:32:13Z
updated: 2026-10-25T02:10:37Z
depends: [fam-9c8dd1]
tags: [attention, docs]
agent: claude-code/claude-opus-5-5
---

docs/runbooks/desktop-attention-rollout.md from fam-9c8dd1: make step 3's popup backoff check runnable (how to remove and restore familiar on the popup's PATH, how to count attempts — e.g. a scratch PATH dir with a familiar symlink, Quickshell log lines or strace -f -e execve); correct the start-limit text (it only ends fast crash loops; see the slow crash-loop task); add a recovery note for a corrupt attention.json (remove it; the next observation restores current requests as static markers); add to the pilot checklist clicks racing a 16/200 ms motion re-render (the host drops superseded handlers) and a separate click-to-focus timing (familiar niri focus cold start measured ~120 ms before any socket work).

## Notes

- 2026-10-24T23:47:37Z (feat/attention-health): fam-8c5e1c (feat/attention-health) rewrites the runbook's start-limit paragraph and switches the kill check to SIGKILL; leave those two items to it
- 2026-10-25T02:04:05Z (main): runbook upgrade step (from fam-8c5e1c): when its lines are run together as one script (bash -c), pgrep -f '[f]amiliar-niri watch' and the qs pattern also match that shell, whose own command line holds the spawn-sh text; stop_and_wait correctly refused the two-pid result. Interactive shells are unaffected. Consider pgrep -x by process name plus an argv check, or capture pids in a separate step.
- 2026-10-25T02:08:39Z (main): curate-docs: fam-3f208e at 7143e04 confirms: step 3 still omits how to construct its throwaway theme/config and publish relay rows before familiar observe consumes them (captureAttention reads relay.readSnapshot; test/attention-e2e.slow.test.js publishes with applyEvent first), plus how to remove/restore familiar on the popup PATH and count attempts. Make the headless procedure reproducible within the existing runbook-gap scope. The concurrent attention-health merge fixed the preliminary blanket start-limit finding, so that item is not a remaining finding of this pass.
- 2026-10-25T02:10:37Z (main): from fam-8c5e1c reviews (deferred, upgrade section): say reverting the crash-history merge needs the same three restarts; confirm 'within 10 s'; the freeze check after a main-process SIGKILL must target the new MainPID (systemctl --user show -p MainPID --value familiar-attention); mention the expected one-time 'health record unusable; crash history reset' log; stop_and_wait accepts pid 0; Rollback and step 6 still relaunch from the operator shell rather than through niri msg action spawn-sh
