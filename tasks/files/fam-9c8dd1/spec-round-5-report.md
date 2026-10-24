# Spec round 5 review

Reviewer: claude-code/claude-opus-5-5, as supplied by the user.
Frozen revision: familiar commit 4fdcb54ae7335e594b95b9578360cdcdbaac02e1,
docs/specs/2026-10-24-desktop-attention-design.md.

Revision `4fdcb54` still needs one more pass. My round-2 findings are all resolved and the new factual claims hold up, but three new gaps remain that could produce wrong markers or a recurring toast. I reviewed the frozen commit, which matches the working file (sha256 `9580200a…`). The task stays parked on your review; nothing was changed. My verdict is **revise**: three Important findings, three Minor.

**Verified:**
- The relay dependency is pinned at v0.1.1.
- The OpenCode plugin handles `permission.replied` (`node_modules/relay/integrations/opencode/window.js:20`).
- The installed `noctalia` binary accepts `notification-show` with a JSON payload (`app_name`, `summary`, `body`, `urgency`) and has `notification-dnd-status`. Note that `noctalia msg --help` only advertises `<summary> <body...>`, so the binary's error strings are the evidence for the JSON form.
- The harness coverage table matches the relay adapters.

**Important**

1. **Claude sub-agents can close a pending approval while the dialog is still open.** Only Codex identifies worker rows; relay has no worker ID for Claude (`adapters/index.js:29`, and there's no `workerIdOf` in `claude-code.js`). So a Claude sub-agent's tool-start event is recorded as root activity. If one sub-agent is waiting on a permission prompt while another keeps running, the root reads `working` and the "same source" rule closes the approval episode early. The spec's tests cover this case only for Codex, where the marker survives; on Claude the same scenario necessarily closes it. During planning, confirm that parallel sub-agents keep running while one waits for permission. Then the spec should either accept early closure on Claude as a documented limitation or count only some events as genuine activity. It should also add a Claude row to the test list.

2. **A worker that never reports finishing suppresses root completions for the rest of the session.** Relay deletes worker rows only when the root session ends (`src/bus/transaction.js:64-67`). Process liveness can't remove them, because they share the root's process. If a Codex worker ends without `SubagentStop` (an interrupt or a crash), it stays `working`. Then "root `done` is eligible only when no raw worker row remains working" silently suppresses every later "Turn finished" for that session, and nothing appears that the user could dismiss. A worker approval stranded the same way stays up until dismissed or the root ends. I haven't verified whether Codex sends `SubagentStop` on interrupt. Either way, the spec needs a stale-worker rule, or at least a visible diagnostic when a worker suppresses completion, and a test.

3. **It's unclear whether a completion already cleared by focus still counts as "recorded".** Focus clears a completion marker, and the late-input rule upgrades "the same completed root turn" only when a completion is recorded. If cleared means not recorded, every Claude turn you watched to the end gets an ordinary input episode about a minute later: a popup and toast on the workspace you're looking at. That's the most common path. The fix is a short statement: a focused, seen, or cleared completion stays the turn's recorded completion until that root's next genuine activity.

**Minor**

4. The heartbeat is written every 2 s, and "all writers use one locking discipline" could put it under the presentation lock that hook-driven projection also takes. Say that it has its own file and doesn't contend with that lock.
5. When live DND state is unknown, "without starting new interruptions until live state is known" doesn't say whether queued effects are dropped or delivered later. Given "no backlog replay" elsewhere, dropping seems intended; say so.
6. The "Approval requested — response unconfirmed" label is introduced right after Claude/Codex, and "Label these episodes" doesn't say whether OpenCode approvals, which do get reply evidence, carry it too.

Not checked: Niri's `is_focused` field, the Noctalia plugin runtime API (right-click dispatch, notifications, DND from Luau), and the timing of Claude's idle notification.

For the task's session to record: `review: spec round 5 — verdict: revise; findings: Important 3, Minor 3; reviewer: claude-code/claude-opus-5-5`. That session revises the spec into a new frozen commit for round 6. Item 1 can be settled by documenting the limitation if planning confirms the behaviour, so it needs no decision from you.
