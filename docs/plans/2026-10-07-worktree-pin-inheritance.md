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
`fam-169e3f`. Plan accepted by the user after the final minor corrections and
executed inline on 2026-10-08.

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
| 1 — Benchmark tool and pilot | `fam-4f90f3` | Design/plan review completion (`fam-9ab24c`) |
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

### Task 1: Add a tested paired hook benchmark and run a pilot

**Files:**

- Modify: `justfile` (one lasting recipe), `.github/workflows/test.yml`
  (install just in the Ubuntu test job).
- Create: `tools/bench-hook.mjs` (controller, worker, paired reports).
- Create: `test/fixtures/bench-hook-cli.mjs` (CLI wrapper following
  `test/fixtures/tty-familiar.mjs`, with measured-checkout process/Git instrumentation).
- Create: `test/fixtures/git-worktree.mjs` (shared real-Git fixture helper).
- Create: `test/bench-hook.test.js` (statistics, validation, recipe and CI prerequisites).

**Interfaces:**

- `git(root, args)`, `seedRepo(root, { gitDir = null } = {})`,
  `addWorktree(main, target)` and `fixtureGitEnv(over = {})` provide real-Git
  fixtures. Commands use argv, a five-second timeout, SIGKILL and command-local
  `core.hooksPath=/dev/null`. Preserve paths by removing only the final LF.
  The environment helper removes inherited `GIT_*` bindings and sets
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`; it never mutates the
  caller's environment or production Git semantics.
- `just bench-hook MODE BASELINE CANDIDATE FIXTURE SAMPLES WARMUPS PAIRS`,
  defaults 30/5/4. MODE is `pilot` or `compare`. Both checkout paths are explicit;
  resolve their actual `bin/familiar`, verify dependencies, record revisions,
  source hashes and package-lock hashes. `pilot` permits identical checkouts;
  `compare` requires distinct source revisions and identical measurement settings.
- The same benchmark driver and wrapper measure both versions. The worker
  chooses source by the measured bin path, not the benchmark's own checkout.
- `batchOrder(i)` returns `['baseline', 'candidate']` for even pairs and the
  reverse for odd pairs. Each context gets both source batches adjacent in
  time within the same controller invocation. Default four pairs balances order.
- `summarize(samples)` returns median/p95 milliseconds; reject empty/nonfinite
  input. `pairedComparison(pairs, context)` returns source summaries, each
  adjacent pair's median difference, median/p95 of those differences, order
  breakdown and measured candidate probe cost. It does not infer a timing pass
  from an old baseline or a max-minus-min threshold.
- `proveHook(result, agents, intents, id, workerPid, checkout)` rejects spawn/
  exit/signal failures, stdout/stderr, absent working records, wrong PID or
  wrong project checkout. A cosmetic exit zero is insufficient.

The report is schema 1: mode, run id, start/end times, measurement settings,
source paths/revisions/hashes/versions, boundary, paired raw batches, structural
count checks and paired summaries. Timing status is `pilot-only` or
`review-required`; it is never an automatic statistical acceptance claim.
A comparison run enforces baseline counts 2/main and 2/linked, candidate counts
2/main and 3/linked. Pilot validates actual hooks without imposing counts for
an unimplemented version. Append completed samples incrementally so interrupted
runs retain evidence. Start a fresh fixture/run, not a resumed comparison hours
or days later. No fixture is retained as a days-old baseline input.

- [ ] **Step 1: Write failing tests for comparison, recipe and sample proof.**

Use the regular node:test suite. Pure statistics/proof tests stay portable;
only the real CLI recipe smoke is Linux-only because its no-TTY boundary uses
`/proc`. Do not import global wrapper patches into the suite process.

```js
import { summarize, batchOrder, pairedComparison, proveHook } from '../tools/bench-hook.mjs';
const REPO = fileURLToPath(new URL('..', import.meta.url));

test('paired ordering counterbalances the two measured sources', () => {
  assert.deepEqual(batchOrder(0), ['baseline', 'candidate']);
  assert.deepEqual(batchOrder(1), ['candidate', 'baseline']);
  assert.deepEqual(summarize([4, 1, 3, 2]), { medianMs: 2.5, p95Ms: 4 });
  assert.throws(() => summarize([]), /samples/);
});

test('pair differences do not mistake between-pair drift for the version delta', () => {
  const pairs = [10, 20, 30, 40].map((base, index) => ({
    index, order: batchOrder(index), contexts: { main: {
      baseline: { samples: [{ hookMs: base }, { hookMs: base }] },
      candidate: { samples: [{ hookMs: base + 2 }, { hookMs: base + 2 }] },
    } },
  }));
  const r = pairedComparison(pairs, 'main');
  assert.deepEqual(r.pairedDeltasMs, [2, 2, 2, 2]);
  assert.equal(r.deltaMedianMs, 2);
  assert.equal(r.timingStatus, 'review-required');
});

test('an exit-zero diagnostic cannot be a successful sample', () => {
  const id = 'bench-main';
  const agents = { [id]: { pid: 42, repoRoot: '/fixture/api', state: 'working' } };
  const intents = { [id]: { current: { state: 'working' } } };
  assert.throws(() => proveHook({ status: 0, stdout: '', stderr: 'familiar: failed\n' },
    agents, intents, id, 42, '/fixture/api'), /cleanly|diagnostic/);
});

test('the real just recipe forwards paths and records paired hooks', {
  skip: process.platform !== 'linux' && 'CLI fixture uses Linux /proc',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-paired-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, "pilot's fixture with spaces");
  const log = join(root, 'runs.jsonl');
  const r = spawnSync('just', ['bench-hook', 'pilot', REPO, REPO,
    fixture, '1', '0', '1'], { cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TT_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(join(fixture, 'report.json'), 'utf8'));
  assert.equal(report.mode, 'pilot');
  for (const context of ['main', 'linked']) {
    for (const version of ['baseline', 'candidate']) {
      const sample = report.pairs[0].contexts[context][version].samples[0];
      assert.ok(Number.isFinite(sample.hookMs) && sample.hookMs > 0);
      assert.equal(sample.provedState, 'working');
      assert.ok(sample.git.length >= 2);
    }
  }
  const rows = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  for (const context of ['main', 'linked']) {
    for (const version of ['baseline', 'candidate']) {
      assert.ok(rows.some((r) => r.target === `bench-hook-${context}-${version}` && r.exit === 0));
    }
  }
});
```

Add malformed mode/settings/source-path tests, artifact-overwrite refusal,
nonfinite samples, cleanup after signal/error, and source-selection regression:
run the wrapper against a small second temporary checkout whose proc module
exports a distinct sentinel, then assert it patches/imports that checkout's
module and bin. That fixture needs no npm packages; its stand-in bin inspects
its own proc export and argv. This catches mistakenly importing the driver's
proc module without requiring two dependency installations in every test-fast.

- [ ] **Step 2: Run `just test-fast` and confirm the absent tool/recipe is RED.**

Dependency/fixture failures are not the expected assertion failure. Record the
setup baseline's tt time for comparison with the finished Task 1 fast suite.

- [ ] **Step 3: Implement fixture helpers, paired controller and worker.**

Reuse the existing theme-pack fixture; seed one main Git repo plus one linked
project under FIXTURE. Both measured versions receive the same project paths,
config/theme/payload. Give each source/context its own bus state so one schema
cannot pollute the other. Use a stable worker owner during each batch. Five
warm-ups are validated but excluded; all subsequent samples must prove success.
Keep HOME/XDG, CODEX_HOME and Familiar files inside FIXTURE for workers; clear
Git bindings, TMUX/NODE_OPTIONS and set TERM=dumb. Preserve the caller's HOME/
XDG/TT_LOG for the tt parent so timings reach the normal log. Use argv `env`
assignments for worker overrides, not interpolated shell source.

Implement the shared fixture helpers with their agreed signatures:

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

The controller executes both sources in one run:

```js
for (let index = 0; index < pairs; index++) {
  const order = batchOrder(index);
  for (const context of ['main', 'linked']) {
    for (const version of order) {
      await measureBatch({ index, context, version, measuredRoot: sources[version] });
    }
  }
}
```

`measureBatch` is a local controller function: spawn real `tools/tt` with
`bench-hook-${context}-${version}`, `cwd: measuredRoot`, then the current
benchmark's internal worker with measured bin/context/index/settings in argv.
Capture source revision/hash, batch start/end, order, load average snapshots,
raw timings and the child result. The tt code is the current driver's wrapper;
its cwd ensures its recorded revision is the source being measured.

Use normal, awaited subprocesses. No `detached: true`, process groups or
`active-groups.json`. Keep active handles/PIDs in memory. A worker emits its
ready PID before work starts and owns its asynchronous hook children; the CLI
wrapper owns real Git children. On TERM/INT or an error, forward cancellation
from controller to worker to wrapper, kill/reap owned children, then allow tt
and controller to finish. Do not return while any owned child runs; signal
handlers must complete cleanup before exit. Test this chain. No PID file is
needed or trusted for cleanup after a killed controller.

- [ ] **Step 4: Implement the CLI wrapper against the measured checkout.**

Follow the argv/import wrapper pattern already used by `tty-familiar.mjs`.
Resolve modules from the measured bin's canonical URL:

```js
const bin = realpathSync(process.argv[2]);
const args = process.argv.slice(3);
const { defaultProcessOps } = await import(new URL('../src/bus/proc.js', pathToFileURL(bin)));
const parent = defaultProcessOps.recordOf(process.ppid);
defaultProcessOps.ancestors = () => [
  defaultProcessOps.recordOf(process.pid), { ...parent, comm: 'claude', tty: true },
];
process.argv = [process.execPath, bin, ...args];
// Install real execFile instrumentation before this import.
await import(pathToFileURL(bin).href);
```

Do not use an --import preload. Do not import the driver's proc module: it
would be another module instance when measuring the detached baseline.
Instrument real execFile before CLI import, synchronize builtin ESM exports,
and preserve promisify.custom's stdout/stderr/error semantics. Track Git
children in memory for cancellation and record argv, duration and exit.
Known native failures (including bare true + exit 128) must remain unchanged.
The wrapper is test machinery only; production launchers/adapters stay untouched.

The worker invokes this current wrapper with the measured bin:

```js
const started = performance.now();
const result = await runOwnedChild(process.execPath, [wrapperPath, measuredBin,
  'hook', 'PreToolUse', '--agent', 'claude-code'], {
  cwd: projectRoot, env: sampleEnv,
  input: JSON.stringify({ session_id: id, cwd: projectRoot }),
});
const hookMs = performance.now() - started;
proveHook(result, readAgents(), readIntents(), id, process.pid, projectRoot);
```

`runOwnedChild` is a local worker function using asynchronous spawn with pipes,
a ten-second timeout and registered cleanup handles. Check process outcome/
diagnostics before opening state files, then prove working state/owner/root.
Wrapper Git metrics flush synchronously on clean exit; interrupted sample
results cannot become valid timing samples. Always pipe the worker's stdout;
real emission's isatty guard therefore prevents any live-terminal writes.

- [ ] **Step 5: Add the permanent recipe and its CI prerequisite.**

```just
bench-hook $mode $baseline $candidate $fixture $samples="30" $warmups="5" $pairs="4":
    node tools/bench-hook.mjs "$mode" "$baseline" "$candidate" "$fixture" "$samples" "$warmups" "$pairs"
```

Install just in the Ubuntu `test` job before its npm/test commands.
The `smoke` job does not run tests or this recipe and needs no just install. Keep the real recipe smoke; do not replace it with a direct node
call. The checked upstream v4 action is:

```yaml
- uses: extractions/setup-just@53165ef7e734c5c07cb06b3c8e7b647c5aa16db3 # v4
  with:
    just-version: '1.58.0'
```

The action/version input is documented in
[setup-just's README](https://github.com/extractions/setup-just#usage).
The v4 tag SHA was resolved while drafting this revision. Add a regular suite
check using the existing YAML dependency that the `test` job step array
contains this setup before its npm/test commands; do not require it in `smoke`. The macOS recipe smoke
remains explicitly skipped; the portable benchmark unit tests still run there.

- [ ] **Step 6: GREEN tests, pilot, immediate evidence attachment and commit.**

Run `just test-fast`, inspect its tt wall time/test count against the setup
baseline and record the added smoke's elapsed cost. Investigate a material
unexplained test-fast regression; retain the required recipe/path-forwarding
check and avoid broadening the pilot (one hook per source/context only).

Run one pilot with the current checkout in both source positions:

```sh
bench_fixture=$(mktemp -d)
just bench-hook pilot "$PWD" "$PWD" "$bench_fixture" 1 0 1
tasks attach fam-4f90f3 "$bench_fixture/report.json" --caption "Paired benchmark pilot; tool proof, not latency acceptance"
```

Read its raw batches and tt rows. Attach raw results and source hashes to this
step immediately, BEFORE cleanup/parking/commit; do not rely on a temporary
directory surviving a timer. Verify the attachment through tasks show/check,
then clean only its owned fixture. Task 4 creates a new paired measurement
fixture; it never uses this pilot as a performance baseline.

Run `just check`, `tasks check`, `git diff --check`, close this step and commit
its tool/wrapper/tests/CI/recipe/fixture/attachment/task changes. After committing,
record the exact Task 1 commit on the execution goal (execution-owned note,
no amendment merely to put a commit id inside its own commit):

```sh
git commit -m "test(identity): add paired hook benchmark and CI prerequisite"
task1_commit=$(git rev-parse HEAD)
tasks note fam-169e3f "baseline-code: $task1_commit — benchmark/tool commit; product identity unchanged"
```

That commit contains the benchmark but no product identity changes; Task 4
will create a hydrated detached checkout at it as the baseline code source.

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
- Task 1's commit is the baseline CODE revision, not its pilot timings.
  The current driver measures that checkout and the candidate in one paired
  sitting on a fresh fixture; Task 1's attached pilot is tool evidence only.

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

- [ ] **Step 3: Measure both source versions in one paired sitting.**

Use the exact Task 1 commit recorded on `fam-169e3f` as baseline code. From the
main checkout, follow the ordinary worktree rules for this auxiliary source:

```sh
work-link --ensure .worktrees
git worktree add --detach .worktrees/identity-benchmark-baseline "$task1_commit"
git worktree lock --reason "on WORK_ROOT storage (host: $(uname -n))" .worktrees/identity-benchmark-baseline
```

From the main checkout, hydrate it with
`npm --prefix .worktrees/identity-benchmark-baseline install` (no setup recipe),
then verify source/package-lock hashes and dependency availability. Do not share/repoint node_modules or a
launcher, and do not run task writes in the detached source. Task 4's claim
stays in `.worktrees/worktree-identity`. Record auxiliary path/revision/setup
on Task 4. Explicit measured bin paths avoid changing live host pointers.

The latest benchmark driver/wrapper must patch proc.js relative to EACH
measured bin, not relative to its own worktree. The source-selection regression
from Task 1 exercises this distinction. The same Node/Git versions, fixture
project paths, theme/config, payloads and measurement boundary apply to both
sources. Keep source/context bus state separate.

Run a disposable one-pair pilot against the two checkouts and attach it. Then
create a NEW full-run fixture and execute the whole comparison in one tracked
foreground invocation; from the main checkout:

```sh
bench_fixture=$(mktemp -d)
cd .worktrees/worktree-identity
just bench-hook compare ../identity-benchmark-baseline "$PWD" "$bench_fixture" 30 5 4
```

The controller resolves both source paths and runs adjacent baseline/candidate
batches for main and linked contexts, reversing their order on alternate pairs.
Read the complete ordering and raw samples. Do not combine Task 1's pilot or
old sittings with this run. If interrupted, attach/analyze completed data and
start a fresh complete sitting after resolving the cause; a partial/resumed
run does not support latency acceptance.

Each sample must prove successful working agents/intent and no diagnostics.
Count baseline 2/main and 2/linked versus candidate 2/main and 3/linked. The
portable bare suite regression independently pins Git's true/exit-128 contract.
Report source median/p95, per-pair median differences, balanced-order breakdown,
absolute/percentage deltas, probe duration, elapsed/run/load context and source
hashes. Temporal pairing reduces load drift; it does not prove a statistical
confidence bound or attribute every host disturbance to the code.

There is NO largest-baseline-plus-two-batch-spread threshold and no automatic
timing pass. Tool structural checks are pass/fail; timing status stays
review-required. The executor records an evidence-backed disposition on Task 4:
look for consistent unexplained main slowdown and linked overhead beyond the
measured extra probe, inspect order-dependent results and p95 tails, and
investigate/repeat in a fresh same-sitting run when disturbance or contradictory
pairs makes the comparison inconclusive. A benign-looking aggregate alone is
not acceptance. Preserve successful correctness checks while investigating.
Do not ask for an idle desktop without an observed load/preflight reason.

Attach the COMPLETE raw paired report immediately to Task 4 and record the
latency disposition/rationale; verify the attachment before removing its
fixture. Task 1's pilot is already durable and is not this baseline. State the
boundary: current wrapper, measured CLI code/dependencies, real Git, fixture
process lookup, private-pipe presentation, Linux host; no live-agent/Darwin
latency claim.

Remove only the auxiliary baseline checkout after the normal ignored-file,
host-pointer, submodule and tt-report checks, unlocking it before removal.
Its ignored npm inputs are disposable; preserve any unexpected data first.
Do not remove the main implementation worktree until its final integration.

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
  tests and paired same-sitting method. It is a lasting developer tool, not a one-off
  command that vanishes after measuring this branch.

Append an implementation/date cross-reference to historical Codex parity
section 6.2; retain its original observed counterexample and retired ancestry
suggestion as history, clearly superseded by the new contract. Update the
current spec from approved-design to implemented only after the checks actually
prove it; link measured results from the brief/task.
Explicitly update the current spec's **Latency acceptance** section to this
plan's paired same-sitting protocol: hydrated baseline code, measured-checkout
wrapper, adjacent counterbalanced batches, fresh fixture, paired reports and
evidence-backed disposition. Remove the old separated-run/baseline-variation
wording so the implemented spec agrees with its approved plan.

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

The user accepted this plan after the final two minor corrections and resumed
execution on 2026-10-08; all four tasks ran inline. Deviations are recorded as
rulings in the execution report; the latency disposition is on `fam-f3d48e`.
