# Front door for tests. Inner loop: `just test-fast`. Full suite: `just test`.
# Gates: `just check` at pre-commit, `just gate` at pre-push. The git hooks call
# `hook-pre-commit` and `hook-pre-push`, which run the very same commands under their own
# target names so the report can price the hooks separately from the targets people type.
# Fresh clone: `git config core.hooksPath .githooks` to install the hooks.
# Every recipe runs through the vendored timing wrapper `tools/tt` (source of truth:
# ops `bin/tt`), which appends one line per run to the shared timing log.
# Design: ops docs/specs/2026-09-04-test-ci-audit-design.md.

tt := "python3 tools/tt"

# The three commands, each written once, so a hook can never drift from the gate it
# stands in for. `npm test` rather than the runner directly: package.json stays the one
# definition of what the suite is.
#
# fast_cmd is the same command as test_cmd: this project has no affected-only selection.
# The runner's `fast` mode is a filename partition (everything that is not
# `*.slow.test.js`), and the slow partition is currently empty, so `fast` is the whole
# suite. When slow tests appear, test_cmd becomes the two modes in turn and the two
# targets part company; until then the report showing equal durations is the truth.
fast_cmd := "npm test"
test_cmd := "npm test"
# No formatter, linter, or typechecker in this project yet; `tasks check` is the gate.
check_cmd := "python3 tools/ops-check && tasks check"

# Affected-only: the inner loop.
test-fast:
    {{tt}} test-fast -- sh -c '{{fast_cmd}}'

# The full suite.
test:
    {{tt}} test -- sh -c '{{test_cmd}}'

# Seconds, not minutes.
check:
    {{tt}} check -- sh -c '{{check_cmd}}'

gate: check test

# What the pre-commit hook runs: `check`'s command under its own hook target.
hook-pre-commit:
    {{tt}} hook-pre-commit -- sh -c '{{check_cmd}}'

# What the pre-push hook runs: the same commands as `gate`, under one hook target.
hook-pre-push:
    {{tt}} hook-pre-push -- sh -c '{{check_cmd}} && {{test_cmd}}'
