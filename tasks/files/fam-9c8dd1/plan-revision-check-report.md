# Plan revision author checklist

Author: codex/gpt-6.1-sol, verified in this turn by `timeout 2 relay model --harness codex --pretty`, exit 0.
Repository: familiar.
Reviewed predecessor: e7fd381ec655fd3d9c434836c9e5ac5225cb61b1, docs/plans/2026-10-24-desktop-attention.md.
Replacement: d1776d018ebd018bdeea467bf7ce62185c96dd81, same path.
Replacement SHA256: 43596da61ad4c32898d4cd7f69c51a23278b3fa9b5c79ebc13b8bec85edfcdcd.
Accepted spec remains 2b58b29009267ac0978945515cdadc3309736a74, unchanged digest 80b40928412fd0ab43c63fcc5e20c64576ca695ed5542ef0bb610c052468d1b9.

The author checked all four Important findings and the Minor against pinned code and the revision. Every disposition has a Why/Cost ruling in the ledger. This checklist does not replace the next external/user plan review and records no new formal acceptance round.

- Navigation topology now has a fixed schema and an immediate independent writer. Its deterministic 100 ms budget includes an older write, worst polling phase, read and invalidation under explicit assumptions; native timing is not claimed. An independent, bounded read-only Niri polling route keeps normal navigation available through coordinator/feed failure, with stale-disabled state if the compositor is also unavailable.
- Attention lifecycle remains shared. Topology cannot dismiss/resolve requests. Focus takes the presentation lock only for captured unseen IDs, rechecked against current incarnations. Desktop workspace classification context is not the widget's live topology authority.
- The stable-ID action uses existing familiar CLI routing and shared contract ownership, with implementation in integrations. Source verification established Niri's socket reference and cross-output branch; no real action was sent. Preflight handles absent/already focused targets. Native acknowledgment is not asserted to prove focus, including disappearance races. Fake socket/output tests are explicit.
- Every production Luau module and entry callback runs under pinned Luau, not Lua 5.4. The harness's generated environments and module cache are language-native; JSON fixture conversion is limited to mocked host data and retains the real CLI view. It does not duplicate presentation logic. Source, runtime architecture, bootstrap digests and missing-tool failure are specified.
- Periodic widget work is separately bounded for finite arrival, sustained pulse and static states; the eight-hour test prevents a 16 ms overnight pulse. Service file polls do not invalidate unchanged widget presentation.
- The health notice has an independent current DND query, slot reservation, explicit unknown/on drop and generation-token recovery guard. It neither trusts dead-coordinator DND nor claims undocumented notify semantics.
- The author caught and removed a forward dependency during revision: Task 4 tests its 20 ms publication component; Task 6 owns the full 100 ms test after its plugin and Luau toolchain exist. State-directory overrides and workspace ID representation are explicit across file/CLI/UI boundaries. The accepted source, turn, dismissal and delivery contracts remain intact.

Verification at freeze: just check, tasks check and git diff --check passed; tasks check emitted no errors or warnings. Both release archive digests were verified; the private Linux Luau 0.743 capability probe passed three checks. The macOS archive was inspected as arm64, not executed. An initial assertion expecting a universal macOS binary failed and was corrected after header inspection and checking the current runner architecture; it is not represented as a successful universal-binary check.

No product tests, plugin execution, native focus, notification, DND transition or latency measurement ran during this revision. Product implementation remains blocked pending the separate plan review; full-suite baseline remains in execution Setup. Spec round-7 minor stays deferred and hq-4c954d still owns the native scheduling evidence. The task, owner prerequisites and retained evidence are kept for review, with no host pointer changes or activation.
