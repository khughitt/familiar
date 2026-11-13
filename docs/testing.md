# Testing

Type: guide; document types 1. Run the project’s focused checks, hygiene and explicit
broad verification. See [installation](install.md) and the [terminal contract](terminal-rendering.md)
for prerequisites and evidence boundaries.

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

`test-fast` selects the fixed fast partition, also defined by `npm test`. `test`
selects fast and then slow (`npm run test:slow`); both broad recipes skip under the
local policy unless forced. The slow inventory has four modules under
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

The checkout's .tt.toml sets automatic_broad=false for test and test-fast. Policy
comes only from that file at the invoking code checkout's Git top level, validated
by its tt wrapper; detached records and sibling checkouts never supply it. Use
fresh focused tests for changed behavior and always-run hygiene. A broad policy
skip launches no child and records null outcomes, not a passing suite. Invalid
policy is an error. `TT_FORCE=1 just test` or `just test-full` deliberately runs
broad verification; test-full records only its inner test invocation. Never persist
TT_FORCE in host configuration.

The shared hook checks SSH keepalive before starting a gate. Declared hosted
coverage is `refs/heads/* refs/tags/*` on origin, including branch names with slashes.
Only a valid push whose non-deleted refs are all covered selects the fast recipe.
Malformed input, another remote or uncovered refs select the full recipe. Policy-off
still skips that broad child, and an uncovered push warns about undeclared hosted
coverage. Both routes keep hygiene. Existing tests have platform-specific omissions,
optional absent in-tree theme fixtures and physical-terminal/live-desktop calibration
outside automated coverage; a pty pass does not certify every terminal. Physical Mac
verification is deferred separately; Linux evidence is not native Darwin evidence.

## Hosted verification

The workflow runs on all branch and tag pushes and manual dispatch.
In-repository PR events skip all verification jobs because their push already
runs them; fork PR events retain verification. Workflow/ref concurrency cancels
an older run on the same ref. A cancelled or incomplete revision is unverified;
diagnose failures before rerunning and back off for known provider outages. Coverage
declarations describe configured routes; check the actual latest-head job results
to confirm execution.

TT_FORCE=1 is explicit at workflow scope. Ubuntu Node 22 and 26 each run the fast
and slow partitions once via `just test`. macOS 15 Node 22 uses `just test-fast`,
retaining its Darwin output assertions and linked-command smoke. The Ubuntu Node
26 clean-install smoke preserves its unlocked dependency install. Every job has a
20-minute timeout, standard runners and read-only repository permission.

Mac streams stdout through tee, captures stderr separately, then appends stderr to
the same displayed log before checking the suite status and Darwin assertions.
Node can make an inherited pipe nonblocking; merging it with the Python timing
collector's stdout can lose output under backpressure. Separate stderr preserves
the complete log and the original failure status; stderr appears after stdout.

Suite jobs run portable hygiene only after npm ci and the pinned Luau fetch.
They do not run tasks check or consult a developer task registry. The independent
install smoke deliberately lacks Luau hydration and does not run that hygiene.

Timing series combine hosted and local requests: separate execution reason and host
context before comparing them. Renaming a target or combining partitions is not a
measured speedup; historical before-series comparisons belong with their evidence.

Qualification must account for actual counts, skips, modules with skips, zero
excluded modules and capability omissions in all four jobs. Platform-specific cases,
optional missing theme fixtures and physical terminal/desktop calibration remain
explicit limits. Missing Luau or pty prerequisites must not become accepted skips.

## Timing and rollback

Historically hook-pre-push timed hygiene and the suite together. Its new series
(and hook-pre-push-fast) measures hygiene only; broad children have their own timing
rows. Do not compare those hook medians as if their workloads were identical.

To restore automatic local broad tests, change automatic_broad to true in .tt.toml,
update the installed-policy behavior assertion in test/test-routes.test.js to expect
an executed child, and restore enabled test cadence in this guide and AGENTS.md. Preserve forced failure
checks, the remote workflow, both push recipes and declared coverage refs. Covered
pushes then run hygiene plus the fast partition; uncovered pushes run hygiene plus
the full suite. Use test-full for deliberate full verification. Record the rollback's
integrated revision/time on the adoption task to restart latency eligibility;
re-enabling policy is not proof of a performance remedy.
