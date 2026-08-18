# Task 2 report: source classification and stderr collapse

## Summary

Implemented the source boundary in `src/theme/acquire.js` and its focused tests in `test/theme-acquire.test.js`. HTTPS URLs classify as remote sources; credentialed, non-HTTPS, malformed HTTPS, missing, and non-directory sources fail with named `theme add` errors. Git stderr is ANSI-stripped, split on CR/LF, control-sanitized, and collapsed to one line.

## Files

- `src/theme/acquire.js`
- `test/theme-acquire.test.js`

## TDD evidence

- RED: `node --test test/theme-acquire.test.js` failed because `src/theme/acquire.js` did not exist (`ERR_MODULE_NOT_FOUND`).
- GREEN: `TMPDIR=/tmp node --test test/theme-acquire.test.js` passed: 9 tests, 9 passed.

## Commands and results

- Focused: `TMPDIR=/tmp node --test test/theme-acquire.test.js` — PASS (9/9).
- Full: `TMPDIR=/tmp npm test` — PASS (713 passed, 2 skipped, 0 failed; 715 tests).
- `git diff --check` — PASS.

## Self-review

- Uses only Node standard-library modules and the exact requested exports.
- Malformed strings beginning `https://` are caught around `new URL()` and receive the HTTPS-or-local-directory instruction.
- Remote stderr cannot retain CR/LF or C0/C1 controls after sanitization.
- No unrelated files or dependencies were changed.

## Concerns

The environment's default temporary directory is read-only (`/mnt/ssd3/tmp`), so tests that create temporary directories require `TMPDIR=/tmp` in this worktree.

## Fix round 1

Addressed review findings by rejecting URI schemes with or without `//` and generic scp-style `user@host:path` sources before `stat`, while preserving Windows drive-shaped paths.

### TDD evidence

- RED: after adding the regression test, `TMPDIR=/tmp node --test test/theme-acquire.test.js` failed on `file:/tmp/theme`; the injected stat ran and produced `stat should not run` instead of the named transport error.
- GREEN: after the classifier guard change, `TMPDIR=/tmp node --test test/theme-acquire.test.js` passed: 10 tests, 10 passed.

### Fix verification

- Focused: `TMPDIR=/tmp node --test test/theme-acquire.test.js` — PASS (10/10).
- Full: `TMPDIR=/tmp npm test` — PASS (714 passed, 2 skipped, 0 failed; 716 tests).
- Self-review: the guard rejects `file:/tmp/theme`, `ssh:host:path`, `mailto:x`, and `user@example.test:repo.git` before filesystem work; ordinary local paths remain stat-checked.
