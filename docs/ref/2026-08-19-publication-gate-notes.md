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

3 hits, all the same underlying finding: rule `generic-api-key` matched a
`"key": "a8c54327690f"` field, duplicated across `manifest.json` and
`expansion.json` in commit `9f5048a` under `records/cats-v2-concepts/round-03/`.

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
