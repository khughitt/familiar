# Familiar Tasks migration ledger

**Status:** Migration complete. The two reviewed migration commits were integrated on
2026-08-30, the stable checkout was registered as `fam`, no dependency reconciliation is
pending, and this ledger is historical/superseded.

## Scope and evidence

| Field | Value |
| --- | --- |
| Stable checkout HEAD | `9a5f664178cefcd3733507af28846245a2b1fc03` on `main` |
| Tasks source commit | `e04d6a0347a95f22324e81b79d07821cf34a83c5` |
| Audit date | 2026-08-30 |
| Prefix | `fam` |
| Audit order | code, tests, and configuration; commit ancestry; branches and linked worktrees; documents |

The denominator is every tracked file under `docs/`, this ledger, and existing root
guidance. The baseline suite passed after the repository-documented fresh-worktree
`npm ci` setup: 852 passed, zero failed, and five platform skips.

## Git state inspected

| Branch or worktree | Commit | Read-only disposition | Dirty paths |
| --- | --- | --- | --- |
| Stable `~/d/familiar` worktree, `main` | `9a5f664178cefcd3733507af28846245a2b1fc03` | Stable authority checkout containing both reviewed migration commits; canonical normal-registry target | None |
| Finalization `~/d/familiar/.worktrees/tasks-migration-fam-finalize`, `docs/tasks-migration-fam-finalize` | `9a5f664178cefcd3733507af28846245a2b1fc03` before finalization | Dedicated post-integration ledger correction | None before finalization; ignored `node_modules` installed by `npm ci` |
| Original migration `~/d/familiar/.worktrees/tasks-migration-fam`, `chore/tasks-migration-fam` | `9a5f664178cefcd3733507af28846245a2b1fc03` after the first fast-forward | Reviewed migration source; removed during integrated-pilot cleanup, with current stable tests and Tasks gates reconfirming the result | None before removal; ignored `node_modules` was worktree-local setup |
| `elements-machinery` | `f2dadf9832e5282be8911750e095773ecd61fbdd` | Ancestor of `main`; completed history, no linked worktree | None inspectable |
| `spike/macos-agent-handoff` | `6fe3eaf16709ba791c77535e280b40f7ae8c3504` | Diverged disposable capture history; no linked worktree and no ownership evidence | None inspectable |
| `spike/macos-terminal-gate` | `8e824ab7d0c3dad20b622dc50d907bd45d0be965` | Diverged disposable capture branch; the plan forbids merging its tee, and reviewed apparatus landed separately on `main` in `ecf90de` | None inspectable |

No branch name was treated as proof of active work or ownership. The current linked
worktrees are the clean stable checkout and the dedicated finalization worktree; the
original migration worktree and branch were removed after integration.

## Document classification

| Document | Classification | Audit basis |
| --- | --- | --- |
| `AGENTS.md` | authority/current | Root repository guidance; test and theme-package rules match configuration and imports. |
| `README.md` | authority/current | User-facing platform, install, and provisional-rendering summary; checked against package metadata and current support evidence. |
| `docs/install.md` | authority/current | Current setup and platform guidance; commands and support boundaries checked against CLI tests, implementation, and gate evidence. |
| `docs/plans/2026-08-18-theme-add.md` | historical/superseded | Executed implementation plan; unchecked authored boxes are not remaining work. |
| `docs/plans/2026-08-19-publication-gate.md` | historical/superseded | Executed publication plan; outcome is proven by its implemented spec and execution notes. |
| `docs/plans/2026-08-30-familiar-tasks-migration.md` | historical/superseded | Completed audit, candidate, task-ID, integration, registration, and verification record; no deferred dependency remains. |
| `docs/ref/2026-08-19-publication-gate-notes.md` | historical/superseded | Closed publication evidence and scan dispositions. |
| `docs/ref/2026-08-23-macos-agent-process-spike.md` | historical/superseded | Closed physical ancestry/executor evidence; later support evidence supersedes its provisional rendering boundary. |
| `docs/ref/2026-08-24-gate-runbook-amendments.md` | active delivery | Required corrections for any hardware rerun; current fix annotations checked against `main`. |
| `docs/ref/2026-08-24-macos-terminal-gate-handoff.md` | active delivery | Executed but reusable hardware runbook governing the remaining OpenCode verification. |
| `docs/ref/2026-08-24-macos-terminal-smoke.md` | authority/current | Reviewed physical-Mac evidence and source of current provisional boundaries. |
| `docs/ref/kitty-graphics-protocol.md` | authority/current | Current protocol and renderer reference; current surface links and implementation claims checked. |
| `docs/specs/2026-08-18-theme-add-design.md` | historical/superseded | Implemented design; HTTPS smoke and cutover status supported by history and tests. |
| `docs/specs/2026-08-19-publication-gate-design.md` | historical/superseded | Implemented design; status supported by execution notes and merged history. |
| `docs/specs/2026-08-22-macos-support-design.md` | authority/current | Governing support boundary and remaining-work authority, checked against current implementation, tests, and gate evidence. |
| `docs/superpowers/plans/2026-08-22-macos-process-runtime-and-ci.md` | historical/superseded | Executed plan; all implementation tasks landed and its terminal task was superseded. |
| `docs/superpowers/plans/2026-08-22-macos-setup-and-docs.md` | historical/superseded | Completed setup/documentation plan with checked steps and matching current CLI. |
| `docs/superpowers/plans/2026-08-22-macos-theme-portability.md` | historical/superseded | Completed portability plan with checked steps and matching platform tests. |
| `docs/superpowers/plans/2026-08-24-macos-terminal-gate.md` | historical/superseded | Executed gate plan; remaining outcomes are governed by the current design and rerun documents. |
| `docs/surfaces.md` | authority/current | Current surface contract and support boundary, checked against renderers, tests, and physical evidence. |

## Drift corrections

| Document and claim | Evidence | Correction | Outward-grep result |
| --- | --- | --- | --- |
| `docs/plans/2026-08-18-theme-add.md` had only unchecked steps despite completed work. | Implemented spec status, `d63f035`, theme modules/tests, and the green baseline. | Added an explicit complete/historical status without rewriting the plan. | `README.md`, `docs/install.md`, and the theme design already describe the shipped command and public install path. |
| `docs/plans/2026-08-19-publication-gate.md` had only one checked step despite a closed gate. | Implemented spec status, `ff26eba`, publication notes, licenses, public dependency, and CI configuration. | Added an explicit complete/historical status without changing the execution record. | The publication spec and notes already agree that the gate closed; no current user-facing document repeats an unimplemented claim. |
| `docs/superpowers/plans/2026-08-22-macos-process-runtime-and-ci.md` said ancestry evidence and Darwin activation remained pending. | All Task 1–6 steps are checked; `5bbe89f` and its prerequisites are ancestors of `main`; current adapters/tests and the 2026-08-23 evidence exist. | Corrected the status to Tasks 1–6 complete and retained Task 7's supersession. | `README.md`, `docs/install.md`, `docs/surfaces.md`, the macOS design, and process evidence all already describe activation as complete. |
| `docs/superpowers/plans/2026-08-24-macos-terminal-gate.md` retained an all-unchecked execution plan after the gate ran. | `cf59c77`, `bf37e7b`, `ecf90de`, and the executed smoke note are on `main`; capture commit `8e824ab` remains deliberately outside ancestry. | Added an explicit executed/historical status while preserving authored checkboxes. | Current install, surfaces, design, handoff, and smoke documents agree on the partial promotion and provisional OpenCode boundary. |
| `docs/specs/2026-08-22-macos-support-design.md` §11.8 described the OpenCode `.jsonc` installer defect as current. | `bf088b8` is an ancestor of `main`; implementation and tests handle the two configs independently. | Marked the finding fixed by `bf088b8`. | `docs/install.md` and the runbook amendments already describe independent handling; no competing current claim remains. |
| `docs/ref/2026-08-24-macos-terminal-smoke.md` §4 described both run-time configuration findings in the present tense. | `bf088b8` and `d53b59f` are ancestors of `main`, with focused tests in the green suite. | Kept the historical findings and explicitly recorded both later fixes. | Current install guidance, macOS design, and amendments agree; the provisional label now refers only to unverified live behavior. |
| `docs/ref/kitty-graphics-protocol.md` linked a split-era OpenCode design through an absent local path. | The path is absent from every local branch; root guidance names `familiar-archive` as the pre-split design authority. | Replaced the broken relative link with the archive URL. | The only occurrence was this reference; the repository-wide relative-link check now reports no real missing target. |
| This ledger said integration and stable registration remained pending and classified itself as active delivery. | `09a2d5a` and `9a5f664` are ancestors of stable `main`; the normal registry maps `fam` to the stable checkout; stable Tasks and repository gates pass; the original migration worktree and branch are absent. | Recorded the integrated commits and post-registration verification in the past tense, marked the migration complete, and classified the ledger historical/superseded. | Root guidance and current user-facing documents contain no competing pending-migration claim. |

The required outward search covered status headers, TODO/unchecked/supersession language,
root summaries, `docs/surfaces.md`, and active spec/plan references. No unresolved
contradiction was found.

## Candidate outcomes

| Outcome | Evidence | Sources | Active state | Size | Proposed status | Blockers | Disposition | Task ID |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ship bounded `familiar theme add` and cut over the real theme | Implemented modules/tests, HTTPS smoke, and implemented design status | Theme-add design and plan; install guide | Completed on `main`; `elements-machinery` is an ancestor, not active work | `xl` | — | None | no task — completed history | no task |
| Complete the three-repository publication gate | Implemented spec, execution notes, licenses, CI, and merged history | Publication design, plan, and notes | Completed on `main` | `xl` | — | None | no task — completed history | no task |
| Deliver the portable macOS core, setup, theme traversal, and CI | Current implementation/tests and all runtime/setup/theme plan tasks complete | macOS design and three 2026-08-22 plans | Completed on `main`; no active worktree | `xl` | — | None | no task — completed history | no task |
| Promote Claude Code and Codex rendering in the tested Kitty/Ghostty matrix | Physical evidence records both agents passing, and promotion commits are on `main` | macOS design, terminal gate plan, smoke note | Completed on `main` | `l` | — | None | no task — completed history | no task |
| Close gate-discovered Codex pet and OpenCode config installer defects | Fix commits `d53b59f` and `bf088b8` plus focused tests are on `main` | macOS design §11.8, smoke note §4, amendments | Completed on `main` | `m` | — | None | no task — completed history | no task |
| Verify OpenCode renderer fixes on macOS hardware | Both root-cause fixes are merged and CI-backed, but the live Kitty and Ghostty cells have not been rerun | macOS design Remaining work/§11; smoke note; handoff; amendments | No active branch, worktree, or verified owner; old spike branches are disposable history | `m` | `todo` | None | create | `fam-f088b1` |
| Exercise launchd-hosted Claude TTY discrimination | Design and smoke evidence leave the `tty !== null` half unmeasured in situ; `claude -p` 2.1.241 emits no level-bearing hook | macOS design Remaining work/§11.4; smoke note §3; amendments §7 | Parked with no active branch, worktree, owner, or known reproducible trigger | `m` | `idea` | None | create | `fam-36619e` |
| Merge the disposable macOS capture branches | Both governing documents explicitly forbid merging capture instrumentation; reviewed evidence/apparatus landed separately | Process spike, terminal handoff, terminal gate plan | Branch tips remain without linked worktrees and provide no ownership evidence | `s` | — | None | no task — abandoned by design | no task |

### Reviewed task body: Verify OpenCode renderer fixes on macOS hardware

Outcome: OpenCode's sprite pose transitions and `needs-approval` state are verified in
live Kitty and Ghostty sessions on the physical Apple Silicon Mac, earning or explicitly
denying the renderer's current provisional claim.

Acceptance evidence: Re-run the corrected OpenCode cells from the macOS terminal gate
after restoring the byte-level tee; record live state/bus observations and byte traces
showing pose changes for distinct states and a `needs-approval` transition in both
terminals, or preserve the provisional label with exact failures. Run the repository gate
and update current support docs and the evidence note in the same change.

Sources: `docs/specs/2026-08-22-macos-support-design.md` (Remaining work and §11),
`docs/ref/2026-08-24-macos-terminal-smoke.md`,
`docs/ref/2026-08-24-macos-terminal-gate-handoff.md`, and
`docs/ref/2026-08-24-gate-runbook-amendments.md`.

Uncertainty: The code fixes are merged and CI-backed, but neither has been exercised
against a live OpenCode; the disposable tee must be restored or reimplemented before
capture.

Initial fields: status `todo`; size `m`; tags `migration`, `macos`; spec
`2026-08-22-macos-support-design`.

### Reviewed task body: Exercise launchd-hosted Claude TTY discrimination

Outcome: A live launchd-hosted Claude chain proves the Darwin resolver skips a matching
TTY-less `claude` ancestor and targets the correct foreground terminal, or yields evidence
requiring an explicit design correction.

Acceptance evidence: Identify a reproducible launchd-hosted Claude invocation that fires
a level-bearing hook, capture its ancestry and terminal writes with the corrected gate
apparatus, verify the selected process/TTY and fail-closed behavior, and update the macOS
design and evidence note with the result.

Sources: `docs/specs/2026-08-22-macos-support-design.md` (Remaining work and §11.4),
`docs/ref/2026-08-24-macos-terminal-smoke.md` §3, and
`docs/ref/2026-08-24-gate-runbook-amendments.md` §7.

Uncertainty: Claude 2.1.241's `-p` mode did not fire a level-bearing hook, no replacement
trigger is known, the experiment requires a physical Mac, and no run is scheduled.

Initial fields: status `idea`; size `m`; tags `migration`, `macos`; spec
`2026-08-22-macos-support-design`.

## Deferred foreign dependencies

None.

## Verification

| Exact command | Result | Commit containing result |
| --- | --- | --- |
| `npm ci` | Added 105 ignored packages; completed with two known low-severity audit findings. | Setup only at stable base `3e9eaf1`; no tracked change. |
| `git status --porcelain=v1` after `npm ci` | Empty; fresh-worktree setup changed no tracked or untracked path. | Stable base `3e9eaf1`. |
| `npm test` before audit | 857 tests: 852 passed, zero failed, five skipped. | Stable base `3e9eaf1`. |
| `git worktree list --porcelain`, `git branch --format=...`, ancestry checks, and branch diffs | Two linked worktrees, five local branches including migration; no dirty pre-audit path; dispositions recorded above. | `09a2d5a26663fb44da37ac09ce1e4a58d757ee35` |
| Required status/outward `rg`, document coverage `comm -3`, and `git diff --check` | Outward matches reviewed; coverage comparison and whitespace check produced no output. | `09a2d5a26663fb44da37ac09ce1e4a58d757ee35` |
| Repository-relative Markdown link check over root guidance and `docs/` | No real missing target after repairing the archived OpenCode design link. | `09a2d5a26663fb44da37ac09ce1e4a58d757ee35` |
| `npm test` after documentation reconciliation | 857 tests: 852 passed, zero failed, five skipped. | `09a2d5a26663fb44da37ac09ce1e4a58d757ee35` |
| Normal-registry `tasks prime` before initialization | Exit 1 with explicit `no_project`; no normal registry entry or local store existed. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| Temporary-registry `tasks init --prefix fam` then `tasks prime` | Initialization succeeded; prime reported prefix `fam` with no warnings. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| `tasks add` then `tasks show fam-f088b1` in the temporary registry | `todo`, size `m`, tags `migration`/`macos`, spec and reviewed body all match; no owner or dependency inferred. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| `tasks add` then `tasks show fam-36619e` in the temporary registry | `idea`, size `m`, tags `migration`/`macos`, spec and reviewed body all match; no owner or dependency inferred. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| Temporary-registry `tasks check` plus `jq -e '.errors == [] and .warnings == []'` | Passed with empty errors and warnings. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| Temporary-registry `tasks prime \| jq -e '.prefix == "fam"'` | Passed; counts are one `idea`, one `todo`, and zero in every other state, with no warnings. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| Temporary-registry `tasks ready` | Passed; only `fam-f088b1` is ready, with no warnings. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| Final pre-integration `npm test` | 857 tests: 852 passed, zero failed, five skipped. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| Final pre-integration `git diff --check` | No output. | `9a5f664178cefcd3733507af28846245a2b1fc03` |
| `git merge-base --is-ancestor` for `09a2d5a` and `9a5f664` against stable `main` | Both reviewed migration commits are ancestors; stable `main` was exactly `9a5f664` before ledger finalization. | Post-registration ledger finalization (this commit). |
| Normal-registry mapping inspection and stable `tasks prime` | `fam` maps to the canonical stable checkout; prime reports prefix `fam`, one `idea`, one `todo`, and no warnings. | Post-registration ledger finalization (this commit). |
| Stable `tasks check` plus `jq -e '.errors == [] and .warnings == []'` | Passed with empty errors and warnings. | Post-registration ledger finalization (this commit). |
| Stable `tasks ready` plus exact ID comparison | Passed; only `fam-f088b1` is ready, with no warnings. | Post-registration ledger finalization (this commit). |
| Finalization-worktree `npm ci` then `git status --porcelain=v1` | Added 105 ignored packages with two known low-severity audit findings; setup changed no tracked or untracked path. | Post-registration ledger finalization (this commit). |
| Finalization-worktree `npm test` | 857 tests: 852 passed, zero failed, five skipped. | Post-registration ledger finalization (this commit). |
| `git worktree list --porcelain` and `git show-ref --verify refs/heads/chore/tasks-migration-fam` | The original migration worktree and branch are absent; only the stable and finalization worktrees are linked. | Post-registration ledger finalization (this commit). |
| Exact document coverage `comm -3`, seven-section count, and `git diff --check` | Coverage comparison and whitespace check produced no output; all 20 denominator files are classified and all seven required sections remain. | Post-registration ledger finalization (this commit). |
