# Spec round 7 review

Reviewer: claude-code/claude-opus-5-5, identity supplied by the user.
Reviewed repository: familiar.
Frozen revision: 2b58b29009267ac0978945515cdadc3309736a74.
Path: docs/specs/2026-10-24-desktop-attention-design.md.
The following is the full review and acceptance relayed by the user.

I accept 2b58b29. All six round-5 corrections are in the spec as described, and I found nothing that blocks planning. I reviewed the frozen commit, which matches the working file (sha256 80b40928412f…). Next, the session that owns fam-9c8dd1 records the round below and writes the implementation plan in this worktree. The plan is a review gate of its own.

How each correction landed:
- Claude attribution: the spec now limits the separate-source guarantees to identified Codex workers. It says Claude's early closure is an accepted v1 limitation, shown in the tooltip, and planning's runtime check can't promote it to a passing claim.
- Stranded Codex workers: these now get a visible, dismissible "Completion withheld — worker status unconfirmed" warning instead of silent suppression. Dismissal is keyed to the unchanged set of blocking workers, and nothing expires on a timer.
- Completion history: the record of a finished turn is now kept separately from whether its marker is showing. That closes my round-5 item 3, and there's a test for the focused, seen and dismissed cases plus a control.
- Heartbeat: it gets its own file and doesn't take the presentation lock. I checked where it lands: src/bus/paths.js puts the state directory at ~/.local/state/familiar, outside Dropbox. bin/familiar-niri filters its directory watch by file name, so a write every 2 s won't trigger resyncs.
- DND unknown: queued popups and toasts are dropped with the suppression saved, there's no backlog replay, and both unknown→off and on→off are tested.
- Approval wording: "Approval requested — response unconfirmed" now applies to all three harnesses.

Minor (deferred, not blocking):
- The withheld-completion warning may also fire in normal use. The rule can't tell a stranded worker from one that's still legitimately running. If Codex can end a root turn while its workers keep running, the warning appears in ordinary use. That turn's "Turn finished" is then never shown, because the spec deliberately doesn't replay a withheld completion when the worker finishes. Planning should check whether Codex does this, alongside the Claude parallel-permission check, and record the result. If it does, you may want this case revisited before rollout.

For the task's session to record: review: spec round 7 — verdict: accept; findings: Minor 1; reviewer: claude-code/claude-opus-5-5. The minor above should go into the ledger as minor (deferred).

Keith: accepted for planning.
