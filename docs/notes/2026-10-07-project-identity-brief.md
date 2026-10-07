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
