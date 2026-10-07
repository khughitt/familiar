# Project identity ownership and worktree pins

Scoping handoff, 2026-10-07. Goal: fam-74f6e9. Members: fam-60d716,
fam-a940d1 and fam-a877b3.

## Problem

A project's familiar should follow its deliberate visual choices across working
contexts without copying machine paths between hosts. Three ideas intersect here:
project discovery, worktree pin inheritance, and pin storage. Settle these contracts
before changing identity resolution or moving existing pins.

## Current behaviour and evidence

- At engine commit `182db5a`, `src/bus/identity.js` chooses normalized origin,
  then checkout root, then cwd as the project key; the display label is the
  checkout basename. `src/bus/pins.js` matches remote, exact canonical path, then
  project name. A parent's path or name pin therefore does not match its worktree.
  The matching rule dates to import `be32dd0` and remains unchanged.
- `bin/familiar.js` shares that resolver between `whoami` and `projects`;
  `projects` defaults to path pins, rather than a complete project registry.
  This command landed in `ece3963`. Hooks and `src/install/codex.js` also
  resolve from the pin catalog.
- `src/bus/paths.js` reads `identities.yaml` under the config directory.
  It uses `FAMILIAR_CONFIG_DIR` and `FAMILIAR_STATE_DIR`, with home-relative
  defaults; it does not currently honor `XDG_CONFIG_HOME` or `XDG_STATE_HOME`.
  Production callers load the file; the engine has no identity-catalog writer.
  Pins include authored slots and theme member choices as well as machine paths.
- The original storage report calls this an engine write. `dots-85a593`
  instead records an editor's atomic save replacing a Dropbox-ignored inode.
  That host incident is source-reported; the current reader code supports its
  correction of the writer premise.
- `ops-22af0d` records semantic identity ownership in ops and path ownership in
  tasks. `ops-df0842` remains briefed on shared visual identity, with
  `ops-b31634` researching the minimum mapping/format. These task records
  establish the overlap; a Familiar consumer contract is still unresolved.

## Constraints

`docs/specs/2026-09-05-codex-identity-parity-design.md` section 6.2 explicitly
excludes worktree inheritance from Codex convergence. Its ancestry suggestion
needs revision: this checkout's `.worktrees/` resolves onto external storage.
Git reports distinct worktree roots with a shared Git common directory, so path
containment cannot establish repository membership.

`fam-6e8321` already owns relay identity consumption and presentation migration;
visual pins stay with Familiar. Preserve explicit pins, remote/path/project
specificity, bounded Git calls, and operation without ops, tasks or Mindful
installed. A relocation must preserve authored choices and settle old/new
location conflicts before any cutover; no permanent compatibility layer is assumed.

## Alternatives

1. Keep exact checkout matching and the whole catalog in config. This is the
   smallest change but leaves worktree identity differences and requires a host
   solution for machine paths.
2. Inherit through Git's worktree relationship, keeping explicit worktree
   overrides, and separate portable choices from local paths only where needed.
   This is the current lean; Git metadata supports worktrees outside the checkout.
3. Move the whole catalog to local state and source discovery/mapping from the
   registered projects. This directly addresses sync, but risks treating authored
   choices as disposable state and adds an unresolved mapping dependency.

Prefer option 2 over a blanket ancestry match or immediate whole-file move.
Reuse `ops-b31634` before designing a new shared visual format.

## Unanswered questions

- Which checkout-level overrides win over inherited pins, and how do project
  labels and keys behave without a remote? fam-9ab24c will frame a
  reviewable rule and its checks.
- Which fields are portable authored configuration, and what is the smallest
  safe local storage/cutover contract? fam-090b35 will trace the readers,
  classify the fields and recommend a boundary.
- Does Familiar need semantic metadata, directory discovery, or visual mapping
  from ops/tasks? `ops-b31634` supplies existing research; explicitly rerun
  `/scope fam-60d716` after its finding to decide the Familiar deliverable.

## Proposed decomposition

- fam-74f6e9: coordinate this identity effort alongside rendering and relay work.
- fam-9ab24c: planned, high-complexity design for worktree inheritance;
  wakes `fam-a940d1` with the agreed contract.
- fam-090b35: direct, mid-complexity bounded storage investigation;
  wakes `fam-a877b3` with the finding.
- Reuse `ops-b31634` for `fam-60d716`, preserving its original source and body.
  Its current completion instructions wake `ops-df0842`; the explicit Familiar
  rerun above avoids assuming that it also reopens this idea.

All three members remain ideas. The local follow-ups add a finding note to their
waiting idea in the same commit as their result; this handoff is a brief, not an
approved design.

## Storage investigation result — fam-090b35

Investigated against engine `dff8a13` on 2026-10-07. Recommendation: keep pins
as authored configuration and keep one catalog. When its backing directory is
synced, provide an explicit `FAMILIAR_IDENTITIES_FILE` override to an absolute
file path in a machine-local configuration directory outside that sync tree.
Retain the current config-directory default. This override is proposed, not
implemented. Do not move the catalog automatically into runtime state or add a
second catalog and merge rules.

### Ownership classification

| Input | Ownership and portability |
| --- | --- |
| `remote` | Authored repository selector, portable when hosts use the same normalized origin. Matching is case-insensitive; catalog values must already use the normalized host/owner/name spelling. |
| `project` | Authored, case-sensitive basename alias, portable when names agree. It intentionally applies to unrelated repositories with that name; it is not a stable project identifier. |
| `path` | Authored checkout selector, normally machine-local. Absolute paths, symlinks and `~/` can resolve differently on each host. A shared spelling is safe only when its meaning has been deliberately established on each host. Relative paths resolve against the invoking process's cwd, not the catalog directory. |
| `slot` | Authored visual choice, portable across themes; not disposable state. Every pin requires a valid slot. |
| `members` | Authored theme-to-member overrides, portable with the corresponding theme installed. An inactive theme's entry is inert; an unknown active member or member/slot conflict fails resolution. |
| Entry order / combined selectors | Authored behavior. The parser permits multiple selectors on one entry; matching tests remote, path, then project across the full catalog, taking the first match within a tier. Splitting entries by field or reordering them can change the answer. |
| `projectKey`, resolved member/color, bus records and intent | Derived runtime data. These belong to the state/projection path, not to the authored pin catalog. |

Only `path` introduces a filesystem binding. A pin containing `path`, `slot`
and `members` is still authored configuration; its local selector does not turn
the visual choices into generated state. The single catalog may be entirely
local when even one binding differs by host. Portable entries can be maintained
deliberately across hosts without introducing automatic synchronization or a new
shared schema; `ops-b31634` still owns the shared visual mapping investigation.

### Readers and writers

The two production file reads are `context()` and `identityResolver()` in
`bin/familiar.js`; both call `loadIdentities(paths.identitiesPath)`.

- `context()` supplies hooks, statusline, reap and pet installation. Hooks and
  statusline use `makePrepareSprites()` → `resolveIdentities()` →
  `resolveIdentity()` → `matchPin()` and `pinnedMember()`. The transaction writes
  agents and intent, not the catalog. Reap uses the same catalog when resolving
  a changed bus.
- `identityResolver()` supplies `whoami` and `projects`, using the same matcher
  and resolver. With no directory arguments, `projects` enumerates only path
  pins. Removing those entries would change discovery as well as pin matching.
- `src/install/codex.js` receives the complete catalog. `--sync-projects`
  enumerates path pins plus cwd and resolves each through the shared identity
  functions. Its writes target project Codex configs and Git exclusions.
  `src/install/codex-converge.js` receives that catalog and an already resolved
  member for one checkout; it never reads or writes `identities.yaml` itself.
- Renderers consume resolved intent; the production search found no separate
  catalog reader or catalog writer in the engine or integrations.

`loadIdentities()` treats an absent file as an empty catalog. Invalid YAML,
invalid slots and read errors other than ENOENT propagate. The parser does not
enforce one selector per entry or reject duplicate selectors; preserve the
existing list rather than interpreting or deduplicating it during a cutover.

### Paths and reproduced evidence

`paths()` currently chooses `FAMILIAR_CONFIG_DIR`, otherwise
`HOME/.config/familiar`, and `FAMILIAR_STATE_DIR`, otherwise
`HOME/.local/state/familiar`. Neither XDG root variable is consulted. The
installation guide documents the default `~/.config/familiar/identities.yaml`;
there is currently no per-file override. OpenCode's own config root honors XDG
in its installer, which does not change Familiar's path contract.

A temporary-directory Node probe imported `paths()`, `loadIdentities()`,
`matchPin()` and `pinnedMember()` directly and passed these checks:

1. Changing only `XDG_CONFIG_HOME` / `XDG_STATE_HOME` leaves the home-relative
   Familiar defaults unchanged; the Familiar directory overrides do take effect.
2. A catalog placed only under the overridden state directory is ignored.
3. Remote > path > project and first-entry behavior preserve combined selectors;
   an active theme reads its member override and an inactive theme returns none.
4. Reading leaves catalog bytes unchanged; a byte-for-byte copy loaded by
   explicit path produces the same catalog; malformed YAML rejects.

The fixture was removed in `finally`. Baseline `just test-fast`: 1,018 tests,
1,013 passed, five expected skips for absent theme/platform inputs, zero failed.
No live config, Dropbox attribute or dotfiles wiring was touched. The editor
atomic-save incident remains source-reported by `dots-85a593`; this probe did
not reproduce that host incident or establish how a particular editor treats
file symlinks. A leaf symlink is therefore not a proven fix for that writer.

### Minimum follow-up and cutover contract

The smallest engine follow-up is an optional absolute `FAMILIAR_IDENTITIES_FILE`
in `paths()`, shared by both existing loaders. Reject an empty/relative override
and fail on a missing explicitly selected file, since falling through to an
empty catalog would silently replace deliberate choices with automatic slots.
The unset default retains its current missing-file behavior. If changing the
whole configuration directory is acceptable, the existing
`FAMILIAR_CONFIG_DIR` already selects a local backing without a new engine
feature; it also relocates scheme, theme and receipt paths, so it is broader
than this problem. General XDG support is separate work, not a prerequisite.

For an eventual, separately authorized host cutover:

1. Inventory and back up the old catalog and any file at the proposed local
   target. Choose a directory whose physical location is outside sync. Record
   old/new paths and environment wiring, preserving permissions as well as bytes.
2. If both locations exist and differ, stop before wiring either: compare the
   authored lists and obtain a deliberate choice or reviewed reconciliation.
   Identical files can reuse the target. Never use mtime, a union, or entry
   deduplication to select a winner; do not overwrite a differing target.
3. Copy, do not move, the chosen complete catalog. Validate selectors/slots and
   active theme member consistency; compare resolution for representative
   remote, path and project pins, including missing directories, inactive themes
   and combined selectors. Preserve entry order and relative-path semantics.
4. Set the same override for interactive CLI and every hook-launch environment.
   Check both resolver entrypoints against the copy before removing the old
   location or its sync exclusions. Each invocation reads exactly the selected
   file; the engine does not combine old and new catalogs or auto-migrate them.
5. Roll back by restoring the previous environment wiring and the backed-up old
   catalog. Preserve subsequent edits to the new catalog separately before any
   reconciliation; verify the old identities before deleting either backup.

Required engine checks belong in `test/paths.test.js` and `test/pins.test.js`,
plus CLI coverage in `test/bin-familiar.test.js` for both loaders and explicit
missing-file diagnostics. Cover default behavior, override validation, conflict
non-merging, unchanged pin precedence/member choices and state-only files.
Document actual environment precedence, authored/local ownership and the
copy/verify/cutover/rollback procedure in `docs/install.md`. Installation and
project listing must still receive the whole catalog. Host wiring belongs to
dotfiles and needs its own authorization; no migration implementation is part
of this result.

The blanket state relocation suggested by `fam-a877b3` should be reconsidered
using this finding. The worktree design can proceed independently with the
existing single-catalog contract.

## Worktree design handoff — fam-9ab24c

The approved `docs/specs/2026-10-07-worktree-pin-inheritance-design.md` defines
the Git anchor, pin tiers, remote-less keys, current-worktree labels,
per-worktree Codex targets and runtime-record transition. The user accepted
the revised spec at `842c20d`; it is an agreed design, not implemented behavior.
The written plan is `docs/plans/2026-10-07-worktree-pin-inheritance.md` and
still needs review. `fam-169e3f` owns its four blocked execution steps;
`fam-9ab24c` remains the design/plan deliverable.

After the user's revise verdict, the spec now uses a combined `rev-parse`
query rather than listing sibling worktrees: two discovery spawns for main
checkouts and three for linked checkouts, with explicit newline-path recovery.
It requires a new own-property guard for old records, names the shared Git
exclusion write, and adds before/after hook latency measurements. Bare `.git`
anchors omit the inherited name alias; other suffixes remain verbatim. The
revised written spec passed user review; plan review still gates execution.

Git fixtures uncovered a separate-directory main-path limitation. Upstream
searches and source checks found no matching correction in the searched
surfaces; `docs/notes/2026-10-07-git-main-worktree-report.md` is a prepared,
unpublished report following Git's mailing-list guidance. Publishing it needs
separate approval and does not block reviewing the Familiar design.
