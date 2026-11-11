# Front door for recorded testing. Work on explicit modules with test-one;
# test-fast is the fixed fast partition and test adds the slow partition.
# Install hooks in a fresh clone: git config core.hooksPath .githooks.
# Reference: docs/testing.md; tools/tt is vendored from ops.
set quiet
set positional-arguments

tt := "python3 tools/tt"
fast_cmd := "npm test"
test_cmd := "npm test && npm run test:slow"
one_cmd := "node tools/test-runner.mjs one"
check_cmd := "python3 tools/ops-check && python3 tools/ops-docs check && tasks check"

# Coverage stays undeclared until the reviewed hosted qualification succeeds.
ci_remote := "origin"
ci_suite_refs := ""

test-fast:
    {{tt}} test-fast -- sh -c '{{fast_cmd}}'

# Pass each argument intact, outside the command string.
test-one +args:
    {{tt}} test-one -- sh -c '{{one_cmd}} "$@" 2>&1' test-one "$@"

test:
    {{tt}} test -- sh -c '{{test_cmd}}'

# Only the inner test invocation records a timing row.
test-full:
    TT_FORCE=1 just test

check:
    {{tt}} check -- sh -c '{{check_cmd}}'

gate: check test

# Regenerate guide regions from identity.toml and tools/family.toml.
docs:
    {{tt}} docs -- python3 tools/ops-docs write

hook-pre-commit:
    {{tt}} hook-pre-commit -- sh -c '{{check_cmd}}'

# Hook timers cover hygiene only; broad children record their own decisions.
hook-pre-push:
    {{tt}} hook-pre-push -- sh -c '{{check_cmd}}'
    just test

# The shared hook selects this route only for declared hosted coverage.
hook-pre-push-fast:
    {{tt}} hook-pre-push-fast -- sh -c '{{check_cmd}}'
    just test-fast
