# Spec round 2 review

Reviewer: claude-code/claude-opus-5-5, as supplied by the user.
Frozen revision: familiar commit eccdaa36275085a2b70a5d2cb61b42101550bcec,
docs/specs/2026-10-24-desktop-attention-design.md.

The spec needs revision before planning. It's the right overall shape, but it assumes lifecycle data that relay doesn't actually provide, and two of the gaps would show the user wrong information. I reviewed the committed revision `eccdaa3` (worktree clean) and checked its evidence claims against the code. The popup detecting only `done` and `error`, the bell set, the 8 s and 30 s timeouts, and the session-to-window mapping all match. The earlier review round was a one-line "nothing important left" check, so this is the first one that tested the claims. I didn't change anything; the task is still parked waiting on your review.

**Important**

1. **Worker activity can clear a pending request or fake a completion.** The spec says an episode starts and ends on the root session's state. But `src/bus/projection.js:33-40` replaces the root's state with any worker's state that is newer. Relay creates worker records for Codex sub-agents, and each one reaches `working` when it starts and `done` when it stops (`node_modules/relay/src/adapters/codex.js`).
   - **Example:** a Codex root asks for approval. A sub-agent then starts a tool, so the root reads `working`. The approval marker clears while the request is still open, which is the opposite of what the spec promises.
   - **Same cause, second symptom:** a sub-agent finishing sets the root to `done` and counts as a user-facing completion. The spec says relay prevents this, but that filter is Claude-only background counting; this fold lives in familiar.
   - **Fix:** the spec should say the attention reducer reads root and worker states separately rather than the folded state, and define how a worker's own approval request maps to an episode on the root.

2. **"Needs input" will rarely fire, and late.** The real event mapping in relay:

   | Harness | Needs input | Approval | Error | Turn ends |
   | --- | --- | --- | --- | --- |
   | Claude Code | idle notification only | yes | yes (`StopFailure`) | `done` |
   | Codex | never | yes | never | `done` |
   | opencode | never | yes | yes | `idle` |

   Claude Code's idle notification comes about a minute after the turn ends; I'm going on memory of Claude Code's threshold there, not something checked in this repo. The usual "the agent stopped and wants me" moment is `done`, which the spec gives no marker and no toast. In practice the input pill shows only for Claude, a minute late, and Codex and opencode never show it. The coverage table is knowable now, so it belongs in the spec rather than deferred to the plan. There is also a scope decision for you: should a turn ending on a workspace you aren't looking at leave a static marker? I'd say yes for that case only, since otherwise the most common reason an agent needs you is the one case the widget never shows.

3. **Approval markers stay up after you approve.** None of the three harnesses sends an event when you grant approval. The state only changes at the next tool start or turn end. If you approve a 10-minute test run, the pill shows "approval pending" for 10 minutes. The spec should say how far resolution can lag and choose a mitigation (for example, treat visiting the workspace as provisionally resolving approvals, or say the delay is accepted), and the tests should cover it.

**Minor**

4. "Activating the workspace" and "an already active workspace" are ambiguous on multiple monitors, because each monitor has an active workspace. Say whether "seen" means the focused workspace or any visible one.
5. Right-click to dismiss assumes Noctalia 5.3 doesn't already use right-click on bar widgets. It's a compiled binary, so I couldn't check locally. Make this an explicit check during planning, with a fallback gesture.
6. The spec says to use "the existing desktop notification service", but familiar has no notification path today (searched `src`, `bin`, `integrations`). Name the transport, presumably Noctalia's notification service.
7. Once native harness toasts are turned off, a stopped coordinator means agents send no toasts at all. The spec covers the widget's "disconnected" state, but should also say how a dead coordinator gets noticed, since it otherwise fails silently.
8. `bin/familiar-noctalia` already reads Noctalia's `settings.json`, which is a natural place to read the Do Not Disturb setting. The spec doesn't mention it.

What holds up: keeping seen, dismissed and resolved separate; dismissing by explicit episode IDs; saving the "already announced" mark before sending, with crash loss stated honestly; and keeping compositor details in `integrations/`.

For the task note, the session that owns fam-9c8dd1 (the parked Codex one) should record: `review: spec round 2 — verdict: revise; findings: Important 3, Minor 5; reviewer: claude-code/claude-opus-5-5`. Next: you rule on the turn-end marker question in item 2, then that session revises the spec as a new commit for the next round.
