Ready to merge: yes. The frozen branch meets all three documentation requirements. No Critical, Important, or Minor findings.

Reviewer: codex/gpt-6.1-sol  
Reviewed: `8222b63..fc1043d410654273c461af29e11a63984ef752f3`

### Strengths

- `.worktrees/docs-relay-cutover/docs/ref/kitty-graphics-protocol.md:3` removes only the misleading whole-document date. It makes no new claim that the reference body was revalidated.
- `.worktrees/docs-relay-cutover/docs/install.md:154` correctly makes `codex --no-daemon` conditional on daemon-hosted hooks, names the observed 0.160.1 version, and explains why disabling auto-start does not escape an existing daemon. This matches fam-ac775c and the observer’s terminal-ownership checks.
- `.worktrees/docs-relay-cutover/docs/install.md:160` preserves the distinction between Familiar presentation/project convergence and Codex’s independent native renderer. The automatic-selection guidance links back to the prerequisite.
- `.worktrees/docs-relay-cutover/docs/surfaces.md:20` assigns lifecycle events to relay, presentation and convergence to `familiar observe`, status-line cells to `familiar statusline`, native pet rendering to Codex, and OpenCode sprite rendering to Familiar’s TUI plugin.
- `.worktrees/docs-relay-cutover/docs/surfaces.md:127` accurately describes TUI-only Familiar registration, verified retired-server removal, unrelated-entry preservation, and manual JSONC/unverifiable-entry handling. Existing platform and tmux limits remain intact.

### Issues

- Critical: none.
- Important: none.
- Minor: none.

### Recommendations

No additional changes required for these tasks.

### Declined to judge

- The graphics reference’s remaining technical body: explicitly outside this removal-only task.
- Current status of unchanged upstream issues and proposals: outside the changed documentation contracts.
- Fresh hardware behavior and support across other Codex versions: this review checks the scoped claims against frozen source and the recorded pilot, without extending those claims.

### Verification and verdict

I inspected the frozen documentation diff, observer enrichment/convergence/emission flow, setup fragment, OpenCode installer and TUI renderer, status-line implementation, connected tests, and fam-ac775c evidence. No files or repository state were changed.

The controller reports passing baseline checks (fast: 1,331 passed, 5 skipped; slow: 10 passed), post-edit `just test-fast`, `just check`, `tasks check`, and `git diff --check`, with zero warnings. I did not rerun them.

**Ready to merge: yes.** The changes correct ownership and setup guidance without changing runtime behavior or overstating validation.

Not checked: live desktop, fresh hardware behavior, or the complete graphics reference. Remaining risk is limited to the documented version and platform validation limits.
