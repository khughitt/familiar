# Testing

Use the just front door so each invocation is timed by `tools/tt`:

```sh
just test-one test/test-runner.test.js
just test-one test/attention-signals.slow.test.js integrations/niri-desktop/logic.test.mjs
just test-fast
just test
just test-full
just check
```

`test-one` accepts one or more explicit discovered module paths, including absolute
paths inside the checkout. It preserves caller order and argv boundaries. Empty
selections, options, directories, unknown paths, paths outside the checkout and
normalized duplicates fail before a worker starts. It does not support name filters
or automatic change selection. Do not list the entire inventory to evade policy.

`test-fast` runs the fixed fast partition, also exposed by `npm test`. `test` runs
fast and then slow (`npm run test:slow`). The slow inventory has four modules under
test—attention signals, attention episodes, relay integration and real-tmux pty—and
one Noctalia cadence integration module. Both .js and .mjs slow suffixes are excluded
from fast runs. The pty cases require tmux and util-linux script; focused runs of a
slow module need its usual prerequisites too. Fresh worktrees run `npm ci` and
`node tools/fetch-luau.mjs` to hydrate the pinned Luau runtime.

The runner keeps its suite lease, isolated temporary HOME, explicit worker environment,
Git isolation and cleanup for focused runs. Concurrent suite workers are refused.
On macOS use `TMPDIR=/tmp`; an overlong temporary root is refused before fixtures
are created because Unix-socket paths are short on that platform.

## Gates and policy

`check` and pre-commit always run ops-check, ops-docs and tasks check. Both push
recipes run the same hygiene first; failure prevents their broad child. The full
route then calls `just test`; the fast route calls `just test-fast`.

Preparation has no .tt.toml policy file and leaves `ci_suite_refs` empty, so local
broad checks still run and every push takes the full route. `ci_remote` is origin.
The hook uses the shared template and checks SSH keepalive before starting a gate.

At the separately authorized activation, policy comes only from .tt.toml at the
invoking code checkout's Git top level, validated by its tt wrapper. Detached records
and sibling checkouts never supply it. The planned broad targets are test and
test-fast; focused tests and hygiene remain mandatory. A policy skip launches no
broad child and records null outcomes, rather than a passing suite. Invalid policy
is an error. Explicit `TT_FORCE=1 just test` or `just test-full` deliberately runs
broad verification; test-full records only the inner test invocation. Never persist
TT_FORCE in host configuration.

Coverage is undeclared during preparation. After qualification, the intended refs
are `refs/heads/* refs/tags/*` on origin, including branch names with slashes.
Only a valid push whose non-deleted refs are all covered selects the fast recipe.
Malformed input, another remote or uncovered refs select the full recipe. Policy-off
still skips that broad child, and an uncovered push warns about undeclared hosted
coverage. Both routes keep hygiene. Existing tests have platform-specific omissions,
optional absent in-tree theme fixtures and physical-terminal/live-desktop calibration
outside automated coverage; a pty pass does not certify every terminal. Physical Mac
verification is deferred separately; Linux evidence is not native Darwin evidence.

## Timing and rollback

Historically hook-pre-push timed hygiene and the suite together. Its new series
(and hook-pre-push-fast) measures hygiene only; broad children have their own timing
rows. Do not compare those hook medians as if their workloads were identical.

Activation requires separate accepted hosted qualification and authority. To roll
it back, change automatic_broad to true in .tt.toml, update the installed-policy
behavior assertion in test/test-routes.test.js to expect an executed child, and
restore enabled test cadence in this guide and AGENTS.md. Preserve forced failure
checks, the remote workflow, both push recipes and declared coverage refs. Covered
pushes then run hygiene plus the fast partition; uncovered pushes run hygiene plus
the full suite. Use test-full for deliberate full verification. Record the rollback's
integrated revision/time on the adoption task to restart latency eligibility;
re-enabling policy is not proof of a performance remedy.
