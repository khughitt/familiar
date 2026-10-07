# Worktree pin inheritance

Draft for user review, 2026-10-07. Task: `fam-9ab24c`; source:
`docs/notes/2026-10-07-project-identity-brief.md`. Engine baseline: `1bc3d3e`.
No implementation plan or behavior change has been approved yet.

## Intent and scope

A repository's familiar should follow its deliberate visual choices into its
Git worktrees, including worktrees reached through symlinks or stored outside
the main checkout. Preserve deliberate worktree overrides, the current pin
specificity, and bounded cosmetic hooks. This interprets the brief's preferred
Git-based approach as the design default; the user can change it at review.

This design changes Familiar's visual identity context and matching. It does
not move pin files, introduce a project registry, migrate to relay, discover
every worktree for bulk installation, install themes, or change live host wiring.
The storage investigation found authored configuration, not generated state;
one catalog remains the input. Its proposed file-location override is separate.

## Alternatives

1. **Use Git's repository relationship, with exact worktree overrides.** Select
   this: external worktrees are still related, and nested unrelated repositories
   cannot inherit by accident. Reuse the existing identity and pin functions.
2. **Keep exact checkout matching.** Smallest code change, but retains the
   inconsistency between parent pins and worktrees, including remote-less hashes.
3. **Match filesystem ancestors or introduce an ops registry.** Ancestry misses
   externally stored worktrees and can cross unrelated nested repositories; a
   registry adds an unnecessary dependency and duplicates ongoing ops/relay work.

## Identity contract

Add one field to the internal Git context and visual bus records:

| Field | Meaning |
| --- | --- |
| `remote` | Normalized effective origin for the invoking checkout, or null. |
| `repoRoot` | Physical root of the current checkout, or null outside a worktree. This remains the write target for a project's Codex config. |
| `repositoryRoot` | Physical Git repository anchor under the supported layouts below: main checkout root, or common Git directory for a bare-backed linked worktree. Null outside a worktree. |
| `project` | Current checkout's basename, otherwise cwd's basename. A display label and exact checkout-name pin candidate. |
| `projectKey` | `remote ?? repositoryRoot ?? cwd`. The sole input to automatic slot hashing. |

Ordinary main checkouts keep their current key and label. A remote-less main
checkout and its linked worktrees now share the main checkout's path key.
Worktree moves/renames leave that key unchanged. Moving a remote-less main
checkout still changes its key, as moving an ordinary remote-less checkout
does today. A worktree label remains its own basename, so several work contexts
stay distinguishable even when their familiar is the same.

The implicit-root guarantee supports a conventional physical `<main>/.git`
directory. Separated Git metadata requires the actual main checkout to be
declared through its `core.worktree` configuration before linked-checkout
inheritance is supported. This is a setup prerequisite, not a configuration
change Familiar performs. An identifiable separated **main** checkout can
still use its current root, as discovery step 5 describes.

Without that reciprocal declaration, metadata named `.git` outside the main
checkout is indistinguishable from a conventional repository at its parent.
Git may report that parent successfully as its inferred worktree. This
unsupported ambiguous layout is not guaranteed to produce a diagnostic or
share the original main checkout's key/pins. Successful probing alone cannot
recover the arbitrary original checkout path. Require `core.worktree` rather
than adding a filesystem scan or registry to discover it.

The inherited project-name candidate is `basename(repositoryRoot)`. This is
still a deliberate basename alias, not a unique semantic project ID. No new
label field or user-visible identity schema is required.

Effective worktree-specific origins remain authoritative. If Git's per-worktree
configuration deliberately changes or removes origin, identity follows that
context; this design does not overwrite it with the main checkout's remote.
Consequently, equal keys across worktrees are guaranteed for equal normalized
origins or for a shared remote-less repository anchor, not across deliberately
different remote configurations.

## Pin precedence and conflicts

Evaluate the following tiers over the complete existing catalog:

| Priority | Candidate |
| --- | --- |
| 1 | Effective normalized remote |
| 2 | Exact canonical current checkout path (`repoRoot`) |
| 3 | Exact canonical inherited repository path (`repositoryRoot`) |
| 4 | Exact current checkout name (`project`) |
| 5 | Inherited repository name (`basename(repositoryRoot)`) |
| 6 | Automatic slot from `projectKey` |

Remote > path > project therefore remains intact. An exact worktree path
overrides a main-checkout path, but does not override a matching remote pin.
An exact worktree name overrides the inherited repository-name alias, but does
not override either path tier. To opt out of an inherited path choice, pin the
worktree by path; a project-name pin has always been less specific than a path.
When the current and inherited roots/names are equal, evaluate that candidate
once. Unrelated clones sharing an origin still share its remote identity;
unrelated remote-less repositories keep distinct path keys.

Within a tier, preserve first matching catalog entry. Entries with multiple
selectors remain valid and may match in any applicable tier; do not split,
merge or deduplicate them. No field-level overlay occurs: the winning pin's
slot and its `members` map are the complete choice. Inactive-theme overrides
remain inert, and active member/slot inconsistencies keep failing explicitly.

Example: a main checkout `api` pinned by path to slot 7 passes slot 7 to a
worktree `fix-api`. A path pin on `fix-api` to slot 3 selects slot 3 there only.
A matching remote pin to slot 6 wins in both contexts. With no pins or origin,
both hash the main checkout's physical path; their labels remain `api` and
`fix-api`.

## Git discovery and failure behavior

Keep discovery in `src/bus/identity.js`, outside the bus lock. Use argv-based
`execFile`; do not shell-interpolate paths or parse `.git` files/private
worktree metadata. The discovery procedure is:

1. Obtain the current checkout root with `git -C cwd rev-parse --show-toplevel`.
   As today, git absent or a directory outside a working tree returns null
   context. A bare directory itself remains outside this checkout-based
   identity path; its linked working trees are supported.
2. Read `git -C cwd worktree list --porcelain -z`. Parse NUL-delimited records,
   with the first record as the main-repository candidate. Require an absolute
   `worktree` field and well-formed record boundaries; do not `.trim()` paths.
3. For a first record marked `bare`, use
   `git -C cwd rev-parse --path-format=absolute --git-common-dir` as the anchor.
   This also handles a bare Git directory literally named `.git`. Its name
   is retained verbatim for the inherited project alias, including `.git`.
4. For a non-bare candidate equal to `repoRoot`, use that root. Otherwise run
   `git -C candidate rev-parse --show-toplevel` to obtain the actual main
   anchor under the supported conventional layout or a separated Git
   directory's explicit `core.worktree` declaration. Success verifies Git's
   effective working-tree interpretation, not the arbitrary original checkout
   of an undeclared separated layout. Do not accept a merely existing directory
   as proof of a checkout.
5. If that main-checkout probe fails without timing out, compare
   `git -C cwd rev-parse --absolute-git-dir` with the first candidate. Equality
   identifies a separated-directory **main** checkout, for which the already
   obtained `repoRoot` is authoritative. Otherwise fail with a diagnostic that
   the primary checkout cannot be established; for a separated Git directory,
   name the need to declare its real main checkout with `core.worktree`.
   Do not fabricate a root after a failed probe or switch keys to the current
   linked worktree. The successful but ambiguous undeclared `.git` case has
   the explicit support limitation above; this error rule cannot detect it.
6. Read and normalize the effective origin as today. Absence or an unsupported
   remote spelling means null; a timed-out Git command always fails discovery.

All commands share a two-second discovery deadline, with each spawn receiving
the remaining budget and `SIGKILL`. Exhausting the budget aborts, including a
timeout in a verification probe. This prevents the extra probes from multiplying
today's per-command worst-case wait. Ordinary primary checkouts need three
spawns; ordinary linked worktrees need four; the separated-main case needs at
most five. A bare-backed linked worktree needs four. No shell pipeline, disk
cache, background daemon or persistent checkout inventory is added.

For single-path Git output, remove only its terminating line ending, retaining
embedded newlines and trailing spaces. For porcelain output, retain all bytes
until NUL parsing. Malformed successful metadata and post-discovery failures
propagate through the existing CLI/cosmetic boundary. The hook reports one
diagnostic and does not admit an incoming record with guessed identity.
`whoami` and the explicit installer retain their normal nonzero error behavior.
Initial non-worktree/absent-Git behavior remains the existing null context.

## Consumer changes and state transition

`gitContext()` returns `{ remote, repoRoot, repositoryRoot }` as one context.
`projectKeyFor()` takes the repository anchor; `displayProject()` continues to
use the checkout root. `matchPin()` and `resolveIdentity()` receive both roots;
the inherited name is derived there. Update every production call identified
in the investigation, not only the CLI path:

- `bin/familiar.js`'s `identityResolver()` feeds `whoami` and `projects`.
- `src/bus/transaction.js` records the incoming context; `resolveIdentities()`
  carries it into the shared resolver for hooks, statusline and reap.
- `src/install/codex.js` resolves standalone/bulk plans from the same context.
  The actual target remains `repoRoot`, never `repositoryRoot`. An explicit
  request from a linked worktree writes only that worktree's config; it does
  not overwrite the main checkout's config or enumerate sibling worktrees.
- `src/install/codex-converge.js` continues to use the hook's resolved member
  and actual checkout target, preserving installed-pet and unmanaged/tracked
  config guards. All surfaces consume the resulting identity/intent as today.

The new internal context requires `repositoryRoot` explicitly, including null
for a non-worktree. Do not add an old-record resolver or infer it from an old
`repoRoot`. Pre-upgrade runtime records lack the new context: the existing
per-record resolution boundary reports/evicts them when a transaction resolves
them, and each session's next hook re-admits it with the new context. A statusline
before that hook may report an unavailable identity; it must not guess one.
An incoming discovery failure writes no agent/intent replacement. Document
this short transition and verify recovery without restarting unrelated sessions.
No authored pin changes or permanent compatibility layer are involved.

`fam-6e8321` continues to own relay migration. This is Familiar's visual
context, not a new relay identity field or a replacement registry. When that
task moves the consumer boundary, Familiar obtains its repository anchor from
the agent cwd and keeps it in the presentation layer; do not patch relay's
semantic identity contract as part of this work.

## Evidence and upstream limitation

Temporary Git fixtures on Git 2.56.0 verified main, internal, external and
symlinked worktrees; an unrelated nested repo; bare-backed worktrees; and NUL
records with newline/trailing-space paths. They confirmed the intended
repository relationship, not the proposed pin resolver (which is unwritten).

[Git's worktree manual](https://git-scm.com/docs/git-worktree) specifies main
first and stable NUL-delimited porcelain. The fixture also showed that a
`--separate-git-dir` layout reports the metadata directory as its first path,
even with `core.worktree` set. Probing that directory's top-level recovers the
declared checkout; without that declaration, a linked worktree cannot infer
the checkout's arbitrary filesystem location from this output.
A follow-up fixture placed separated metadata under `store/.git`: Git
successfully reported `store` as its working tree until `core.worktree`
declared the real primary. This reproduces the unsupported ambiguous case
and explains why the declaration is a prerequisite rather than something
Familiar can always diagnose from the listing.

Upstream searches covered Git/GitGitGadget issues and PRs across states,
the Git mailing-list archive, master/next `worktree.c`, and 2.54–2.56 release
notes. No matching correction was found in those surfaces. Both
[master](https://github.com/git/git/blob/master/worktree.c) and
[next](https://github.com/git/git/blob/next/worktree.c) derive that first path
from the common directory with a `.git` suffix stripped. Related
[PR 2208](https://github.com/git/git/pull/2208) adds `repo info` path keys, not
this correction. There is no identified fixing release/commit to wait for or
pin. Use the verified discovery rule above; no Git fork or patch is proposed.
The prepared upstream report is linked from the brief and requires publishing
approval separately. Revisit the verification only if upstream provides an
authoritative main-checkout path; do not assume a release will do so.

## Acceptance checks for the implementation plan

Use the existing test files and fixture helpers. The plan must prove:

- Main, internal, external and symlinked worktrees share inherited path and
  project pins; unpinned remote-less trees share a key/slot, with distinct labels.
- An unrelated nested repository/submodule never inherits a superproject's
  pins solely by containment. Unrelated remote-less repos remain distinct.
- The full precedence table, duplicate first-entry order, combined selectors,
  worktree path/name overrides, remote dominance and full theme-member choice.
- Ordinary main-checkout results and no-repository behavior stay unchanged;
  effective worktree origin overrides remain deliberate identity inputs.
- Bare-backed roots (including a bare `.git` directory), separated main roots,
  separated linked roots with declared `core.worktree`, and an explicit error
  for the identifiable undeclared separated-linked layout. A separate fixture
  demonstrates the undetectable undeclared `store/.git` limitation and recovery
  after declaring `core.worktree`; it must not assert universal detection.
- Metadata parse failures, paths with spaces/newlines/trailing spaces, injected
  timeouts at each spawn, and remaining-budget propagation never yield a
  silently changed identity within the supported layouts or exceed the
  two-second discovery budget.
- Transaction round trips retain the anchor; old runtime records fault and
  re-admit on their next hook; one faulty record does not break healthy ones.
- CLI, bus/intent and standalone/bulk Codex planners agree on member and slot.
  Linked-worktree config writes target that worktree only; convergence still
  receives the already resolved member and preserves its existing refusal gates.

Likely files: `test/{identity,pins,resolve,transaction,bin-familiar,
codex,install-codex-single,codex-converge}.test.js`. Use
`just test-fast` while the justfile has no focused `test-one` recipe. Baseline
tests are deferred until the reviewed plan executes, per the workspace policy;
Git probes above did not run a product suite or install product dependencies.

Update `docs/install.md` and `docs/surfaces.md` with inheritance/overrides,
labels, automatic-key behavior, transient-record recovery and per-worktree
Codex targets. Add a cross-reference to historical Codex parity section 6.2
without rewriting its historical observations as current implementation claims.
This task closes only after the written spec and implementation plan have
both received user review; implementation work is then tracked by plan steps.
