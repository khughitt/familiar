# Task 9 Report: Docs and final verification

## Files and edits

- `docs/install.md`: added the exact `## 1. Install a theme` section after
  `## 0. Write a scheme`; renumbered the later `##` headings from 1–6 to 2–7.
- `README.md`: replaced the competing manual theme-copy claim with the
  `familiar theme add` install path.
- `docs/specs/2026-08-18-theme-add-design.md`: changed status to
  `implemented, cutover pending`; final cutover remains Task 10.

## Claim search

Ran:

```text
grep -rn "theme" README.md AGENTS.md docs/ --include="*.md" | grep -i "install\|clone\|copy"
```

The only competing user-facing manual-install claim was in `README.md` and was
corrected. Remaining matches are the new install section, unrelated integration
installs, and design/implementation-plan text describing behavior or tests;
none instructs users to manually copy a theme.

## Verification output

- `TMPDIR=/tmp npm test`: PASS — 760 passed, 0 failed, 2 skipped.
- `node bin/familiar theme --help`: PASS — lists `add SOURCE`.
- `node bin/familiar theme add --help`: PASS — shows usage, SOURCE argument,
  HTTPS/local-directory behavior, and examples.
- `git diff --check`: PASS — no whitespace errors.

## Self-review

- The install section text and placement match the brief.
- Only requested heading numbers were changed; surrounding prose is unchanged.
- The design status is truthful for Task 9 and does not claim Task 10 cutover.
- No test or ADR was added.
- No absolute local machine path was added to tracked documentation.

## Concerns

The shipped `cats` pack is intentionally absent from this checkout; the suite
reports its existing conformance case as skipped. Real user-machine cutover is
deferred to Task 10.
