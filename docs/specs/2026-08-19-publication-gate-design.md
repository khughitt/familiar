# Publication Gate — Design

**Status:** approved design, unimplemented

Take `familiar-cats`, `familiar-theme`, and `familiar` (the engine) to
public-ready and public, closing the publication blockers the repository
split deliberately deferred: asset rights, license files, the machine-path
sweep, a tooled secret scan, and minimal CI. This re-scopes the surviving
substance of the July 2026 publication design (archive branch
`publication`, `docs/specs/2026-07-18-publication-design.md`) to the
post-split repo family; that spec's repository-layout and history-surgery
phases are superseded by the split and are not carried here.

## 0. Context and constraints

- `familiar-cats` went public on 2026-08-19 to serve
  `familiar theme add` over HTTPS — ahead of this gate. Decision: it stays
  public while the gate runs; the rights review is the gate's first task.
- `familiar-forge` and `familiar-archive` stay private. Forge's
  explanatory-value question gets its own later decision; the archive is
  frozen and private per the July decision.
- The July in-principle license decisions stand and extend to the art:
  **MIT** for code, **CC BY 4.0** for docs, **CC BY 4.0** for the cats
  art — the art grant conditional on the rights review (§2).
- npm distribution remains deferred. Publication means public GitHub
  repositories with working anonymous installs, not registry packages.
- The theme pack validator tolerates arbitrary regular files (it bounds
  entry count and sizes and rejects only symlinks/FIFOs/sockets), so
  license and README files added to `familiar-cats` ride through
  `theme add` and travel with every installed copy. Verified against
  `familiar-theme` `src/validate.js` preflight.

## 1. Scope and sequencing

Three repos pass a per-repo acceptance checklist — rights, licenses,
sweep, scan, CI green — and visibility flips only when a repo's checklist
passes. Order: **cats → theme → engine**, most-exposed first. The order is
load-bearing: the engine's dependency on `familiar-theme` is pinned as
`git+ssh://…#v0.1.0`, unusable anonymously; it flips to `git+https://`
only after theme is public, and the engine's clean-clone CI smoke depends
on that flip. Cats is already public, so its checklist simply runs first.

Out of scope: forge and archive changes; npm publishing; any CI beyond §6;
history rewriting (histories are days old; §5's scan is the history
evidence).

## 2. Asset-rights review (first task; stop point)

Evidence base: the provenance manifests shipped in `familiar-cats`
(`sprites/<member>/provenance.json`). Every shipped sprite records the
full generation request: endpoint `openrouter.ai/api/v1/images`, model
`openai/gpt-5.4-image-2`, `provider.only: ["openai"]` with fallbacks
disallowed, `is_byok: false`, plus prompt, image digest, and cost.

The controlling documents are not generic "current OpenAI terms".
OpenRouter's Terms delegate output ownership to each model's **Model
Terms**, and these calls were non-BYOK and provider-pinned to OpenAI, so
the review identifies and records: the OpenRouter Terms of Service and the
model-specific terms for `openai/gpt-5.4-image-2` **as effective on the
generation dates** — the manifests' `generatedAt` values span
2026-07-31 through 2026-08-02 — plus whatever current terms govern
ongoing distribution. Against those documents it checks:

1. **Ownership/assignment** — whether output ownership or assignment to
   the requesting user permits relicensing under CC BY 4.0.
2. **Obligations** — any attribution, AI-disclosure, or usage condition
   that must be carried into `LICENSE-assets`.
3. **Attribution party** — the CC BY attribution target is Keith Hughitt,
   as the party who directed creation; the review confirms nothing in the
   terms requires naming the provider instead of or alongside.

Output: a short review document in `familiar-cats` recording the terms
versions and the date checked, the findings for each point, and the
conclusion. `LICENSE-assets` cites it, so the grant is evidenced, not
asserted.

**Stop point with containment:** if the terms bar relicensing, or impose
conditions CC BY 4.0 cannot carry, work stops and the art-license decision
reopens before any `LICENSE-assets` is written. A stop is not neutral
while the repo is public: if the review finds **redistribution itself**
impermissible, `familiar-cats` is made private immediately (removing the
art from a live public repo is the fallback if privatizing is refused for
some reason); if only the *relicensing* is barred, the repo may stay
public while a narrower grant is chosen. Nothing downstream of §3's cats
items proceeds past a failed review.

## 3. License files and the path-to-license map

Every public repo: `LICENSE` — MIT, copyright Keith Hughitt.

Engine and theme additionally get `LICENSING.md`, the path-to-license
map. The map is **default-plus-exceptions**, so every path — including
ones added later — has a license without being individually listed:

- **default:** everything in the repo → MIT (the repo `LICENSE`);
- **exceptions:** `docs/` and `README.md` → CC BY 4.0, referenced by
  canonical URL — no CC license text vendored;
- vendored or derived data listed explicitly as further exceptions. In
  the engine that means verifying the July items post-split: if
  `vendor/rowcolumn-diacritics.txt` (derived from UnicodeData.txt) is
  present, its entry carries the Unicode license notice. The kitty
  graphics protocol document is handled in §4: it is currently
  **tracked** at `docs/ref/kitty-graphics-protocol.md` and is deleted by
  the sweep, cited by upstream URL only — per the July decision not to
  publish copied spec text.

`familiar-cats` is a small repo, so its map is a "Licensing" section in
its new `README.md` (§4) instead of a separate file, with the same
default-plus-exceptions shape:

- **default:** everything → MIT — covering `theme.yaml`,
  `sprites/**/provenance.json`, and any future tooling files;
- **exceptions:** `sprites/**` images → CC BY 4.0 per `LICENSE-assets`;
  `README.md` and the §2 rights-review document → CC BY 4.0.

`LICENSE-assets` states the CC BY 4.0 grant, the attribution party, an
AI-generated disclosure line naming model and provider, and cites the §2
review document.

No CLA and no contribution agreement: MIT's inbound-equals-outbound is
sufficient.

## 4. Sweep: machine paths, stray artifacts, claims

The sweep targets the living tree, not history. Known engine hits, to be
re-enumerated at execution time rather than trusted from this spec:

- `src/bus/pins.js` and `test/pins.test.js` — machine paths in comments;
  reword neutrally.
- `docs/install.md` — hook commands hardcode a personal clone path;
  replace with a placeholder clone path plus one sentence telling readers
  to substitute where they cloned the repo.
- `.superpowers/sdd/` process reports — removed from the tree. They are
  internal scratch, not documentation.
- `docs/ref/kitty-graphics-protocol.md` — tracked copied spec text;
  deleted by the sweep and cited by upstream URL where referenced (§3).
- `package.json` **and `package-lock.json`** — the `familiar-theme`
  dependency flips `git+ssh://` → `git+https://` (after theme is public,
  §1). The lockfile carries the SSH URL in both the declaration and the
  `resolved` field, so the flip regenerates it; §6's CI runs `npm ci`,
  which would fail on the mismatch otherwise. Both package.json files
  keep `"private": true`: it prevents accidental npm publish and does not
  affect repository visibility.

Theme and cats currently show no machine-path hits; the executing plan
re-greps all three repos rather than relying on that.

README pass: engine and theme READMEs are checked claim-by-claim against
post-split reality (dependency count, repo-family description, install
path). `familiar-cats` gets its first `README.md`: what the pack is, the
one-line `familiar theme add` install, and the Licensing section (§3).

## 5. Secret scan

`gitleaks` with stock rules over the full history of all three repos.
Findings are dispositioned in the gate's execution notes — expected clean,
but the tooled scan is the evidence, per the July revision that replaced
eyeballing with a real tool. A finding that is a real secret stops the
flip for that repo until rotated and dispositioned.

## 6. Minimal CI

- **Engine and theme:** one GitHub Actions workflow each — `npm ci` (the
  frozen install, which also proves the §4 lockfile flip) then `npm test`,
  on push and pull request. Node matrix: the support floor and the
  current release — at gate time that is Node 22 (oldest non-EOL LTS) and
  Node 26; Node 20 is EOL and is not claimed or tested. If the suite
  fails on the floor, the floor moves up and is recorded, rather than the
  failure being patched around.
- **Engine, additionally:** a clean-clone install smoke — fresh
  `npm install` (the user-facing path, distinct from CI's `npm ci`)
  resolving the public `familiar-theme` over HTTPS, then
  `bin/familiar --help` — doubling as proof the §4 dependency flip works
  anonymously.
- **Cats:** a single job that installs `familiar-theme` and runs
  `validateThemePack` against the repo root. Three lines of job; keeps the
  public pack provably installable. This is deliberately short of the
  deferred fuller CI (conformance fixture suite, live HTTPS
  `theme add` integration).

## 7. Acceptance and flip

Per-repo acceptance checklist: rights (cats only) ∙ licenses ∙ sweep ∙
scan ∙ CI green. Then, in order:

1. Cats completes in place (already public).
2. Theme flips public.
3. Engine flips its dependency, passes the clean-clone smoke, flips
   public.

Post-flip verification: anonymous clone of each repo; anonymous
`npm install` of the engine; `familiar theme add` of the public cats URL
against a scratch config. This spec's status header is corrected in the
landing change.

## 8. Decisions

| Decision | Choice |
| --- | --- |
| Cats posture during the gate | stays public; rights review first |
| Public set | engine, theme, cats; forge and archive private |
| Code license | MIT |
| Docs license | CC BY 4.0 + path-to-license map |
| Art license | CC BY 4.0, conditional on the §2 review |
| Attribution party | Keith Hughitt |
| CI scope | minimal (§6); `npm ci` + test; fuller CI deferred |
| Node support | floor = oldest non-EOL LTS (22 at gate time) + current (26); floor moves up on failure |
| Failed rights review | stop + containment: privatize cats if redistribution is barred |
| npm publishing | deferred |
| History rewriting | none; tooled scan is the history evidence |
| Structure | one spec, one sweep, cats → theme → engine |
