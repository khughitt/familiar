# Worktree Pin Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve repository visual choices in Git worktrees, with explicit
checkout overrides and measured hook cost.

**Architecture:** Discover one repository anchor through bounded Git queries,
carry it through all existing consumers, and extend the existing pin tiers.
Keep the current checkout as the Codex config target. Measure the complete CLI
hook with real Git and temporary state before and after changing discovery.

**Tech Stack:** Node.js 22+, JavaScript ES modules, node:test, Git, Python 3
`tools/tt`, just, existing `yaml` and public `familiar-theme` exports. No new
package dependency.

**Spec:** `docs/specs/2026-10-07-worktree-pin-inheritance-design.md`, approved by
the user at `842c20d`. Design/plan task: `fam-9ab24c`. Execution goal:
`fam-169e3f`. This plan still requires user review before implementation.

**Execution recommendation:** Native inline. Context, record and matcher
signatures are tightly coupled; one implementer can retain that context. A
fresh whole-branch reviewer checks the completed branch before local merge.
Use subagent-driven execution instead if the user requests it.

## Global Constraints

- Remote > path > project remains intact; exact checkout tiers precede inherited
  tiers within the path/name classes. First entry wins within each tier.
- One authored catalog; winning pins supply their complete slot/member choice.
- `repositoryRoot` is the only new persisted context field. Null is explicit
  outside a worktree; a missing own property must fault an old runtime record.
- Worktree labels stay the current checkout basename. Remote-less keys use the
  repository anchor. Ordinary main-checkout keys stay unchanged.
- The inherited `.git` name tier is omitted; other suffixes/case stay verbatim.
- All discovery commands share a two-second deadline and `SIGKILL`. No sibling
  inventory, filesystem scan, new registry, persistent cache or daemon.
- Conventional physical `<main>/.git` is the implicit layout; separated linked
  metadata needs `core.worktree`. Undeclared separated `store/.git` is ambiguous
  and is not guaranteed to produce a diagnostic.
- Main lookups use two Git spawns; linked lookups use three. Newline ambiguity
  adds three per-option calls within the same deadline.
- Pet config writes stay at the actual checkout. The idempotent Git exclusion
  line remains in the repository-wide `info/exclude`.
- No live host wiring, launcher repointing, pin relocation, relay migration,
  upstream publication, compatibility layer or dependency change.
- Test through `just test-fast`; there is currently no `test-one` recipe.
  `just check`/`tasks check` and whitespace checks must pass before each commit.
  The full/slow suite stays in the configured hooks/CI unless its behavior is
  affected or the user requests it.

## Review Focus

1. A cosmetic hook can exit zero after failing: benchmark samples must prove
   successful bus/intent writes and reject diagnostics (Task 1).
2. A partial bare result followed by a signal/timeout is not the recognized
   exit-128 result; it must fail without a guessed anchor (Task 2).
3. A path ending in LF or containing CR must survive framing exactly; no broad
   trimming or newline normalization is allowed (Task 2).
4. A combined-selector entry can win a different tier after inheritance; test
   the full pin object and preserve entry order (Task 3).
5. The shared exclusion file can change during a worktree-only config update;
   check both the target config and shared idempotent exclusion (Task 4).

## Workspace and setup at execution

| Step | Task record | Must follow |
| --- | --- | --- |
| 1 — Benchmark and baseline | `fam-4f90f3` | Design/plan review completion (`fam-9ab24c`) |
| 2 — Anchor discovery and propagation | `fam-d07bb3` | Step 1 and review completion |
| 3 — Inherited pin precedence | `fam-449468` | Step 2 and review completion |
| 4 — Integration and latency acceptance | `fam-f3d48e` | Step 3 and review completion |

All source paths below are repository paths within the existing worktree.
From the main checkout, enter it with:

```sh
cd .worktrees/worktree-identity
```

- [ ] Confirm spec/plan approval notes on `fam-9ab24c`, close that design task
  with the reviewed design/plan result, notify `fam-a940d1`, and update the
  brief in the same commit. This releases the execution steps' review dependency.
  Change the execution goal `fam-169e3f` to direct process with a note that
  the reviewed artifacts now settle the implementation; do not select process
  from links alone.
- [ ] Re-enter the worktree skill; verify the existing branch and clean product
  files. Reuse this worktree; do not create another or touch `popup-smooth`.
- [ ] Run `tasks prime` and `tasks ready --under fam-169e3f`; confirm the next
  table entry is eligible and not held by another session or a halt.
- [ ] There is no `setup` recipe. Follow `docs/install.md`'s dependency command
  `npm install` here; do not run `npm link`. Inspect lockfile changes rather than
  accepting an unrelated dependency update.
- [ ] Run deferred baseline `just test-fast`. Record the observed result before
  changing product code. Investigate baseline failures before implementation.
- [ ] Start the actual task id from the table and arm the same id; for Step 1:
  `tasks start fam-4f90f3`, then `~/.agents/bin/trial-arm fam-4f90f3`.
  Follow its printed arm. Close the step in its
  implementation commit. The parent execution goal closes after all steps and
  final review/latency disposition, not when its plan is merely written.

---

### Task 1: Add a tested hook latency benchmark and record baseline

**Files:**

- Modify: `justfile` (one permanent benchmark recipe).
- Create: `tools/bench-hook.mjs` (fixture orchestration, worker, statistics and
  before/after report).
- Create: `test/fixtures/hook-bench-preload.mjs` (test-only process selection and
  real-Git instrumentation, loaded explicitly by benchmark hook children).
- Create: `test/fixtures/git-worktree.mjs` (Git fixture shared with later tests).
- Create: `test/bench-hook.test.js` (lasting recipe/tool checks).

**Interfaces:**

- `git(root, args)` synchronously executes real Git with argv, UTF-8 output,
  a five-second fixture-command timeout and `core.hooksPath=/dev/null`; it
  throws on any unexpected exit. It returns stdout with exactly one final LF
  removed. Callers needing a known nonzero result use `spawnSync` directly.
- `fixtureGitEnv(over = {})` copies the supplied process environment, removes
  inherited `GIT_*` bindings, and sets `GIT_CONFIG_NOSYSTEM=1` and
  `GIT_CONFIG_GLOBAL=/dev/null`. Use it only in fixture commands/benchmark
  workers, never to change production Git configuration semantics.
- `seedRepo(root, { gitDir = null } = {})` initializes `main`, optionally with
  `--separate-git-dir`, and makes an empty fixture commit using command-local
  identity. `addWorktree(main, target)` adds a detached checkout. Helpers do not
  register projects, install hooks or mutate global Git configuration.
- `just bench-hook PHASE FIXTURE SAMPLES WARMUPS BATCHES` with defaults
  `SAMPLES=30`, `WARMUPS=5`, `BATCHES=2`. PHASE is `before` or `after`;
  FIXTURE is an explicit directory outside live state. No default HOME location.
- `summarize(samples)` returns `{ medianMs, p95Ms }` using sorted numeric values
  and nearest-rank p95. Empty/nonfinite samples are errors.
- `proveHook(result, agents, intents, sessionId, workerPid, checkout)` throws
  for a spawn failure, nonzero exit, stdout/stderr, wrong working state,
  missing session, wrong owner PID or wrong checkout root. Return nothing on
  success. The worker uses this exported testable check for every warm-up and
  measured hook; test exit zero plus a diagnostic directly against it.
- `compare(before, after)` returns `{ verdict, reasons, contexts }`. Contexts
  contain main/linked medians, p95, absolute/percentage deltas, baseline batch
  variation and verification-probe duration. Wrong after counts or unexplained
  slowdown yields `needs-investigation`, not a silently passing report.

- [ ] **Step 1: Add failing tests for the permanent deliverable.**

Start with pure statistics/validation and an actual just recipe smoke test:

```js
import { summarize, compare, proveHook } from '../tools/bench-hook.mjs';
const REPO = fileURLToPath(new URL('..', import.meta.url));

test('benchmark statistics preserve measured milliseconds', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { medianMs: 2.5, p95Ms: 4 });
  assert.throws(() => summarize([]), /samples/);
  assert.throws(() => summarize([NaN]), /finite/);
});

test('a cosmetic exit-zero failure is not a successful benchmark sample', () => {
  const session = 'bench-main';
  const agents = { [session]: { pid: 42, repoRoot: '/fixture/api', state: 'working' } };
  const intents = { [session]: { current: { state: 'working' } } };
  const result = { status: 0, stdout: '', stderr: 'familiar: bad discovery\n' };
  assert.throws(() => proveHook(result, agents, intents, session, 42, '/fixture/api'),
    /cleanly|diagnostic/);
  result.stderr = '';
  proveHook(result, agents, intents, session, 42, '/fixture/api');
  delete intents[session];
  assert.throws(() => proveHook(result, agents, intents, session, 42, '/fixture/api'));
});

test('just bench-hook records both contexts and successful hooks', {
  skip: process.platform !== 'linux' && 'CLI fixture uses Linux /proc',
}, (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'familiar-bench-test-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const log = join(fixture, 'runs.jsonl');
  const result = spawnSync('just', [
    'bench-hook', 'before', fixture, '1', '0', '1',
  ], { cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TT_LOG: log } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(fixture, 'before.json'), 'utf8'));
  assert.equal(report.schema, 1);
  assert.equal(report.phase, 'before');
  for (const name of ['main', 'linked']) {
    const sample = report.contexts[name].batches[0].samples[0];
    assert.ok(Number.isFinite(sample.hookMs) && sample.hookMs > 0);
    assert.ok(sample.git.length >= 2);
    assert.equal(sample.provedState, 'working');
  }
  const runs = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  for (const name of ['main', 'linked']) {
    assert.ok(runs.some((r) => r.target === `bench-hook-${name}-before`
      && r.exit === 0));
  }
});
```

Add these concrete pure comparison tests. Their report shape is the same
shape emitted by the worker; these exercise the verdict even when the CLI
smoke uses only one sample:

```js
const synthetic = (mainMs, linkedMs, linkedCalls, probeMs = 0) => ({
  contexts: Object.fromEntries([
    ['main', mainMs, 2], ['linked', linkedMs, linkedCalls],
  ].map(([name, hookMs, count]) => [name, { batches: [0, 1].map(() => ({
    samples: [0, 1].map(() => ({ hookMs, provedState: 'working',
      git: Array.from({ length: count }, (_, i) => ({
        args: name === 'linked' && i === 2 ? ['--is-bare-repository'] : ['rev-parse'],
        ms: name === 'linked' && i === 2 ? probeMs : 1, exit: 0,
      })),
    })),
  })) }])) });

test('benchmark verdict accounts for one measured probe and flags regressions', () => {
  const before = synthetic(10, 10, 2);
  assert.equal(compare(before, synthetic(10, 12, 3, 2)).verdict, 'accept');
  assert.equal(compare(before, synthetic(20, 12, 3, 2)).verdict, 'needs-investigation');
  assert.equal(compare(before, synthetic(10, 12, 4, 2)).verdict, 'needs-investigation');
});
```

Add command checks that reject `after` without baseline, a reused `before.json`,
an invalid phase/nonpositive samples, and a child with a diagnostic despite
exit zero. Test argument forwarding with a fixture directory containing spaces
and an apostrophe. Keep pure tests portable; only the Linux CLI smoke is skipped
on other hosts. The real-Git discovery tests in Task 2 are not Linux-only.

- [ ] **Step 2: Run `just test-fast`; confirm the missing tool/recipe tests fail.**

The RED failure must name the absent benchmark import or recipe. Do not count
unhydrated dependency errors as the expected failure.

- [ ] **Step 3: Implement the fixture and benchmark with standard library tools.**

The shared fixture helper can use this exact pattern:

```js
export function git(root, args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', env: fixtureGitEnv(),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
}
export function seedRepo(root, { gitDir = null } = {}) {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main',
    ...(gitDir === null ? [] : ['--separate-git-dir', gitDir])]);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '--allow-empty', '-m', 'fixture']);
  return realpathSync(root);
}
export const addWorktree = (main, target) => {
  git(main, ['worktree', 'add', '-q', '--detach', target]);
  return realpathSync(target);
};
```

- [ ] **Step 4: Implement the owned controller and isolated worker invocation.**

`tools/bench-hook.mjs` has controller and internal worker modes in the same
file. Define the environment helper in the shared Git fixture module:

```js
export function fixtureGitEnv(over = {}) {
  const env = { ...process.env, ...over };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}
```

Its test sets bogus `GIT_DIR`/`GIT_WORK_TREE` and confirms seeded fixture
metadata stays inside the supplied root. Do not unset the caller's real shell
variables; this is a child-process environment only. Test through
`fixtureGitEnv(over)` and a child; do not mutate the test runner environment.
Load/test the preload exclusively in child processes; importing its global
patches into the test runner would contaminate unrelated tests.

The controller creates/reuses FIXTURE's `repo`, `linked`, config/theme
and results. Copy `test/fixtures/theme-pack` to the fixture themes root, use
`theme: fixture`, `motion: reduced`, dark/satScale=1, and an empty pin catalog.
Set the worker's HOME, CODEX_HOME and all FAMILIAR directories to fixture-owned paths.
Clear TMUX, TMUX_PANE and NODE_OPTIONS, set TERM=dumb, and keep all child
stdout/stderr as pipes. Refuse to reuse an unrelated nonempty directory;
require the fixture manifest on subsequent calls. Store phase artifacts
without overwriting an earlier phase.

For each context, the controller runs the internal worker through the existing
wrapper using argv, not a shell string:

```js
const args = [
  join(REPO, 'tools/tt'), `bench-hook-${context}-${phase}`, '--',
  'env', ...Object.entries(workerOverrides).map(([k, v]) => `${k}=${v}`),
  process.execPath, fileURLToPath(import.meta.url), '--worker',
  phase, fixture, context, String(samples), String(warmups), String(batches),
];
const child = spawn('python3', args, {
  cwd: REPO, env: trackingEnv, stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
```

Record each owned group leader in the fixture's `active-groups.json` before
waiting; clear that entry only after cleanup. The recipe smoke checks that
this manifest is empty/removed when the command returns. Keep stdout piped
regardless of the caller's terminal.

`trackingEnv` retains the caller's HOME/XDG/TT_LOG and session identity so tt
records in its normal shared log (or the test's explicit TT_LOG), while clearing
Git bindings through `fixtureGitEnv` and TMUX/NODE_OPTIONS. `workerOverrides`
assigns the fixture HOME/XDG, CODEX_HOME, all Familiar directories, TERM=dumb
and empty TMUX/NODE_OPTIONS before the worker starts. Passing these as `env`
argv assignments preserves spaces/apostrophes and ensures the worker's initial
`/proc` environment cannot trigger a live tmux probe. Never give tt a fixture
HOME and accidentally redirect its timing log out of the shared record.

Here `detached` creates an owned process group only: the controller awaits it,
captures its output and never returns while it runs. On EXIT/TERM/INT or a
bounded timeout, kill/reap that owned group, including tt, worker and hooks.
Do not disown or use nohup. Complete group cleanup before reporting a failure.
This ensures worker fd 1 is always a private pipe even when a person runs
the recipe from a terminal.

- [ ] **Step 5: Implement the timed CLI hook loop and sample proof.**

The worker runs the repository's explicit `bin/familiar` through Node for
`hook PreToolUse --agent claude-code`, with a stable `bench-main` or
`bench-linked` session id. Each subprocess uses:

```js
const started = performance.now();
const r = spawnSync(process.execPath, [
  '--import', preloadPath, binPath, 'hook', 'PreToolUse', '--agent', 'claude-code',
], { cwd: checkout, env: sampleEnv,
  input: JSON.stringify({ session_id: sessionId, cwd: checkout }),
  encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
const hookMs = performance.now() - started;
if (r.error) throw r.error;
if (r.status !== 0 || r.stderr !== '' || r.stdout !== '') {
  throw new Error(`benchmark hook did not complete cleanly: ${r.stderr}`);
}
const agents = JSON.parse(readFileSync(paths.agentsPath, 'utf8'));
const intents = JSON.parse(readFileSync(paths.intentPath, 'utf8'));
proveHook(r, agents, intents, sessionId, process.pid, checkout);
```

The exported proof uses the same checks as the loop and is tested directly:

```js
export function proveHook(r, agents, intents, sessionId, workerPid, checkout) {
  if (r.error) throw r.error;
  if (r.status !== 0 || r.signal || r.stderr !== '' || r.stdout !== '') {
    throw new Error(`benchmark hook did not complete cleanly: ${r.stderr}`);
  }
  assert.equal(agents[sessionId]?.state, 'working');
  assert.equal(intents[sessionId]?.current?.state, 'working');
  assert.equal(agents[sessionId]?.pid, workerPid);
  assert.equal(agents[sessionId]?.repoRoot, checkout);
}
```

- [ ] **Step 6: Implement the explicit test-only preload and real-Git metrics.**

Use the test-only preload to make process selection deterministic: replace
`defaultProcessOps.ancestors` with the real hook and its real worker parent
records, changing only the parent fixture's reported comm to `claude` and
selection tty flag to non-null. PID/starttime and liveness stay real; the
actual parent's stdout remains a pipe, so emission's real isatty guard
suppresses terminal output. This injection is fixture machinery, not a
production flag. Do not change adapters or launch an actual agent/TUI.

Instrument the real `node:child_process.execFile` before importing the CLI,
then call `syncBuiltinESMExports()`. Forward argv/options/callback unchanged;
record only Git argv, elapsed milliseconds and exit outcome. Preserve
`promisify.custom` behavior by returning `{ stdout, stderr }` and the original
error with its stdout/stderr, so the native bare failure is not changed by
instrumentation. Flush metrics synchronously to the sample's fixture trace
at process exit. Test that both success and a known nonzero real-Git result
retain their output/exit semantics. Product modules never import this preload.

Time from before spawning the hook to completed child exit, before reading
its metrics. This measures CLI startup, fixture preload, real Git, theme
resolution, transaction writes and non-TTY presentation/cleanup; it excludes
an actual agent/TUI, PTY/graphics delivery and live Darwin latency. Report that
boundary explicitly. The same preload/setup is used in both phases.

- [ ] **Step 7: Implement summaries, comparison, persistence and recipe.**

Use a direct numeric implementation for the exported summary:

```js
export function summarize(samples) {
  if (samples.length === 0) throw new Error('benchmark has no samples');
  if (!samples.every(Number.isFinite)) throw new Error('samples must be finite');
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianMs: sorted.length % 2 ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
```

`compare` uses the largest before batch median as reference and max minus min
of before batch medians as measured variation. Main after median may be no
higher than reference plus variation; linked also gets the median measured
duration of its one additional probe (`args` includes `--is-bare-repository`).
Check every after sample for two/main or three/linked Git calls. Emit reasons
for exceeded bounds or wrong counts, plus p95/deltas for human disposition.
Keep the same settings/versions/fixture identity across phases; reject a
mismatched artifact instead of silently comparing unrelated runs.

Store each successful sample as `{ hookMs, git: [{ args, ms, exit }],
provedState: 'working' }`, grouped by context and batch. Warm-ups are validated
but omitted from statistics. The report contains schema=1, phase, revision,
dirty flag, Node/Git versions, fixture identity, measurement boundary, raw
batches, summary and comparison when `after`. Append completed samples to
per-context JSONL as they finish, so an aborted run retains analyzable evidence.
Persist raw results outside the
repository; record their absolute artifact location on the task during execution.
Budgets smaller than 30 samples/two batches are explicitly `pilot-only`:
validate hooks, artifact settings and after counts, but do not claim statistical
latency acceptance from a single sample. The synthetic verdict checks above
exercise the comparison gate without relying on noisy pilot timing.

The just recipe forwards its parameters through exported recipe variables,
avoiding shell interpolation of a fixture path:

```just
bench-hook $phase $fixture $samples="30" $warmups="5" $batches="2":
    node tools/bench-hook.mjs "$phase" "$fixture" "$samples" "$warmups" "$batches"
```

The controller's per-context `tools/tt` calls record the timings; do not add
another timer wrapper or call a test runner from this recipe.

- [ ] **Step 8: Run `just test-fast` and the smallest benchmark pilot.**

Use `mktemp -d` for FIXTURE; keep its path in the task note. Run:

```sh
bench_fixture=$(mktemp -d)
just bench-hook before "$bench_fixture" 1 0 1
```

Read the raw result and tt records. Verify both contexts actually wrote working
state and measured real Git; no stderr, user-state writes or surviving children.
This one-case-per-context pilot checks the entire recipe through its result.
Remove only its owned fixture or use a fresh one for the full baseline.

- [ ] **Step 9: Record the unchanged-product baseline and commit.**

Run `just bench-hook before "$bench_fixture" 30 5 2` in a fresh fixture before
Task 2. It records two baseline batches per context and must finish in the
foreground/tracked command. Inspect completed results if it is refused or
aborted before retrying. Product source is unchanged in this task; record
revision/dirty status and hashes of `src/bus/identity.js`, `pins.js`, `resolve.js`
and `transaction.js` with the artifact. Save the same fixture for Task 4.

`tasks note` the boundary, versions, medians/p95, counts, baseline variation and
artifact path. Then `just check`, `tasks check`, `git diff --check`, close this
step and commit the benchmark, tests, helper, just recipe and step record:

```sh
git commit -m "test(identity): add hook latency benchmark and baseline"
```

---

### Task 2: Discover and propagate repository anchors safely

**Files:**

- Modify: `src/bus/identity.js`, `src/bus/transaction.js`,
  `src/bus/resolve.js`, `bin/familiar.js`, `src/install/codex.js`.
- Test/update valid context fixtures: `test/identity.test.js`,
  `test/resolve.test.js`, `test/transaction.test.js`, `test/bin-familiar.test.js`,
  `test/assets.test.js`, `test/cli-help.test.js`, `test/codex-converge.test.js`.
- Use: `test/fixtures/git-worktree.mjs` from Task 1.

**Interfaces:**

- `gitContext(cwd, { exec = defaultExec, timeoutMs = 2_000,
  now = () => performance.now() } = {})` returns
  `{ remote: string|null, repoRoot: string|null, repositoryRoot: string|null }`.
  `exec` retains Node execFile's promisified success/error shape. `now` is an
  injectable monotonic millisecond clock for deterministic budget tests.
- `projectKeyFor({ remote, repositoryRoot, cwd })` returns
  `remote ?? repositoryRoot ?? cwd`. Replace its `repoRoot` argument everywhere;
  do not add a forwarding overload. `displayProject({ repoRoot, cwd })` stays.
- `resolveIdentity({ projectKey, project, remote, repoRoot, repositoryRoot,
  catalog, pack })` accepts/receives the anchor; inheritance matching is Task 3.
- `resolveIdentities({ agents, catalog, pack })` checks each record's own
  `repositoryRoot` property inside its existing try/catch before resolving it.
- Every newly written visual AgentRecord carries an own `repositoryRoot`
  property; `resolveIdentities` passes it to the single resolver.

- [ ] **Step 1: Add failing discovery and state-transition checks.**

In `test/identity.test.js`, use an injected exec for command/budget assertions:

```js
test('main context batches paths and retains two Git spawns', async () => {
  const calls = [];
  let clock = 0;
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    clock += 7;
    if (args.includes('--git-common-dir')) {
      return { stdout: '/fixture/api\n/fixture/api/.git\n/fixture/api/.git\n' };
    }
    if (args.includes('remote.origin.url')) {
      return { stdout: 'git@github.com:example/api.git\n' };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  assert.deepEqual(await gitContext('/fixture/api', { exec, now: () => clock }), {
    remote: 'github.com/example/api', repoRoot: '/fixture/api',
    repositoryRoot: '/fixture/api',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.options.timeout), [2_000, 1_993]);
  assert.ok(calls.every((c) => c.options.killSignal === 'SIGKILL'));
});
```

Add linked context with first stdout
`/fixture/fix-api\n/fixture/api/.git/worktrees/fix-api\n/fixture/api/.git\n`,
probe stdout `false\n/fixture/api\n`, then origin. Assert three spawns and
that the probe is argv `['-C', '/fixture/api', 'rev-parse',
'--is-bare-repository', '--show-toplevel']`, never a worktree listing.

Make the bare failure shape an actual, portable suite fixture, not just a mock:

```js
test('real Git bare probe prints true before exit 128', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'familiar-bare-probe-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const main = seedRepo(join(temp, 'primary'));
  for (const name of ['bare.git', '.git']) {
    const bare = join(temp, name);
    git(temp, ['clone', '-q', '--bare', main, bare]);
    const candidate = name === '.git' ? temp : bare;
    const r = spawnSync('git', ['-C', candidate, 'rev-parse',
      '--is-bare-repository', '--show-toplevel'], { encoding: 'utf8',
      timeout: 5_000, killSignal: 'SIGKILL', env: fixtureGitEnv() });
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    assert.equal(r.status, 128);
    assert.equal(r.stdout, 'true\n');
  }
});
```

Add real `gitContext()` checks with these layouts, using detached trees from
the shared fixture: main, internal, external, symlinked checkout, nested
unrelated repository, bare-backed `bare.git` and `.git`, separated main,
separated linked with/without `core.worktree`, and paths containing embedded
LF, ending LF, CR and trailing spaces. Check exact physical roots/labels and
remote-less keys. Execute those native queries through an exec wrapper that
only supplies `env: fixtureGitEnv()` to real promisified execFile; do not mock
Git output. For the separated declaration use fixture Git config; never change
host configuration. Add `extensions.worktreeConfig=true` on a fixture repo,
set its main origin to `git@github.com:example/main.git` and its tree-specific
origin with `git(tree, ['config', '--worktree', 'remote.origin.url',
'https://github.com/example/override.git'])`. Assert the effective origins
and keys differ while their repository anchor stays shared. Keep the undeclared `store/.git`
limitation test as a documented Git interpretation, not an expectation that
the engine can always diagnose it.

Timeout/error matrix in this same file:

| Location | Injected result | Required assertion |
| --- | --- | --- |
| Initial batch | ENOENT / ordinary non-worktree exit | Three null context fields; one spawn. |
| Batch result | Three lines with relative/empty field | Reject metadata, not null context. |
| Batch framing | More/fewer than three successful lines | Exactly three separate option queries; paths unchanged. |
| Separate queries | Invalid/failed result | Reject; no guessed fields. |
| Linked probe | `false\n` with exit 128 | Diagnostic naming `core.worktree`. |
| Linked probe | `true\n`, exit 128, no signal/killed flag | Bare anchor equals commonDir. |
| Linked probe | Partial `true\n` plus SIGKILL/killed or non-128 code | Reject; never bare success. |
| Every query | Timeout at that stage | Reject with no remote-less re-keying. |
| Budget before next query | Clock already >= deadline | Reject without spawning another command. |

Implement each row as an exec stub exercising the real `gitContext`, with
`assert.rejects` or deepEqual, and inspect its collected argv/options. A moved
sibling fixture must not change results. Add an exec assertion that no command
ever has `worktree list`; do not mount or wedge a real filesystem for a test.

For the new record fault trigger, extend the existing PACK/record fixtures in
`test/resolve.test.js`:

```js
test('an old record faults while own null and healthy anchors resolve', () => {
  const old = record();
  delete old.repositoryRoot;
  const inherited = Object.assign(Object.create({ repositoryRoot: '/fixture/api' }), old);
  const agents = {
    old, inherited,
    outside: record({ sessionId: 'outside', repositoryRoot: null }),
    current: record({ sessionId: 'current', repositoryRoot: '/fixture/api' }),
  };
  const r = resolveIdentities({ agents, catalog: NO_PINS, pack: PACK });
  assert.deepEqual([...r.faults.keys()], ['old', 'inherited']);
  assert.match(r.faults.get('old'), /lacks repositoryRoot/);
  assert.deepEqual([...r.identities.keys()], ['outside', 'current']);
});
```

Add a transaction check that seeds one old persisted record without the field,
admits a healthy incoming record, and observes one eviction plus equal agent/
intent key sets. Its next hook must re-admit that session with the new anchor;
no migration resolver, hook restart or unrelated session restart.

- [ ] **Step 2: Run `just test-fast` and inspect the expected RED failures.**

The existing gitContext does not emit the anchor or batch paths and the old
record currently resolves; those are the expected failures. Do not count a
fixture Git command failure or an absent dependency as proving the behavior.

- [ ] **Step 3: Implement discovery with the agreed command contract.**

Keep `normalizeRemote`, `autoSlot` and the existing exec dependency. Use one
monotonic deadline and small local functions rather than a new service/module:

```js
const deadline = now() + timeoutMs;
const run = async (at, args) => {
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0) {
    throw Object.assign(new Error(`git timed out after ${timeoutMs}ms in ${cwd}`), {
      code: 'FAMILIAR_GIT_TIMEOUT',
    });
  }
  return exec('git', ['-C', at, ...args], {
    timeout: remaining, killSignal: 'SIGKILL',
  });
};
const withoutFinalLF = (text) => {
  const s = String(text);
  if (!s.endsWith('\n')) throw new Error('git returned malformed path output');
  return s.slice(0, -1);
};
const absolutePath = (value) => {
  if (value === '' || !isAbsolute(value)) throw new Error('git returned a non-absolute path');
  return value;
};
```

Catch only the initial invocation's ordinary no-worktree/absent-Git result as
null context, preserving the existing non-timeout policy; parse its successful
output outside that catch so malformed metadata never becomes "not a repo".
Timeout detection includes `error.code === 'FAMILIAR_GIT_TIMEOUT'` as well as
the existing killed/SIGKILL checks, so deadline exhaustion inside the first
invocation's try cannot become null context. Floor the remaining milliseconds;
never enlarge the shared deadline. The budget test uses an integer injected
clock, so its expected options stay deterministic.

Batch argv is exactly:

```js
['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']
```

When framing is not three lines, query the three options separately via the
same `run` and `withoutFinalLF`, validate their absolute values and retain
exact path characters. Equal Git/common directories choose current repoRoot.
Otherwise derive the candidate from commonDir's `.git` final component and
execute the agreed two-option bare/root probe. Parse successful `false\n`
as a fixed boolean prefix followed by the entire single root output, not a
line count that would reject a root containing LF. Recognize bare success
only for numeric code 128, exact `error.stdout === 'true\n'` and no
timeout/killed/signal/spawn error. Other probe failures throw the explicit
declaration diagnostic. Read effective origin using the same remaining budget. Exit 1 (missing origin)
and unsupported remote spelling mean null; other post-discovery command
failures, including signals/timeouts/deadline exhaustion, propagate.

- [ ] **Step 4: Carry the context through every existing consumer atomically.**

The key function becomes:

```js
export function projectKeyFor({ remote, repositoryRoot, cwd }) {
  return remote ?? repositoryRoot ?? cwd;
}
```

At each of `bin/familiar.js`'s `identityResolver()`,
`src/bus/transaction.js`'s incoming event context, and
`src/install/codex.js`'s standalone planner, destructure all three context
fields. Pass repositoryRoot into `projectKeyFor` and `resolveIdentity`, and
into the CLI's explicit `matchPin` call (matching uses it in Task 3). Keep
`displayProject` on the current repoRoot. Put repositoryRoot in every newly
constructed transaction record. Keep install/convergence targets at repoRoot.

Within `resolveIdentities`'s per-record try, before the resolve call:

```js
if (!Object.hasOwn(record, 'repositoryRoot')) {
  throw new Error('session record lacks repositoryRoot; wait for its next hook');
}
```

Then forward `record.repositoryRoot`. Do not infer it from a missing field.
Update tests' valid context/AgentRecord factories and injected Git stubs to
provide the new field explicitly. Deliberately old-record fixtures continue
to omit it. Also update frozen deepEqual expected records and every
`projectKeyFor` test/call to the new input; do not preserve an old signature.

Search all production and test callers again before committing:

```sh
rg -n 'gitContext|projectKeyFor|resolveIdentity|resolveIdentities|repositoryRoot' src bin test
```

- [ ] **Step 5: GREEN suite, task checks and commit.**

Run `just test-fast`, including the real-Git bare-result test and transaction
fault/recovery. Confirm benchmark smoke still proves successful hooks and
instrumentation under the new context shape. Then `just check`, `tasks check`,
`git diff --check`, close this step and commit by explicit changed paths:

```sh
git commit -m "feat(identity): discover and propagate Git repository anchors"
```

---

### Task 3: Apply inherited pin precedence

**Files:**

- Modify: `src/bus/pins.js`, `src/bus/resolve.js`.
- Test: `test/pins.test.js`, `test/resolve.test.js`, `test/transaction.test.js`.

**Interfaces:**

- `matchPin(catalog, { remote, repoRoot, repositoryRoot, project },
  { realpath = defaultRealpath } = {})` returns a complete matching pin or null.
- `resolveIdentity` from Task 2 passes repositoryRoot into that matcher and
  continues selecting one pin's slot and theme-scoped member.
- No new record field, config format, name normalization or member overlay.

- [ ] **Step 1: Add a concrete precedence regression and expand it to each tier.**

In `test/pins.test.js`:

```js
test('worktree path wins within path tier and remote still wins overall', () => {
  const main = '/fixture/api';
  const tree = '/fixture/fix-api';
  const context = { remote: 'github.com/example/api',
    repoRoot: tree, repositoryRoot: main, project: 'fix-api' };
  const pins = [
    { project: 'api', slot: 0 },
    { project: 'fix-api', slot: 1 },
    { path: main, slot: 7 },
    { path: tree, slot: 3 },
    { remote: 'github.com/example/api', slot: 6 },
  ];
  const realpath = (p) => p;
  const slot = (catalog) => matchPin({ identities: catalog }, context, { realpath }).slot;
  assert.equal(slot(pins), 6);
  assert.equal(slot(pins.slice(0, 4)), 3);
  assert.equal(slot(pins.slice(0, 3)), 7);
  assert.equal(slot(pins.slice(0, 2)), 1);
  assert.equal(slot(pins.slice(0, 1)), 0);
});
```

Add these explicit cases to the same test file:

- Two inherited path entries with different slots: first wins; reversing their
  order changes the winning pin. Two current-name duplicates behave the same.
- An entry `{ remote, path: main, project: 'api', slot: 6,
  members: { cats: 'schrodingers-cat' } }` wins remotely, or through the
  inherited path with no remote. Assert `matchPin(...) === thatEntry` so
  combined selectors and the entire members map are preserved.
- Null roots outside a repository match only effective remote/current name.
- Canonicalized main path and current path reached through symlinks match;
  inherited/current roots equal do not require a second path/name pass.
- `repositoryRoot: '/fixture/.git'` contributes no inherited `.git` name pin.
  `repositoryRoot: '/fixture/familiar.git'` matches `project: familiar.git`
  and does not match `project: familiar`; current project name is a different
  worktree name so it cannot hide the inherited behavior.
- Unknown/no pin returns null and uses the shared projectKey's hash.

In `test/resolve.test.js`, reuse PACK's alternate slot-6 members:

```js
const catalog = { identities: [{ path: '/fixture/api', slot: 6,
  members: { cats: 'maine-coon', inactive: 'not-in-this-pack' } }] };
const result = resolveIdentity({ projectKey: '/fixture/api', project: 'fix-api',
  remote: null, repoRoot: '/fixture/fix-api', repositoryRoot: '/fixture/api',
  catalog, pack: PACK });
assert.equal(result.slot, 6);
assert.equal(result.member, 'maine-coon');
```

Use node:test around that assertion. Also assert that an active unknown
member and an incompatible active member/slot still throw; an inactive
theme override remains inert. A current worktree path pin must choose its
own complete member map, without borrowing the inherited pin's member.

- [ ] **Step 2: Run `just test-fast`; observe inherited-tier RED failures.**

The remote/current-path cases already work; the missing main-path/main-name
tiers and `.git` omission are the new assertions that must fail before editing.

- [ ] **Step 3: Extend the existing matcher, without a new abstraction.**

Import `basename` beside `resolve`. Keep the existing canonical path function.
Calculate the canonical current root and inherited root; when equal, avoid a
duplicate tier. Keep the inherited basename verbatim except `.git` omission:

```js
const root = repoRoot ? canonical(repoRoot, realpath) : null;
const repository = repositoryRoot ? canonical(repositoryRoot, realpath) : null;
const name = repositoryRoot ? basename(repositoryRoot) : null;
const inheritedName = name === '.git' || name === project ? null : name;
return (
  (remote ? pins.find((p) => p.remote && p.remote.toLowerCase() === remote.toLowerCase()) : null)
  ?? (root ? pins.find((p) => p.path && canonical(p.path, realpath) === root) : null)
  ?? (repository && repository !== root
    ? pins.find((p) => p.path && canonical(p.path, realpath) === repository) : null)
  ?? (project ? pins.find((p) => p.project && p.project === project) : null)
  ?? (inheritedName ? pins.find((p) => p.project === inheritedName) : null)
  ?? null
);
```

Pass repositoryRoot from `resolveIdentity`. Do not merge catalogs, reorder
entries, alter the remote normalizer, strip a name suffix or duplicate member
validation. The CLI's already updated explicit matchPin call now reports the
same pin source as the shared identity resolver.

- [ ] **Step 4: Prove transaction-level inheritance.**

Extend the existing transaction harness with
`gitContext: async () => ({ remote: null, repoRoot: '/fixture/fix-api',
repositoryRoot: '/fixture/api' })` and a main-path pin to slot 7. Assert the
stored record's key/anchor, intent slot/member and current project label.
Add a second current-path pin to slot 3 and assert its result wins. A matching
remote pin must still dominate both paths. Existing fault isolation and
re-admission tests from Task 2 must stay green.

- [ ] **Step 5: GREEN suite, task checks and commit.**

Run `just test-fast`, `just check`, `tasks check`, `git diff --check`, close
this step and commit matcher/resolver/tests and the step record:

```sh
git commit -m "feat(identity): inherit repository pins in Git worktrees"
```

---

### Task 4: Verify shared surfaces and accept hook latency

**Files:**

- Test: `test/bin-familiar.test.js`, `test/install-codex-single.test.js`,
  `test/codex-converge.test.js`, `test/bench-hook.test.js`.
- Modify: `docs/install.md`, `docs/surfaces.md`, and a historical addendum to
  `docs/specs/2026-09-05-codex-identity-parity-design.md` section 6.2.
- Evidence/update: current spec, brief and execution task records. No new
  production abstraction; any integration correction edits its owning existing
  identity/installer function and leaves a reproducing check.

**Interfaces:**

- `planCodexProjectForPath({ path, pinned, catalog, pack, member })`,
  `planCodexProjectSync({ catalog, pack, cwd })` and `applyCodexProjectSync(plan)`
  keep their existing interfaces and actual repoRoot targets.
- `convergeCodexProject({ repoRoot, member, catalog, pack, themeId, petsDir })`
  continues accepting the already resolved member. Do not add a separate
  inherited-member calculation to it.
- Task 1's `before.json` and raw batches are immutable baseline inputs;
  `after.json` reports the same fixture/boundary with Task 2–3 product code.

- [ ] **Step 1: Write the real-worktree installer and CLI parity checks.**

Use the shared real-Git fixture and existing theme-slots fixture (slot 7 is
beta, slot 3 is alpha). In `test/install-codex-single.test.js`, import the
existing apply function and check both categories of writes:

```js
test('worktree config is local and Git exclusions are shared and idempotent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-worktree-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = seedRepo(join(dir, 'api'));
  const tree = addWorktree(main, join(dir, 'fix-api'));
  const catalog = { identities: [{ path: main, slot: 7 }] };
  const plan = await planCodexProjectForPath({ path: tree, pinned: false,
    catalog, pack: THEME });
  assert.equal(plan.member, 'beta');
  assert.equal(plan.target, join(tree, '.codex/config.toml'));
  applyCodexProjectSync({ configs: [plan.config], excludes: [plan.exclude] });
  assert.equal(existsSync(join(main, '.codex/config.toml')), false);
  assert.match(readFileSync(plan.target, 'utf8'), /custom:familiar-beta/);
  const mainExclude = resolve(main, git(main, ['rev-parse', '--git-path', 'info/exclude']));
  const treeExclude = resolve(tree, git(tree, ['rev-parse', '--git-path', 'info/exclude']));
  assert.equal(mainExclude, treeExclude);
  const again = await planCodexProjectForPath({ path: tree, pinned: false,
    catalog, pack: THEME });
  applyCodexProjectSync({ configs: [again.config], excludes: [again.exclude] });
  assert.equal(readFileSync(mainExclude, 'utf8').split('\n')
    .filter((line) => line === '.codex/config.toml').length, 1);
});
```

Add a current-worktree path pin and confirm the planned member changes to
alpha without changing the main config. Test the bulk planner's existing
explicit main-path pin plus current worktree targets: exactly those two
targets, no sibling discovery. Keep tracked/unmanaged/symlink refusal and
installed-pet convergence guards covered by their existing checks; add a
worktree convergence case supplying beta to verify no second pin resolver
changes the supplied member.

In `test/bin-familiar.test.js`, use its isolated `env()`/theme fixtures for
real `whoami --json` and `projects --json` commands against main/internal/
external/symlinked roots. Assert inherited slot/member agreement and current
labels. Test no-remote automatic parity, path/name overrides and remote
dominance. Query with explicit repository paths; default projects still
enumerates only catalog path pins and gains no registry/worktree discovery.
The benchmark's actual hook agent/intent proves the same identity for a
path pin written into its fixture catalog; compare that with CLI/planner
results. Restore the benchmark's original empty catalog before timing.

- [ ] **Step 2: RED→GREEN any integration correction, then run the fast suite.**

Run `just test-fast`. If these integration checks already pass because earlier
tasks implemented the behavior, record that this is validation of existing
work, not a claimed new RED→GREEN fix. If they expose a defect, retain the
failing regression, fix the shared owning function, then run the same front
door to GREEN. Never weaken a correct assertion to preserve a bad target.

- [ ] **Step 3: Pilot after measurement, then record the full comparison.**

Use a separate disposable pilot fixture and one successful hook per context
to verify the after recipe/result checks; do not overwrite the saved baseline.
Run a pilot `before` followed by pilot `after` at identical 1/0/1 budgets in
that disposable fixture. Its verdict is `pilot-only`, not latency acceptance.
Then, on the saved Task 1 fixture with its unchanged theme/config:

```sh
just bench-hook after "$bench_fixture" 30 5 2
```

Read raw before/after batches, not only a command exit. Each sampled hook
must prove working agents/intent and zero diagnostics; every normal main
sample must have two real Git calls and linked samples three. A bare-backed
suite fixture already proves three-call bare discovery; do not confuse the
separate probe's expected native exit 128 with a failed CLI hook.

For each context, compare before batch medians with after median/p95 and
report absolute/percentage deltas. Baseline variation is max minus min of
baseline batch medians; reference the largest baseline batch median. Main
acceptance allows that reference plus observed variation. Linked acceptance
also allows the after median duration of its one additional bare/root probe.
Report p95 changes and investigate unexplained tail growth, even if medians
are within those bounds. A larger unexplained change or wrong spawn count
is `needs-investigation`; record evidence, fix/rerun affected work or explicitly
resolve it before final acceptance. Do not ask for an idle desktop unless a
measured preflight refusal actually requires it.

Attach baseline/after reports and their source hashes to the execution goal
using `tasks attach` before cleaning the owned fixture. Keep original raw
artifacts available until attachments/checks confirm preservation; redact any
unrelated host content rather than committing it. Record the exact measurement
boundary and limitations (fixture process selection, non-TTY presentation,
Linux host, no live-agent or Darwin latency claim).

- [ ] **Step 4: Document the changed contract and preserve history.**

Add these concrete points to install/surface docs:

- Main pins inherit through the Git relationship, including externally stored
  trees; current path/name overrides use the approved tier ordering.
- A matching remote pin already covers all worktrees and dominates path pins.
- Labels identify current checkout; remote-less keys use the repository anchor.
- Bare `.git` does not supply an inherited name; `familiar.git` stays verbatim.
- Separated linked metadata requires `core.worktree`; the identifiable invalid
  layout now reports an error on every discovery hook until corrected, while
  removal skips discovery. State the undeclared `store/.git` ambiguity.
- The new own-property guard faults old transient bus records; each session's
  next hook re-admits it. Authored pins are untouched.
- Managed Codex pet configs remain per checkout, but `.codex/config.toml`'s
  exclusion is shared repository-wide and idempotent.
- Describe the benchmark recipe, its fixture/results, Linux boundary, persistent
  tests and before/after method. It is a lasting developer tool, not a one-off
  command that vanishes after measuring this branch.

Append an implementation/date cross-reference to historical Codex parity
section 6.2; retain its original observed counterexample and retired ancestry
suggestion as history, clearly superseded by the new contract. Update the
current spec from approved-design to implemented only after the checks actually
prove it; link measured results from the brief/task.

- [ ] **Step 5: Final review, corrective rounds, commit and local integration.**

Merge any changed local main into this worktree before the final checks and
review, resolving only this task's conflicts; repeat affected latency checks
if runtime code changed. Run `just test-fast`, `just check`, `tasks check`,
`git diff --check`. Request a fresh whole-branch review against the approved spec/plan and code from
`842c20d` through the implementation head plus `git diff HEAD` and untracked Task 4
files, since its final changes are not committed yet. Include the benchmark/tests
and latency artifacts; have the reviewer consider current code, not merely the
task's verdict. Note the review before acting.

Fix/rule on Critical and Important findings in the user's permitted corrective
rounds (up to five), each with a reproducing RED→GREEN check and green suite,
then a fresh scoped re-review. Record every Ruling and any `minor (deferred)`
finding. Surface remaining findings and exclusions in the final report.

With validation and review settled, close this step and the execution goal in
the code/docs/evidence commit, then locally merge the reviewed branch in this
personal checkout. Do not push or publish without authorization. If main has
changed, merge its latest local changes and revalidate affected work before
integration; do not overwrite another session's edits. Remove only this own
worktree after ignored-file, ledger, host-pointer, submodule and tt-report
checks from AGENTS.md. Leave saved evidence reachable from the main checkout.

```sh
git commit -m "test(identity): verify worktree surfaces and hook latency"
```

## Plan review status

This is the written plan for user review. No product code has been changed and
no benchmark baseline has been measured yet. Step tasks remain blocked on
`fam-9ab24c` until its plan review is accepted.
