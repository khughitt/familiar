# External implementation plan review, round 1

Reviewer: claude-code/claude-opus-5-5, identity supplied by the user.
Repository: familiar.
Frozen revision: e7fd381ec655fd3d9c434836c9e5ac5225cb61b1.
Path: docs/plans/2026-10-24-desktop-attention.md.
Verdict: revise; Important 4, Minor 1.
The following is the full review relayed by the user.

The plan needs revision before execution. Its replacement workspace widget depends on capabilities Noctalia plugins don't have, and the plan doesn't say how it gets them. The rest is detailed and closely follows the accepted spec. I reviewed frozen commit `e7fd381`, which matches the working file (sha256 `754196fb…`). The task stays parked on plan review. Its author session revises the plan into a new frozen commit for the next round; nothing here needs a decision from you yet.

My verdict is **revise**: four Important findings, one Minor. All four Important findings sit in Tasks 4 and 6; Tasks 1–3, 5 and 7 hold up.

**Important**

1. **The bar's workspace switcher now depends on the familiar coordinator, with nothing planned for its speed or failure.** Noctalia's [runtime API](https://docs.noctalia.dev/noctalia/plugins/development/runtime-api/) gives plugins no workspace list, no workspace events and no per-output workspace state. That's why the plan has the coordinator publish the full workspace list. But the plugin replaces the built-in `workspaces` widget, so ordinary switching inherits the whole chain:
   - The chain is: a Niri event, a 100 ms debounce, two `niri msg` calls, then the shared presentation lock.
   - That lock is the one every agent hook waits on, and a waiting process polls it every 20 ms (`src/bus/lock.js`).
   - Next comes an atomic write and a 250 ms plugin poll. The active-workspace highlight could trail the built-in widget by a few hundred milliseconds. I haven't measured that figure.
   - If the coordinator dies, you lose the switcher, not just the alerts.
   - Every focus change also takes the lock that every hook on the machine waits for.

   The plan should:
   - publish workspace topology outside the episode lock (like the heartbeat file), and write focus changes immediately;
   - set a latency budget with a test;
   - define what the switcher shows while the coordinator is down;
   - take the lock only when seen state actually changes.

2. **Clicking a pill can't focus its workspace by stable ID through the obvious route.** The plan says left click "focuses its stable workspace ID" but names no mechanism, and plugins have no focus call. `niri msg action focus-workspace` takes only an index or a name (checked against the installed niri 26.04). An index is relative to the focused monitor, so clicking workspace 2 on the bar of your second monitor would focus workspace 2 on the first. As far as I know, Niri's JSON socket protocol does accept an ID reference, but I haven't verified that. The plan should name a route that focuses by ID, such as a small familiar command that writes that request to `$NIRI_SOCKET`. It should also test a click on an unfocused monitor.

3. **A waiting request makes the bar redraw at about 60 frames per second for as long as it stays unseen.** Task 6 Step 6 uses 16 ms updates "during finite arrival/pulsing". The slow pulse lasts until you visit the workspace, which may be overnight. A low-amplitude, roughly 4-second pulse doesn't need that rate. Reserve 16 ms for the 200–350 ms arrival and use roughly 100–250 ms for the pulse. Bound and test the sustained cadence the way the static cadence is.

4. **The plugin tests run under Lua 5.4, but Noctalia runs Luau.** The plan restricts only `presentation.luau` to a "Lua-compatible" subset, yet the host mock also calls real callbacks in `widget.luau` and `panel.luau`.
   - The two languages differ in syntax: type annotations, `continue` and compound assignment are Luau-only.
   - Number handling also differs: Lua 5.4 separates integers from floats, while Luau numbers are all doubles.
   - So tests can pass on code Noctalia rejects or runs differently, and review focus item 4 depends on these tests.

   `luau` is packaged (Arch `extra`, version 0.743, not installed here) and has release binaries for CI. Run the contract tests with it, and drop the subset restriction.

**Minor**

5. **Task 6 doesn't say how the plugin's health notice respects Do Not Disturb.** The plugin API exposes no DND state. The coordinator's DND reading is exactly what's missing when the coordinator is dead. Either have the plugin query `noctalia msg notification-dnd-status` itself, or verify that `noctalia.notify` already obeys DND, and record which.

**Holds up:**
- The model, store and CLI contracts are coherent, and the five review-focus items each have named tests.
- Capturing attention before visual failures matches the spec.
- Task 7 treats merging through live pointers as activation, which is correct here because hooks and the QML source resolve into main.
- Choosing a left-click Alerts panel over modifier chords follows the planning evidence.
- The relay exports the plan relies on (`adapterFor`, `applyEvent`, `readSnapshot`, the boot ID in the process handle) exist in v0.1.1.

For the task's session to record (no plan rounds are noted on the task yet): `review: plan round 1 — verdict: revise; findings: Important 4, Minor 1; reviewer: claude-code/claude-opus-5-5`. The round-7 minor stays deferred as ruled.

I didn't measure latency, run any plugin code, or confirm Niri's ID reference form; the Noctalia API facts come from its published docs, not a local check. I made no changes, and nothing is left running.
