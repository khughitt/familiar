# Task 1: Receipt store report

## Implementation summary

Added the external theme receipt directory to `paths()`, plus strict receipt
path construction, atomic writing, and non-throwing content validation for
HTTPS and local receipt sources.

## Files changed

- `src/bus/paths.js` — added `themeReceiptsDir`.
- `src/theme/receipt.js` — added `receiptPath`, `writeReceipt`, and
  `readReceipt`.
- `test/theme-receipt.test.js` — added eight receipt-store tests.

## Tests

- TDD RED: `node --test test/theme-receipt.test.js`
  - Expected failure: `ERR_MODULE_NOT_FOUND` for
    `src/theme/receipt.js`, because the production module did not yet exist.
  - This was the expected RED state for the new interface.
- Focused GREEN: `TMPDIR=/tmp node --test test/theme-receipt.test.js`
  - 8 passed, 0 failed.
- Full suite: `TMPDIR=/tmp npm test`
  - 702 passed, 2 skipped, 0 failed.

The environment's default `tmpdir()` resolves to a read-only location, so
`TMPDIR=/tmp` was required for filesystem-backed tests.

## TDD GREEN evidence

After the minimal implementation, the focused suite passed all eight tests,
covering path derivation, HTTPS and local round trips, missing files, corrupt
JSON, invalid source shape, invalid dates, and filename/id mismatch.

## Self-review

- `writeReceipt` delegates to the existing atomic writer, which creates the
  parent directory and preserves atomic replacement semantics.
- `readReceipt` distinguishes absent files from invalid content and reports
  validation reasons without swallowing filesystem errors.
- No compatibility layer, new dependency, or unrelated file change was added.
- `git diff --check` passed.

## Concerns

No implementation concerns. Focused and full test commands require
`TMPDIR=/tmp` in this environment because the system-selected temporary
directory is read-only.

## Fix round 1

### Changes

- HTTPS sources now parse with `URL` and require the `https:` protocol.
- `installedAt` now requires an ISO-8601 timestamp with explicit time and
  timezone, valid calendar/time components, and a parseable date.
- Added tests for malformed `https://` and parseable non-ISO/normalized dates.

### TDD RED

Command: `TMPDIR=/tmp node --test test/theme-receipt.test.js`

Expected failure: the two new boundary tests received `validated` instead of
`invalid`, proving the existing checks were too permissive.

### GREEN and regression tests

- `TMPDIR=/tmp node --test test/theme-receipt.test.js`: 10 passed, 0 failed.
- `TMPDIR=/tmp npm test`: 704 passed, 2 skipped, 0 failed.

### Self-review and concerns

The fix is limited to URL parsing, timestamp validation, and their covering
tests. `git diff --check` passed. No remaining concerns; `TMPDIR=/tmp` is
required because the environment's default temporary directory is read-only.
