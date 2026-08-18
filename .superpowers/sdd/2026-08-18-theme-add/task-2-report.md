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
