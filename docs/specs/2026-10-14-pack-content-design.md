# Pack content: what a theme pack is, for the gate and for `theme add`

**Status:** draft for review
**Date:** 2026-10-14
**Task:** fam-13999b
**Amends:** §3 "Local copy" and §2 step 4 of
[`2026-08-18-theme-add-design.md`](2026-08-18-theme-add-design.md); the
`familiar-theme` gate's preflight walk.

## Understanding

**Observed.** `familiar theme add <local checkout>` fails on every theme
checkout on this host: `.worktrees is not a regular file or directory`. Every
checkout under the work tree carries `.worktrees` as a relative symlink, and
plan executions add `.superpowers/`. `familiar theme validate <checkout>` fails
the same way (`.worktrees: is a symlink`), because the contract's gate treats
every entry under the directory as pack content. `docs/install.md` promises "a
clean local theme checkout"; git-clean is not the same as copyable.

**Wanted.** A theme author's working checkout installs and validates as it
stands, with no export step (the current workaround is
`git archive HEAD | tar -x` into an empty directory). The acquisition defenses
stay intact for everything that is installed.

**Success.**

1. `theme add` and `theme validate` succeed on a checkout that also holds
   tool workspaces, symlinks, sockets or other clutter outside the pack.
2. The installed tree contains exactly the pack content, whichever transport
   delivered it. Every installed byte is a byte the gate validated.
3. Inside pack content, every existing defense still holds: a symlink, FIFO,
   socket or device still fails by path, `.git` is never copied, and the
   identity checks, bounds and timeout are unchanged.

**Assumed.** No consumer reads anything from an installed pack beyond
`theme.yaml` and the members' asset directories. The engine was checked
(`loadThemePack` and `themeDirFor` are its only readers); forge pins its own
`familiar-theme` version and is unaffected until it bumps.

## 1. The rule: pack content

A pack is its descriptor and what the descriptor names, not the directory that
holds it. For a parsed pack, each entry under the pack root has one role,
decided by its `/`-joined relative path:

| role | entries |
|---|---|
| `content` | `theme.yaml`; a root entry whose name starts, case-insensitively, with `licen`, `copying` or `notice` (`LICENSE`, `LICENSE-assets`, `LICENCE.md`, `COPYING`, `NOTICE`, a REUSE `LICENSES/` directory); each member's `asset-root` and everything beneath it |
| `ancestor` | a proper prefix of some member's `asset-root`, by segment (`sprites` for `sprites/persian`) |
| `outside` | everything else |

`asset-root` is already constrained by the contract: relative, no empty, `.`
or `..` segments, ending in `sprites/<member-id>`. So the content set comes
from the descriptor alone, before any directory below the root is read.

Licence files are content so that an installed copy keeps the terms its assets
were granted under (cats ships `LICENSE` and `LICENSE-assets`). This is the one
rule that names files by convention rather than by the descriptor. It is
deliberately broad: a false positive installs one more small file, which the
gate still validates.

**Walking by role.** `outside` entries are skipped by name, never `lstat`ed or
opened, so a symlink, socket or FIFO outside the pack is never touched.
`ancestor` entries must be real directories: anything else fails by path, so
`sprites` as a symlink is still refused. `content` entries get today's full
treatment: directories descend, regular files are read or copied, and anything
else fails by path.

## 2. Contract package (`familiar-theme`, released as v0.3.0)

- **New export:** `packEntryRole(pack, relPath) -> 'content' | 'ancestor' |
  'outside'`, implementing §1 over a parsed pack's members. It is pure: no
  filesystem access. It is the single home of the rule, and both walkers below
  call it.
- **Gate preflight walks pack content only.** The order becomes:
  1. `lstat` `theme.yaml` (or the candidate descriptor): a regular non-symlink
     file, bounded by `MAX_DESCRIPTOR_BYTES`.
  2. Parse it.
  3. Walk the root by role.
  4. Everything after preflight is unchanged.

  `MAX_ENTRY_COUNT` and `MAX_TOTAL_BYTES` now count pack content only, so a
  checkout's clutter cannot trip them.
- **Candidate descriptors keep today's semantics.** With `descriptorPath`, the
  candidate stands in for `theme.yaml`: it is checked and counted as now, the
  root `theme.yaml` is skipped as now, and the roles come from the candidate's
  members.
- **Drift fails closed.** If the descriptor changes between the preflight parse
  and `loadThemePack`'s read, a newly named member's PNGs are missing from the
  retained map. The coverage check then fails with "missing state". No new
  check is needed, and a test proves it.
- **Unchanged:** a pack that passed v0.2.0 passes v0.3.0. The gate only stops
  looking at non-content entries. `SPEC_VERSION` does not change, because the
  descriptor format is untouched.

## 3. Engine (`familiar`)

**Local copy (`copySource`).**
1. Copy root `theme.yaml` with today's hardened regular-file copy. A missing
   one fails as `theme add: <source> has no theme.yaml`. A symlink or special
   file fails by path, as now.
2. Bound the staged file by `MAX_DESCRIPTOR_BYTES`, then parse the **staged
   bytes** with the exported `parseThemePack`. The selection is derived from
   exactly the descriptor the gate will validate, so there is no window
   between selection and validation.
3. Walk the source with the existing identity-checked walker, filtering each
   directory's entries through `packEntryRole`. The `.git` exclusion stays as a
   second guard inside content.

The self-copy check (staging beneath the source) is unchanged.

**Clone.** Clone into `<run>/clone`, read the commit there, then copy
`<run>/clone` to `<run>/pack` through the same `copySource`, and promote
`<run>/pack`. The orchestrator's explicit `.git` removal (old §2 step 4)
disappears: the clone directory is discarded with the run. The growth monitor
still covers the whole run directory. Its 4 × `MAX_TOTAL_BYTES` headroom
already allows for a clone plus its copy.

**Why the clone path changes too.** Once the gate ignores non-content entries,
promoting a whole clone would install bytes no one validated, including
symlinks a repository's `docs/` might hold. "Every installed byte was
validated" is the receipt's claim, so both transports install pack content
only.

**`theme validate <dir>`** needs no engine change. It inherits the gate's
behaviour.

**Docs.** `docs/install.md` drops "clean" and says what is installed:
`theme.yaml`, licence files and each member's sprite directory. The 2026-08-18
spec gets a status line pointing here for the amended sections.

## 4. Error handling

- No `theme.yaml` at the source root: `theme add: <source> has no theme.yaml`.
- An oversized or unparseable descriptor: the contract's own messages, the
  same ones `theme validate` prints, with staging cleaned by the existing
  orchestrator `finally`.
- An `asset-root` absent from the source: nothing is copied for it, and the
  gate fails with its existing `asset-root … does not exist`.
- A bad entry inside content or on an ancestor path: today's by-path message.

## 5. Testing

**Contract package (its own suite).**
- `packEntryRole` table: root files, licence-name variants and non-matches
  (`licensed-art/` is content by prefix, which is accepted), member trees,
  ancestors, shared ancestors, outside entries.
- The gate accepts a valid pack beside a root symlink, a FIFO, a socket and a
  large non-content file.
- The gate still rejects a symlink inside a member tree, and an ancestor that
  is a symlink.
- The entry and byte bounds ignore non-content entries.
- Descriptor drift between the preflight parse and the load fails closed.

**Engine (fast suite).**
- The regression: a local checkout holding a `.worktrees` relative symlink, a
  `.superpowers/` directory containing a symlink, `README.md`, `docs/` and a
  root FIFO installs. The installed tree equals exactly `theme.yaml`, the
  licence files and `sprites/<member>/**`.
- Existing copy-defense tests move their symlink, FIFO and socket fixtures
  inside a member directory, where they must still fail by path. New cases
  cover a symlinked `sprites` ancestor and a symlinked `theme.yaml` or
  `LICENSE`.
- A missing `theme.yaml` and an oversized descriptor give the named errors,
  with no staging residue.
- The hermetic HTTPS test's served repository gains `README.md` and `docs/`
  holding a symlink. It installs, the installed tree is content only, and the
  receipt still carries the commit.
- `theme validate` on a cluttered fixture checkout succeeds.

**By hand, once:** `familiar theme add ~/d/familiar-cats` and
`familiar theme validate ~/d/familiar-cats` from the worktree's own `bin/`,
into a scratch config directory (`FAMILIAR_CONFIG_DIR`). The live config is
not touched.

## 6. Delivery

1. `familiar-theme`: implement §2 test-first, release `v0.3.0` (commit, tag,
   push). The push is an external action and waits for approval at that point.
2. `familiar`: bump the dependency to `#v0.3.0`, implement §3 test-first,
   update the docs.

Forge keeps `#v0.2.0` until it chooses to bump. Nothing in forge depends on
the gate rejecting non-content entries, but whether it should adopt the rule
is forge's decision, filed as a follow-up rather than done here.

## 7. Decisions

| decision | choice | rejected | reason |
|---|---|---|---|
| where the rule lives | the contract package, one exported function | engine-only selection in `copySource` | `theme validate` would stay broken on every checkout, and the engine would duplicate contract knowledge (`asset-root` shape) |
| how clutter is excluded | descriptor-derived content set | skip a fixed list of tool-workspace names (`.worktrees`, `.superpowers`) | the engine would learn host conventions, and the next stray entry (`.venv`, a build directory) would break it again |
| selection source in the engine | the staged descriptor's bytes | parse the source descriptor in place | no window between the bytes that choose the selection and the bytes the gate validates |
| clone path | same selective copy, from `<run>/clone` to `<run>/pack` | promote the whole clone | a narrowed gate would otherwise let unvalidated bytes, symlinks included, be installed |
| licence files | root name prefix `licen` / `copying` / `notice` | omit them; or declare them in `theme.yaml` | omitting drops the asset terms from installed copies; a descriptor key would be a format change (`SPEC_VERSION`) for a convention every repository already follows |
| `git ls-files` to select | never | — | git would run on an untrusted source (`core.fsmonitor`, hooks); old §3 already forbids invoking git there |
