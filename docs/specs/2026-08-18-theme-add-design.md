# Phase 4: `theme add`

**Status:** approved design, unimplemented
**Date:** 2026-08-18

The engine ships no art. This phase gives it the verb that makes that
tenable: `familiar theme add <https-url|path>` — acquisition, validation, and
atomic installation of a theme pack, with an external receipt. It completes
the Phase 3/4 release cutover: an engine that cannot install `familiar-cats`
must not be released.

The normative upstream contracts live in the archive and are implemented
here, not restated:

- Staging and promotion — §7 of the conformance-gate spec, "authoritative
  for Phase 4":
  <https://github.com/khughitt/familiar-archive/blob/main/docs/specs/2026-08-14-theme-conformance-gate-design.md>
- Transport, trust boundary, phase sequencing — umbrella §2 and §4:
  <https://github.com/khughitt/familiar-archive/blob/main/docs/specs/2026-08-14-familiar-architecture-design.md>

Where this spec and those disagree, those win; this spec's job is the
engine-side design that satisfies them.

## Scope

**In:** `theme add` (HTTPS + local directory), install receipts,
receipt-aware `theme list`, stale-staging handling, hermetic installer tests,
the cats cutover on the author's machine, `docs/install.md` rewrite.

**Out (deferred, with reason):**

- `theme update` — it is specified as re-acquire-and-revalidate, so it is
  `add` with the id freed; it can land later without breaking receipts.
- `theme remove` — manual `rm -rf` plus the receipt file is legible enough
  until update exists.
- SSH transport, `--branch`, `--id`, `--force` — YAGNI per the umbrella;
  private repos use `git clone` + `theme add ./dir`.
- Blob/exploration fetching — `forge explore`'s job, not the engine's; the
  shallow single-branch clone never touches the `exploration` orphan branch.

## 1. CLI surface

- `familiar theme add <https-url|path>` — one positional, no flags.
  `https://…` is cloned under git isolation; anything else must be an
  existing local directory, copied defensively. `http://`, `ssh://`,
  `git@…`, and `file://` are rejected with a named error stating the
  HTTPS-or-local-directory rule. An HTTPS URL carrying credentials
  (`https://user:token@…` — a nonempty username or password after `URL`
  parsing) is rejected before anything runs: the given URL is persisted
  in the receipt and printed by `theme list`, so accepting one would
  store and display a secret. Private repos use the local-directory
  path, as the umbrella already specifies.
- Success output: `installed theme '<id>' (<n> members) at <dir>`, plus an
  activation hint (`set "theme: <id>" in config.yaml`) when `<id>` is not
  the active theme.
- `theme list` rows for user themes gain provenance from the receipt:
  `validated <date> from <url|path>`, or `never validated (manual install)`
  when no receipt exists. Leftover staging is reported as its own line
  (`stale staging from an interrupted add — next add cleans it`), never as
  an id error and never silently skipped.
- The id is never taken from the URL or directory name: the install
  directory is named by the validated pack's own `id`. One name, one
  authority.

## 2. Modules and the sequence

Engine-side only; the contract package (`familiar-theme`) stays
installation-ignorant.

- `src/theme/add.js` — orchestrator `addTheme({ paths, source, ... })`
  implementing §7's sequence exactly. The whole operation runs under
  `withLock` (`src/bus/lock.js`) on a dedicated
  `stateDir/theme-add.lock`, so installers are serialized — age proves
  nothing about liveness (directory mtimes do not track nested writes,
  and the wall-clock timeout bounds only acquisition), but the lock
  does: any staging entry observed while holding it is abandoned.
  `withLock`'s **defaults must be overridden**: its `staleMs` of 10 s is
  sized for the bus's critical sections and reclaims even a *live*
  holder past that age, which would break serialization mid-clone. The
  theme-add lock passes `staleMs` comfortably above the whole
  operation's ceiling (wall-clock timeout plus validation; 600 s), so
  reclaim happens only for dead holders (pid liveness already handles
  those immediately). A lock still held after `withLock`'s retry
  patience reports `another theme add is running`. Steps:
  1. Under the lock: create `userThemesDir/.staging` if absent, and
     verify it is a real directory by `lstat` (a symlink here is a named
     error, never traversed —
     cleanup must not be redirectable outside the themes directory),
     remove any leftover run entries, then create the run directory with
     `mkdtemp` beneath it.
  2. **Acquire** into it: isolated clone, or `.git`-excluding defensive
     copy.
  3. **Record provenance** in memory: for a clone, the given URL and
     `git rev-parse HEAD` read while `.git` still exists; for a local
     directory, its absolute path and no commit field.
  4. **Remove `.git`.**
  5. **Validate the staged tree** with `validateThemePack` — the exact
     bytes that will be promoted. The target id is the returned pack's
     `id`.
  6. Fail if `lstat(userThemesDir/<id>)` succeeds — an existing **user**
     theme (any filesystem object, including an empty directory or a
     symlink) is never overwritten; shadowing a **shipped** id remains
     allowed. The check is meaningful because it happens under the lock:
     `rename` alone would silently replace an empty target directory.
  7. **Rename** into place — atomic and same-filesystem by construction,
     because staging lives beneath the themes directory (a symlinked or
     mounted themes dir cannot introduce a cross-device rename).
  8. **Write the receipt last** to `configDir/theme-receipts/<id>.json`
     via `writeJsonAtomic`.
- `src/theme/acquire.js` — `cloneSource(url, dest, opts)` /
  `copySource(dir, dest, opts)`. Any acquisition or validation failure
  removes the run's staging dir before the error propagates; a rejected
  pack leaves no residue. A crash leaves the run dir for the next add's
  cleanup, reported by `theme list` meanwhile.
- `src/theme/receipt.js` — receipt shape
  `{ id, source: { kind: 'https', url, commit } | { kind: 'local', path }, installedAt }`,
  read/write and path resolution. `paths()` gains `themeReceiptsDir`.
  Receipts live **outside** `userThemesDir` because the catalog treats
  every directory there as a theme id. Reading is strict: unparseable
  JSON, a wrong-shaped `source` or `installedAt`, or an embedded `id`
  that differs from the filename makes the receipt **invalid** — the
  reader returns that verdict with its reason, and `theme list` shows
  `invalid receipt (<reason>)` for the row. An invalid receipt never
  produces a `validated` row, and never collapses into `never validated`
  either — that would make corruption look like a clean manual install.
- `src/theme/catalog.js` — learns exactly one reserved name, `.staging`:
  excluded from id validation, surfaced as the stale-staging row above.

## 3. Acquisition defenses

**Clone.**
`git clone --depth 1 --single-branch --no-tags --no-recurse-submodules`
with the environment neutralised: `GIT_CONFIG_GLOBAL` and
`GIT_CONFIG_SYSTEM` pointed at the null device, `GIT_TERMINAL_PROMPT=0`,
empty askpass, `GIT_ALLOW_PROTOCOL=https`. Neutralised global config also
disables any host LFS filter configuration (`filter.lfs.required true` on
the reference machine is the standing proof): an LFS-backed pack arrives as
pointer files and is rejected legibly by the gate's signature check, which
is the specified v1 behaviour.

**Local copy.** Before the walk, both the source and the staging run
directory are resolved with `realpath`; a staging destination that lies
beneath the source is rejected by name (`theme add ~/.config/familiar/themes`
would otherwise copy staging into itself until a bound trips). Then an
`lstat` walk that never dereferences: regular files and directories only; a
symlink, FIFO, socket, or device fails acquisition by path; any entry named
`.git` at any depth is excluded from the copy; git is never invoked on the
source. The gate remains the authority for anything
that reaches it anyway.

**Bounds, honestly.** Both paths run under a wall-clock timeout (default
300 s, kills the child / aborts the walk) and a staging-growth monitor
(polled about once per second; aborts past 4 × `MAX_TOTAL_BYTES` = 640 MiB,
headroom because a clone's `.git` can briefly double the tree). These bound
disk and time with bounded overshoot; the exact limits (`MAX_ENTRY_COUNT`,
`MAX_TOTAL_BYTES`) apply post-fetch, at validation, to the installed tree —
per the umbrella's "honest limit on fetch size".

## 4. Error handling

Every failure is a named, single-line instruction:

- Transport violations (bad scheme, missing or non-directory local path)
  fail before anything is created, naming the rule.
- Clone failures surface git's stderr; isolation guarantees no prompt can
  hang, so a private repo fails fast rather than waiting for credentials.
- A tripped bound names which bound and how much had been fetched.
- Validation failures are `validateThemePack`'s own messages, staging
  already cleaned.
- `theme '<id>' is already installed at <dir> — remove it first` for an
  existing user id. Concurrent installers are serialized by the lock; a
  second add of the same id therefore runs after the first completes and
  reports the same already-installed error, and a held lock is reported
  as `another theme add is running` rather than raced.
- Crash honesty comes from ordering, not cleanup code: before the rename,
  the failure mode is stale staging (visible in `list`, cleared by the next
  add); between rename and receipt, it is an installed-but-unreceipted pack,
  which `list` reports as never validated. A receipt falsely claiming
  validation is impossible by construction.

## 5. Testing

- **Unit (fast suite):** copy defenses (symlink, FIFO, and Unix-socket
  rejection by path — devices share the same rejection branch but cannot
  be created unprivileged, so the fixtures follow the conformance-gate
  spec's FIFO/socket strategy; nested `.git` exclusion;
  destination-under-source rejection), scheme and credential-URL
  rejection, receipt round-trip plus the invalid cases (corrupt JSON,
  wrong shape, id/filename mismatch — each yielding `invalid receipt`,
  never `validated`), staging cleanup and the symlinked-`.staging`
  refusal, catalog `.staging` handling, id-exists refusal (including an
  empty directory at the target), and receipt-last ordering via an
  injected fault between rename and receipt (pack present, `list` says
  never validated).
- **Hermetic HTTPS integration (fast suite, no network):** a committed
  test-only self-signed certificate and key for `127.0.0.1`, served by a
  node `https` server statically hosting a bare repo built in-test from
  `test/fixtures/theme-pack` (`git update-server-info`, dumb HTTP
  protocol). The test seam is a single `caFile` option — mapped to
  `GIT_SSL_CAINFO`, nothing else injectable — and the isolation
  variables are applied after any caller input, so no seam can weaken
  the protocol allowlist, config nullification, or prompt controls. The
  production https-only allowlist is exercised, not bypassed. Cases:
  successful add end-to-end, LFS-pointer repo rejected legibly, invalid
  pack rejected with staging cleaned, timeout abort, and a second add
  blocked while the lock is held. Known contingency: stock git falls
  back to the dumb protocol against a static server; if a git version
  quirk breaks that, the hermetic fallback is spawning `git http-backend`
  as a CGI child.
- **Real remote:** the cutover smoke test below — run once by hand, never
  a CI dependency.

## 6. Cutover and acceptance

With the suite green: remove the manually installed cats pack from the user
themes directory, run
`familiar theme add https://github.com/khughitt/familiar-cats`, and verify
the receipt, `theme list`, and a statusline render. Rewrite
`docs/install.md` from the manual-copy instructions to the `theme add`
flow, and grep the engine's user-facing docs for any other claim that
manual installation is the install path. The archive's own docs stay
frozen.

## 7. Decisions

| decision | choice | reason |
|---|---|---|
| verb scope | `add` + receipt-aware `list`; `update`/`remove` deferred | update is add-with-id-freed and can land later without breaking receipts |
| receipt contents | provenance + `installedAt` only | smallest honest claim; fields are added by presence, so extension is non-breaking |
| receipt home | `configDir/theme-receipts/<id>.json` | must be outside the pack (spec §7) and outside `userThemesDir` (catalog treats every dir there as a theme id) |
| staging home | reserved `userThemesDir/.staging/<run>` | §7's same-filesystem rename survives a symlinked themes dir; the catalog knows the one reserved name and reports stale runs instead of erroring |
| install dir name | the validated pack's `id` | one authority for identity; URL and directory names carry none |
| installer serialization | `withLock` on `stateDir/theme-add.lock`, `staleMs` 600 s | staging-age proves nothing (dir mtimes ignore nested writes); the bus default `staleMs` of 10 s reclaims a live holder mid-clone |
| credentialed URLs | rejected before cloning | the given URL is persisted and displayed, so accepting one stores and prints a secret; private repos already have the local-directory path |
| hermetic HTTPS tests | local TLS with a committed fixture CA; the only seam is a `caFile` option, isolation env applied last | exercises the real https-only allowlist; no seam can weaken the clone isolation |
| fetch bounds | 300 s wall clock; growth abort at 4 × `MAX_TOTAL_BYTES` | git has no client-side fetch-byte limit; bounded overshoot is the honest contract, exact limits apply at validation |
| invalid receipts | their own `theme list` verdict, with reason | collapsing corruption into `validated` is a false claim; into `never validated`, a hidden defect |
