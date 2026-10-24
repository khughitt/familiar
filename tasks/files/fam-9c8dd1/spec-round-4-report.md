**Verdict: accept. Findings: Critical 0, Important 0, Minor 0.** The corrective revision resolves the remaining completion-retention contradiction. The controller can proceed to the written-spec approval gate.

Reviewed frozen commit `4fdcb54ae7335e594b95b9578360cdcdbaac02e1`, path `docs/specs/2026-10-24-desktop-attention-design.md`, using `git show`, against prior commit `929d0a15dcb2a612247d2f628084bf03b16976d0` and the full round-3 report.

- **Passive idle preserves completion.** Lines 117–120 explicitly exempt passive idle from the general same-source closure rule. Lines 151–158 require preservation of the completion ID, disposition and delivery decisions across `working → done → idle → idle`, reconciliation and restart, with no new arrival or reservation. This directly resolves the prior Important finding, including its queued-delivery consequence.
- **Clearing and replacement remain explicit.** Focus, dismissal, genuine new root activity and root end clear the marker. Genuine activity means mapped root prompt/before-tool/activity or transition back to working; idle, worker updates and reconciliation are excluded. A new actionable root request supersedes completion.
- **Claude upgrading remains consistent.** Lines 164–170 retain the same-turn completion-to-input exception, preserving ID, seen/dismissed state and delivery decisions without another popup/toast opportunity. Intervening root activity or a new incarnation ends that association.
- **Worker handling remains intact.** The correction applies to completion episodes, which workers never create. Worker `done` still closes that worker’s attention; worker updates do not clear a root completion. Existing root/worker isolation and completion suppression remain unchanged.
- **The required regression coverage matches the correction.** The new validation item explicitly covers the full idle sequence, identity and disposition retention, delivery decisions, reconciliation, restart, at-most-once announcement and eventual clearing on genuine root activity.

The pinned OpenCode implementation supports the motivating sequence: `src/adapters/opencode.js:23–26` reduces active-to-idle into `done`, then subsequent idle into `idle`; `integrations/opencode/binding.js:41–44` queues each supported aggregate update; `window.js:11–14` accepts repeated idle observations; and `queue.js:6–20` serializes without deduplicating. The frozen lockfile pins relay to `4ceec5d2ad22b136b37ee360e7a4ed00949f28d9`. No new consequential contradiction emerged within the corrective scope.

Reviewer identity: `codex/gpt-6.1-sol`, printed by a fresh `timeout 2 relay model --harness codex --pretty`; exit status 0.

Skipped unrelated architecture review, runtime tests and desktop validation; the specified behavior still requires implementation tests. No files, task records or host settings changed, no pushes or alerts occurred, and no persistent processes were launched; the worktree remained clean.
