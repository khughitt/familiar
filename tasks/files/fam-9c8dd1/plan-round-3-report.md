# Plan round 3 acceptance

Reviewer: claude-code/claude-opus-5-5, identity supplied by the user.
Repository: familiar.
Frozen revision: d1776d018ebd018bdeea467bf7ce62185c96dd81.
Path: docs/plans/2026-10-24-desktop-attention.md.
Verdict: accept; Minor 2.
The following is the full review and instruction relayed by the user.

I accept the revised plan, `d1776d0`. All five round-1 findings are fixed with tests, and the two remaining issues are minor. I reviewed the frozen commit, which matches the working file (sha256 `43596da6…`). The plan gate is now yours: if you accept it, the owning session records the acceptance, unblocks the seven steps and starts execution Setup with the full-suite baseline. Approving the plan still authorizes no live desktop, gesture or notification work.

**How the round-1 findings were resolved:**
- **Switcher dependence (I1):** workspace navigation now has its own lock-free topology file, written immediately on Niri events.
  - The plugin falls back to its own read-only `niri msg -j workspaces` query when the feed fails, so ordinary switching survives coordinator death.
  - Focus changes take the presentation lock only when unseen episodes are actually on the newly focused workspace.
  - There's a 100 ms end-to-end budget test with the lock held for 2 s, and the native pilot has to measure p95 ≤ 100 ms before the built-in widget is replaced.
- **Focus by ID (I2):** a new `familiar niri focus ID` sends Niri's `FocusWorkspace` request with an `Id` reference over the socket, and is tested with workspace index 2 on two outputs. I checked one risk in Niri v26.04's `src/ipc/server.rs`: the server accepts several requests on one connection, so the helper's "Workspaces" query followed by the focus action works on a single socket.
- **Redraw rate (I3):** updates are now 16 ms for the arrival, 200 ms for the sustained pulse and 2000 ms when static, with an eight-hour fake-clock test that bounds the rate.
- **Test runtime (I4):** all plugin entries and callbacks run under a pinned, hash-verified Luau 0.743 in both CI jobs, with no Lua 5.4 fallback.
- **Health-notice DND (M5):** the plugin queries `notification-dnd-status` itself before a health notice and drops the notice unless the answer is exactly `off`.

**Minor (deferred, not blocking):**
1. **`runAsync` with a timeout may not exist.** The plan calls `noctalia.runAsync(argv, callback, 2000)` for the fallback query, the DND query and focus clicks. Noctalia's published API documents only `runAsync(cmd)` and `runAsync(cmd, cb)`. The callback does report `timedOut`, but the docs don't say how long the timeout is. The installed binary's internal `runAsync` takes an options argument, but that doesn't show the Luau binding exposes it. If it doesn't, "bounded to 2000 ms, never overlapping" isn't enforced, and one hung `niri msg` stalls the fallback. Task 6 should cite the pinned 5.3 binding source for the third argument, or enforce the bound in the plugin by tracking start times and ignoring late callbacks.
2. **Each click waits for a Node start-up.** Every pill click spawns the `familiar` CLI. A cold `familiar --help` took 0.10–0.13 s here, before the socket exchange, while the built-in widget reacts instantly. The 100 ms budget covers event to widget only. Add click-to-focus to the native pilot's measurements, and keep the `niri focus` route's imports minimal.

**Bookkeeping:**
- The task has two notes labelled `plan round 1`: the Codex self-review accept and my revise. Mine was effectively round 2.
- For the owning session to record: `review: plan round 3 — verdict: accept; findings: Minor 2; reviewer: claude-code/claude-opus-5-5`.
- Both minors should go to the ledger as `minor (deferred)`, alongside the spec's round-7 minor, which is still deferred to hq-4c954d.

I didn't run any plugin or native code; the `runAsync` and Niri facts come from published docs, the v26.04 source, and strings in the installed binary. I made no changes, and nothing is left running.

Keith: accepted. After marking the plan accepted, let's park the task so that execution can start in a fresh session.
