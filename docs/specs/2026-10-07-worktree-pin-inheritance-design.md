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

| Field | Change | Meaning |
| --- | --- | --- |
| `remote` | Existing | Normalized effective origin for the invoking checkout, or null. |
| `repoRoot` | Existing | Physical root of the current checkout, or null outside a worktree. This remains the write target for a project's Codex config. |
| `repositoryRoot` | **New** | Physical Git repository anchor under the supported layouts below: main checkout root, or common Git directory for a bare-backed linked worktree. Null outside a worktree. |
| `project` | Existing | Current checkout's basename, otherwise cwd's basename. A display label and exact checkout-name pin candidate. |
| `projectKey` | Existing; derivation changes | `remote ?? repositoryRoot ?? cwd`. The sole input to automatic slot hashing. |

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
change Familiar performs. Every separated **main** checkout uses its current
root, identified by equal Git and common directories in discovery step 2.

Without that reciprocal declaration, metadata named `.git` outside the main
checkout is indistinguishable from a conventional repository at its parent.
Git may report that parent successfully as its inferred worktree. This
unsupported ambiguous layout is not guaranteed to produce a diagnostic or
share the original main checkout's key/pins. Successful probing alone cannot
recover the arbitrary original checkout path. Require `core.worktree` rather
than adding a filesystem scan or registry to discover it.

The inherited project-name candidate is `basename(repositoryRoot)`, except
that the anonymous name `.git` contributes no inherited name tier. Keep every
other basename verbatim: do not strip a terminal `.git` suffix. Thus a bare
`familiar.git` anchor matches `project: familiar.git`, not `project: familiar`.
This avoids a second normalization rule or another persisted field to classify
bare roots. Exact current-checkout names remain unchanged, including an
explicit checkout actually named `.git`. These are still deliberate basename
aliases, not unique semantic project IDs.

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
| 5 | Inherited repository name (`basename(repositoryRoot)`), omitted for `.git` |
| 6 | Automatic slot from `projectKey` |

Remote > path > project therefore remains intact. An exact worktree path
overrides a main-checkout path, but does not override a matching remote pin.
An exact worktree name overrides the inherited repository-name alias, but does
not override either path tier. To opt out of an inherited path choice, pin the
worktree by path; a project-name pin has always been less specific than a path.
When the current and inherited roots/names are equal, evaluate that candidate
once. Unrelated clones sharing an origin still share its remote identity;
unrelated remote-less repositories keep distinct path keys.

A shared matching remote pin already applies across worktrees today and cannot
be overridden by a worktree path pin. The gain here is for path pins,
project-name pins and remote-less repositories; a distinct effective origin
requires a deliberate worktree-specific configuration change.

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

1. Obtain three paths in one call:
   `git -C cwd rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`.
   Remove only the final output LF, then split on LF. Accept exactly three
   nonempty absolute paths, in that option order. If the successful output
   does not split into exactly three lines, repeat each of the three options
   in its own `rev-parse --path-format=absolute` call, preserving embedded
   newlines and trailing spaces by removing only its final output LF. This
   explicit framing check triggers the unusual-path fallback; never guess
   where one path ends. Three-line output with invalid path values, or invalid
   per-option results, is a metadata error. As today, Git absent or a directory
   outside a working tree returns null context. A bare directory itself is
   outside this checkout-based identity path; its linked trees are supported.
2. If `gitDir === commonDir`, this is the main checkout, including a separated
   main checkout: `repositoryRoot = repoRoot`. No main-root verification or
   sibling lookup is needed. Git and common directories are discovery locals,
   not additional persisted visual fields.
3. Otherwise this is a linked worktree. Its candidate is the parent of
   `commonDir` when that directory's final component is exactly `.git`, and
   `commonDir` otherwise. Run one probe:
   `git -C candidate rev-parse --is-bare-repository --show-toplevel`.
   A successful result must start with `false` and an LF, followed by one
   nonempty absolute root value and its terminating LF; retain any embedded
   newlines in that root. Use that root as `repositoryRoot`. For a bare anchor,
   Git prints `true` and an LF before `--show-toplevel` fails with exit 128
   because no checkout exists. Recognize exactly that result (stdout `true\n`,
   exit 128, no spawn/timeout/signal failure) and use `commonDir` as
   `repositoryRoot`. This combines bare detection and verification without
   another process, including a bare Git directory literally named `.git`.
4. Reject other failed or malformed probe results with a diagnostic that the
   primary checkout cannot be established; for separated metadata, name the
   need to declare its real main checkout with `core.worktree`. Do not switch
   to the current linked worktree's path. Successful probing establishes Git's
   working-tree interpretation under the supported layouts, not an arbitrary
   original checkout in the undeclared separated `.git` case described above.
5. Read and normalize the effective origin as today. Absence or an unsupported
   remote spelling means null; a timed-out Git command always fails discovery.

All commands share a two-second discovery deadline, with each spawn receiving
the remaining budget and `SIGKILL`. Exhausting the budget aborts, including a
timeout in a verification probe. Ordinary and separated main checkouts need
two spawns, the same as today; ordinary and bare-backed linked worktrees need
three. Newline-ambiguous batched output adds three per-option calls, for totals
of five/main and six/linked, all within that same deadline. No command lists
sibling worktrees or checks their locations: a prunable or inaccessible sibling
must not expand this discovery's filesystem reach. No shell pipeline, disk cache,
background daemon or persistent checkout inventory is added.

For single-path Git output, remove only its terminating LF, retaining
embedded newlines and trailing spaces. Malformed successful metadata and post-discovery failures
propagate through the existing CLI/cosmetic boundary. The hook reports one
diagnostic and does not admit an incoming record with guessed identity.
`whoami` and the explicit installer retain their normal nonzero error behavior.
Initial non-worktree/absent-Git behavior remains the existing null context.
The identifiable undeclared separated-linked layout resolves by checkout today;
this design deliberately changes it to a discovery error until `core.worktree`
declares the primary. The diagnostic repeats on every hook that performs
identity discovery; removal hooks still skip discovery. Do not add a diagnostic
cache or select an automatic pet by pretending the failed probe was absence.

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
  The existing exclusion write is repository-wide: `--git-path info/exclude`
  resolves to the shared Git exclusion file, where one idempotent
  `.codex/config.toml` line applies to all worktrees. Preserve that behavior.
- `src/install/codex-converge.js` continues to use the hook's resolved member
  and actual checkout target, preserving installed-pet and unmanaged/tracked
  config guards. All surfaces consume the resulting identity/intent as today.

The new internal context requires `repositoryRoot` explicitly, including null
for a non-worktree. Add a **new own-property check** inside each record's `try`
in `resolveIdentities()`: `Object.hasOwn(record, 'repositoryRoot')` must be
true before calling `resolveIdentity()`. A missing property throws a diagnostic
such as `session record lacks repositoryRoot; wait for its next hook` and
becomes that record's fault; an explicit null passes this presence check.
The current code has no such trigger and would quietly hash the stored old
key. Do not infer the missing anchor from old `repoRoot` or add an old-record
resolver. The existing fault boundary handles the **newly triggered** fault:
transactions report/evict pre-upgrade records, and each session's next hook
re-admits it with the new context. A statusline before that hook may report an
unavailable identity; it must not guess one.
An incoming discovery failure writes no agent/intent replacement. Document
this short transition and verify recovery without restarting unrelated sessions.
No authored pin changes or permanent compatibility layer are involved.

`fam-6e8321` continues to own relay migration. This is Familiar's visual
context, not a new relay identity field or a replacement registry. When that
task moves the consumer boundary, Familiar obtains its repository anchor from
the agent cwd and keeps it in the presentation layer; do not patch relay's
semantic identity contract as part of this work.

## Evidence and upstream limitation

Initial temporary Git fixtures on Git 2.56.0 verified main, internal, external and
symlinked worktrees; an unrelated nested repo; bare-backed worktrees; and NUL
records with newline/trailing-space paths. Those listing probes are historical
investigation evidence, not the chosen hook procedure. The pin resolver is
still unwritten.

Following spec review, new fixtures verified the combined three-path query,
equal Git/common directories for main versus distinct directories for linked
checkouts, newline framing and exact per-option recovery, and shared
`info/exclude` targets. The combined bare/root probe returned `false` plus a
root for ordinary/declared separated primaries, and exactly `true\n` with exit
128 for bare anchors named `bare.git` and `.git`. These checks support the
revised command contract; they are not product-suite or latency measurements.
An end-to-end temporary discovery pilot then confirmed two spawns for main
checkouts, three for ordinary/declared-separated/bare-backed linked trees,
and five/main or six/linked when newline framing triggers separate queries.
Moving a sibling without repairing its registration left main/linked discovery
unchanged. These are native path, framing and spawn checks; shared-deadline
enforcement and the new record guard still require implementation tests.
[Git's rev-parse documentation](https://git-scm.com/docs/git-rev-parse)
describes the absolute path options and bare/worktree queries.

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

## Latency acceptance

Every tool call pays for discovery. The implementation plan must measure
representative hook wall time on a conventional main checkout and a linked
worktree before and after the change, on the same host with the same temporary
repositories, theme/config, payload and terminal-disabled setup. Use real Git,
not mocked exec timings. Keep bus state and all generated files in the fixture;
never repoint installed launchers or use live user state.

Add one small justfile benchmark recipe around the existing `tools/tt` wrapper
and reuse the hook fixture machinery. Record distinct main/linked and
before/after targets, revisions and raw results. Capture discovery duration
and Git spawn count as well as total hook wall time, so the plan can explain
whether changes come from Git, process startup or other hook work. After five
warm-ups, collect at least 30 successful hook samples per context and phase,
report median and p95 in milliseconds plus absolute/percentage deltas, and
repeat a baseline batch to characterize run-to-run variation. The benchmark
must state precisely which hook boundary it measures; a pure `gitContext()`
timing alone does not meet the hook-wall-time requirement.

Assert two discovery spawns for normal main checkouts and three for linked
checkouts (ordinary and bare-backed). No sibling enumeration is allowed.
Investigate a main-checkout slowdown beyond baseline variation, or a linked
slowdown unexplained by one extra verification spawn and baseline variation,
before declaring latency acceptance. Report the evidence and disposition on
the task; spawn counts alone are not a wall-time verdict. Do not add a cache,
framework or background service to pass the check. Measurements run during
implementation, after the reviewed plan has set up the worktree.

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
- The inherited name tier is omitted for `.git`, all other names retain their
  suffix/case, and exact checkout-name pins remain unchanged. A shared matching
  remote pin still wins over an exact worktree path pin.
- Metadata parse failures, paths with spaces/newlines/trailing spaces, injected
  timeouts at each spawn, and remaining-budget propagation never yield a
  silently changed identity within the supported layouts or exceed the
  two-second discovery budget.
- Combined-output ambiguity triggers the three per-option queries; partial
  bare/root output is accepted only in its specified exit-128 case. A timeout
  or killed command with partial `true\n` output still fails. Normal and bare
  linked discovery do not enumerate siblings; a missing/prunable sibling or
  simulated inaccessible sibling cannot introduce an extra probe or failure.
- Hook latency, discovery timing and spawn counts meet the measurement and
  disposition requirements above; capture both before and after results.
- Transaction round trips retain the anchor; old runtime records fault and
  re-admit on their next hook. Missing or inherited-only `repositoryRoot`
  properties fault because of the new presence guard; an own null property is
  allowed. One faulty record does not break healthy ones.
- CLI, bus/intent and standalone/bulk Codex planners agree on member and slot.
  Linked-worktree pet config writes target that worktree only, while its
  exclusion write updates shared `info/exclude` with the managed line exactly
  once. Convergence still receives the already resolved member and preserves
  its existing refusal gates.

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
