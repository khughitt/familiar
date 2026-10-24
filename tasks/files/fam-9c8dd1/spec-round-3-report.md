**Verdict: revise. Findings: Critical 0, Important 1, Minor 0.** Reviewed frozen commit `929d0a15dcb2a612247d2f628084bf03b16976d0`, `docs/specs/2026-10-24-desktop-attention-design.md`, against the pinned implementation. The controller should correct the completion-retention rule before planning.

**Important — Passive OpenCode idle updates can erase the promised completion marker.**

The spec’s lines 117–119 say any different state from the same source closes its previous episode, naming only completion-to-input upgrading as an exception. Lines 150–154 instead promise that completion survives until focus, dismissal, new root activity, or root end.

These rules conflict with the pinned OpenCode implementation:

- `.worktrees/desktop-attention/node_modules/relay/src/adapters/opencode.js:23` reduces `working → done` on the first idle event, but reduces `done → idle` on the next idle event.
- `.worktrees/desktop-attention/node_modules/relay/integrations/opencode/binding.js:41` queues the aggregate level on every supported event.
- `.worktrees/desktop-attention/node_modules/relay/integrations/opencode/window.js:14` permits repeated idle observations; its queue serializes pushes without deduplication.

Therefore, two idle updates after work ends can create the completion marker and then immediately remove it, despite no new work, focus, or dismissal. The general closure rule also permits cancellation of its queued announcement.

**Required change:** explicitly preserve completion episodes across passive `done → idle` observations, retaining their ID, disposition and delivery decisions without creating another arrival or reservation. Define genuine new activity as the superseding trigger. Require a test covering `working → done → idle → idle`, including restart and eventual clearing on new activity.

The eight earlier findings are otherwise addressed as follows:

1. **Root and worker isolation:** corrected. Familiar’s existing projection folds newer worker state into the root; the revised raw-row attention path avoids that behavior. Separate source episodes, root attribution, worker-only closure, root teardown and worker completion suppression match the available registry structure. Preserving Claude’s background-agent reduction is also correct.

2. **Actual input/completion coverage:** substantially corrected, subject to the finding above. The table matches the pinned adapters: Claude alone maps native input attention; Codex maps neither input nor error; OpenCode publishes aggregate levels and reduces active-to-idle into `done`. The spec correctly avoids synthetic input requests, distinguishes completion from questions, qualifies focus timing, and prevents a late Claude input notification from generating a second announcement.

3. **Approval uncertainty:** corrected. Claude/Codex have no mapped approval-result event. Their stale observation can persist without a finite bound, so historical wording and observation age are truthful. OpenCode does consume `permission.replied` and queues the recomputed aggregate level; the previous review’s blanket assertion that none of the three handles replies was inaccurate. The revised spec reflects that distinction.

4. **Focused versus visible:** corrected. Globally focused `is_focused` is now the explicit seen criterion; another monitor’s active workspace does not count as seen.

5. **Dismiss gesture:** corrected at the specification stage. Planning must inspect pinned bindings and perform a headless dispatch check, with explicit alternatives preserving navigation/settings behavior. This review does not establish which gesture works.

6. **Toast transport:** corrected. The named command, JSON fields and normal/low urgency are supported by [Noctalia v5.3.0’s IPC implementation](https://github.com/noctalia-dev/noctalia/blob/v5.3.0/src/app/application_ipc.cpp). Familiar’s existing code supplies no equivalent sender.

7. **Coordinator failure detection:** corrected as a buildable requirement. Independent heartbeat checks, a persistent disconnected indication, supervised restart and an independent plugin health notice address the silent-failure gap. The native notification function exists in [v5.3.0’s Luau host](https://github.com/noctalia-dev/noctalia/blob/v5.3.0/src/scripting/luau_host.cpp). Detection timing, DND behavior, freeze recovery and flap limiting remain validation obligations; they were not demonstrated here.

8. **DND adapter:** corrected. Existing `scheme-sync` reads only a scheme key and supplies no live DND contract. The validated `on`/`off` query matches [v5.3.0’s IPC handler](https://github.com/noctalia-dev/noctalia/blob/v5.3.0/src/app/application_ipc.cpp). Unknown state suppressing interruptions is explicit, and DND exit does not replay a backlog.

The pinned relay commit in the spec matches the lockfile. I also read familiar’s projection/observer flow, relay’s transaction and observer-envelope code, and OpenCode’s binding, aggregation and queue code. No further consequential contradiction emerged from those checks.

Reviewer identity: `codex/gpt-6.1-sol`, printed by a fresh `timeout 2 relay model --harness codex --pretty`; exit status 0.

Skipped runtime tests, headless gesture checks and live desktop validation; implementation feasibility remains subject to those checks. No files, tasks or host configuration changed, no alerts were emitted, and no processes were left running.
