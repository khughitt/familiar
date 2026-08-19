# Publication gate — execution notes

Scan and audit dispositions for the three public repos, per the gate spec
(`docs/specs/2026-08-19-publication-gate-design.md` §5).

## familiar-cats

### gitleaks

Initial scan, full history (timestamp prefixes stripped from the pasted log lines below):

```
INF 7 commits scanned.
INF scanned ~3030176 bytes (3.03 MB) in 324ms
WRN leaks found: 3
```

3 hits, all the same underlying finding: rule `generic-api-key` matched the
value `a8c54327690f` in a `key` field, duplicated across `manifest.json` and
`expansion.json` in commit `9f5048a` under `records/cats-v2-concepts/round-03/`.
(This value is written here in prose — value, then field — rather than in
the JSON key-colon-quoted-value form that appears in the source files
themselves, so that documenting the finding does not itself reproduce the
pattern the `generic-api-key` rule matches and re-trigger the same rule on
every future scan of this file.)

Investigated and dispositioned a false positive: every character record in that
manifest (`nekomata`, `maine-coon`, `ginger`, `impostor`, `meerkat`, `spectral-cat`,
`maneki-neko`, `witches-familiar`, and one more — nine total) carries its own
12-hex-character `key` field, a per-record correlation id used to line up entries
across the generation pipeline's own files. Low entropy consistent with a generic
regex match, not a credential — no adjacent token, bearer, or auth-header material
anywhere near the field in either file.

Reachability at the time of the initial scan: commit `9f5048a` was never on `main` —
it was the tip of `refs/heads/exploration`, a second branch that was live and pushed
to the public GitHub repo, browsable by anyone with the URL. The "not on `main`"
fact alone would have understated this: the branch, not just the commit, was
publicly reachable.

Resolution: escalated to the human, who asked whether the branch's contents were
preserved elsewhere before agreeing to remove it. Verified: all 407 files under that
history are byte-identical (same blob hashes) to their counterparts under
`exploration/` in the private `familiar-archive` repo, which is pushed to its
private remote. On that basis the human directed removal of the branch from the
public cats repo; it was deleted from `origin` and pruned locally, so nothing was
lost and nothing public was left dangling on it.

Final scan, over the resulting history (timestamp prefixes stripped):

```
INF 6 commits scanned.
INF scanned ~175142 bytes (175.14 KB) in 148ms
INF no leaks found
```

Disposition: initial `generic-api-key` hits were a false positive (per-record
correlation id, not a credential); separately, the commit that carried them was
reachable via a live public `exploration` branch (never `main`) and was removed
from the public repo after its contents were confirmed preserved byte-identical in
the private `familiar-archive` repo. Current public history (6 commits, `main` only)
scans clean — no leaks found. No further action.

### npm audit

Not applicable — no package.json, no dependencies.

Disposition: not applicable — no package.json, no dependencies.

### gitleaks (final, full history at commit `ab828e4`)

Full-history rescan run at `ab828e4` (`ci: report the pack member count
correctly`), the current pushed head of `main`, which is the CI workflow
commit (Task 6) plus its one-word member-count fix — the last two commits
that closed cats' checklist item now that `familiar-theme` is public
(timestamp prefixes stripped from the pasted log lines below; the summary
carries no file paths since this scan produced zero findings, so nothing
else was stripped):

```
INF 8 commits scanned.
INF scanned ~175799 bytes (175.80 KB) in 152ms
INF no leaks found
```

Disposition: clean — no action. Full history (8 commits: the six prior, the
CI-workflow commit, and its member-count fix) scans clean at `ab828e4`,
the current head of `main`. Cats' public history is now final.

## familiar-theme

### gitleaks

```
INF 2 commits scanned.
INF scanned ~109775 bytes (109.78 KB) in 78.7ms
INF no leaks found
```

Disposition: clean — no action.

### npm audit (--omit=dev)

```
found 0 vulnerabilities
```

Disposition: clean — no action.

### gitleaks (final, full history at the v0.1.1 release commit)

Full-history rescan run against the `v0.1.1` release commit, after the licensing
and CI-workflow commits and before the visibility flip (timestamp prefixes
stripped from the pasted log lines below):

```
INF 5 commits scanned.
INF scanned ~111598 bytes (111.60 KB) in 84.4ms
INF no leaks found
```

Disposition: clean — no action. Full history (5 commits, including the licensing,
CI-workflow, and `v0.1.1` release commits) scans clean immediately before the
repository was flipped public.

## familiar (engine)

### gitleaks

Initial scan, full history (timestamp prefixes stripped from the pasted log lines below):

```
INF 42 commits scanned.
INF scanned ~1118750 bytes (1.12 MB) in 178ms
WRN leaks found: 2
```

2 hits:

1. Rule `generic-api-key` matched the value `a8c54327690f` in a `key` field
   at `docs/ref/2026-08-19-publication-gate-notes.md:19` (this file). That line
   is this notes file's own `## familiar-cats` section quoting, as
   documentation, the value of a false positive already investigated and
   dispositioned during the cats scan (a per-record correlation id in
   `manifest.json`/`expansion.json`, not a credential). The "finding" here is
   gitleaks re-matching the same already-explained string inside our own
   record of it — no new secret, nothing to act on.
2. Rule `private-key` matched a PEM block in `test/fixtures/tls/key.pem`.
   This is a self-signed TLS keypair (paired with `test/fixtures/tls/cert.pem`)
   used only by `test/theme-add-https.test.js` to stand up a local HTTPS test
   server; it authenticates nothing beyond that in-process test fixture.

Disposition: both accepted as non-findings, no action. (1) is a quotation of
a previously dispositioned false positive, not an independent secret. (2) is
a throwaway self-signed test fixture, not a credential for any real service.

### npm audit (--omit=dev)

```
# npm audit report

@babel/core  <=7.29.0
@babel/core: Arbitrary File Read via sourceMappingURL Comment - https://github.com/advisories/GHSA-4x5r-pxfx-6jf8
fix available via `npm audit fix --force`
Will install @opentui/solid@0.1.10, which is a breaking change
node_modules/@babel/core
  @opentui/solid  <=0.0.0-20260812-897d859a || >=0.1.11
  Depends on vulnerable versions of @babel/core
  node_modules/@opentui/solid

2 low severity vulnerabilities
```

Matches the design-time observation of two low findings.

Disposition: both accepted (low, no exposed surface).

- `@babel/core` (transitive, via `@opentui/solid`): GHSA-4x5r-pxfx-6jf8,
  arbitrary file read via a crafted `sourceMappingURL` comment, CVSS 3.2
  (low). The path requires babel to transform attacker-controlled source
  containing a malicious `sourceMappingURL`; `familiar` does not feed
  untrusted source into babel at runtime — it is pulled in as part of the
  `@opentui/solid` TUI toolchain. No exposed attack surface.
- `@opentui/solid` (direct): flagged solely because it depends on the
  vulnerable `@babel/core` range above; same disposition. The only fix
  path is `npm audit fix --force`, which downgrades `@opentui/solid` to
  `0.1.10` — a semver-major, breaking regression from the `0.4.3` currently
  in use, not warranted for a low-severity finding with no exposed surface.

### the lockfile's `resolved` field carries `git+ssh`, and that's expected

`package-lock.json` declares `familiar-theme` as
`git+https://github.com/khughitt/familiar-theme.git#v0.1.1` in both
`package.json` and the lockfile's root `dependencies` mirror, but the
per-package entry's `resolved` field reads
`git+ssh://git@github.com/khughitt/familiar-theme.git#<sha>`. This is not a
broken or private install path: npm's `pacote` computes a git dependency's
`resolved` field from the host and prefers the SSH form unless the source
URL carries embedded credentials, so the only way to get `git+https` into
`resolved` would be committing a token into this public lockfile, which we
will not do. A clean `npm ci` with SSH fully disabled (`GIT_TERMINAL_PROMPT=0`,
no credential helper, no SSH agent, no askpass) was verified to install
`familiar-theme` `0.1.1` — with its `LICENSE` — entirely over HTTPS, as part
of the end-to-end anonymous verification that installed `familiar-cats` as a
theme after a clean `npm install`.

Disposition: clean — no action; `resolved: git+ssh` is a benign artifact of
how npm computes that field, not evidence of a private dependency.

### gitleaks (final, full merged history before the flip)

Rescan run against the merge commit (`main` after `publication-gate` merged
in, before the visibility flip):

```
INF 43 commits scanned.
INF scanned ~1121470 bytes (1.12 MB) in 177ms
WRN leaks found: 3
```

3 hits — one more than the initial engine scan's 2, all the same two
underlying non-findings:

1. Rule `generic-api-key` matched the value `a8c54327690f` in a `key` field
   twice: once at `docs/ref/2026-08-19-publication-gate-notes.md:19` (the
   `## familiar-cats` section quoting the value investigated and
   dispositioned during the cats scan), and a second time in this file's own
   `## familiar (engine)` section, where the write-up of that same finding
   quotes the identical value again. Both are quotations of one
   already-dispositioned false positive — a per-record correlation id, not a
   credential — not independent secrets.
2. Rule `private-key` matched the self-signed TLS test fixture at
   `test/fixtures/tls/key.pem`, used only by `test/theme-add-https.test.js`
   to stand up a local HTTPS test server; it authenticates nothing beyond
   that in-process fixture.

Disposition: clean — no action. All 3 hits trace to the same two
already-investigated non-findings (a doc quoting itself quoting a
dispositioned false positive, and a throwaway test TLS fixture); no new
secret. Full merged history scans with zero actual credential exposure
immediately before the repository was flipped public.

### gitleaks (post-correction rescan — the count did not drop)

After rewriting the three quotations above to prose form (this file, commit
`0769847`), re-ran the full-history scan on `main`:

```
INF 45 commits scanned.
INF scanned ~1125924 bytes (1.13 MB) in 181ms
WRN leaks found: 4
```

Still 4 — unchanged from the pre-fix count, and the count is *not* expected
to drop from any further forward-only commit. The reason: `gitleaks detect`
scans full git history via `git log -p`, matching each commit's own patch.
The three `generic-api-key` hits below are each pinned to the specific
already-pushed, public commit whose diff *added* the JSON-form quotation;
rewriting the text in a later commit changes what the working tree shows,
but does not and cannot alter an earlier commit's patch. Those three commits
are permanent, immutable public history:

1. `e4d4c908` (`docs(publication): record cats scan dispositions`) — added
   line 19 of this file, in the `## familiar-cats` section.
2. `8f5d2444` (`docs(publication): record engine scan dispositions`) — added
   the `## familiar (engine)` section's first quotation of the same value.
3. `ff26eba8` (`docs(publication): record the gate as closed`) — added this
   section's own quotation of the same value.
4. `49fd2fc1` (`fix(theme): terminate timed-out HTTPS clones`) — the
   self-signed TLS test fixture at `test/fixtures/tls/key.pem`, unchanged
   throughout, same disposition as above.

Disposition: clean — no action, all 4 already investigated. The prose fix
(commit `0769847`) was still worth making: it stops the pattern from
recurring in the *current* tree and in any future commit that quotes this
value again, which is the only thing a forward-only commit can affect. It
does not and cannot retroactively clear the 3 `generic-api-key` hits already
baked into public history at `e4d4c908`, `8f5d2444`, and `ff26eba8` — those
remain permanent, individually-dispositioned artifacts of this document's
own history, not evidence of an exposed credential. A tool-level allowlist
(e.g. a gitleaks baseline keyed to these fingerprints) could suppress them
in future scan output without a history rewrite; none was added here, since
that is a scanning-policy decision outside this fix's scope.
