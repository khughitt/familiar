# macOS Process Runtime and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-snapshot Darwin process identity, portable lock/test-runner behavior, validated terminal emission, evidence-backed agent resolution, and permanent macOS CI.

**Architecture:** `src/bus/proc.js` remains the single process-operations boundary and returns one normalized record on both platforms. A lazy Darwin snapshot backs ancestry, start time, pruning, and terminal lookup; contended lock reclaim and post-spawn test-worker identification share a fresh targeted identity read. The emitter receives an explicit `{ path, env }` binding so Darwin's hook environment and agent TTY cannot be conflated.

**Tech Stack:** Node 22 ESM, Linux `/proc`, Darwin `/bin/ps` with `LC_ALL=C`, `node:test`, GitHub Actions.

**Spec:** `docs/specs/2026-08-22-macos-support-design.md` §§2–4, 6, 9–11, 14.

## Global Constraints

- Task 1 requires a physical Mac and gates all resolver-name implementation.
- Do not infer Darwin agent names from package launchers, unauthenticated startup, or Linux evidence.
- The normal Darwin hook path spawns one full `ps`. Lock contention may add one targeted read per observed token; the test runner adds one for its newly spawned worker.
- Linux `tty` is a presence marker only. Darwin accepts `??`, `ttys<hex>`, and `s<hex>` only.
- Darwin `lstart` identity has one-second granularity.
- No daemon, native helper, `/proc` fallback, environment dependency, or silent resolver miss.
- Keep hook/statusline failures cosmetic: one sanitized diagnostic and exit zero.
- Use conventional commits without attribution trailers.

---

### Task 1: Capture and commit physical-Mac resolver evidence

**Files:**
- Create: `docs/ref/2026-08-22-macos-agent-process-spike.md`
- Temporarily modify, then restore: `bin/familiar`

**Interfaces:**
- Produces: exact terminal-owning ancestor basenames, raw `pid,ppid,tty,lstart,comm,command` evidence, and the observed hook-command execution boundary for Claude Code, Codex, and OpenCode.
- Gate: if any resolver needs more than exact basename plus non-null TTY, amend and reapprove the design before Task 2.
- Gate: do not implement Codex setup command encoding until this capture proves whether a shell interprets its single-string hook command.

- [ ] **Step 1: Add temporary hook instrumentation on the physical Mac**

Immediately inside the `hook` branch in `bin/familiar`, insert without committing:

```js
if (process.env.FAMILIAR_MACOS_SPIKE) {
  const out = join(process.env.TMPDIR ?? '/tmp', 'familiar-macos-process-spike.log');
  const capture = (field) => execFileSync('/bin/ps', [
    '-axo', `pid=,ppid=,tty=,lstart=,${field}=`,
  ], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  appendFileSync(out,
    `\nagent=${process.env.FAMILIAR_MACOS_SPIKE} hook_pid=${process.pid}\n` +
    `--- comm ---\n${capture('comm')}--- command ---\n${capture('command')}`);
}
```

- [ ] **Step 2: Trigger one authenticated hook per agent**

Temporarily change the configured Claude Code and Codex hook command strings to:

```text
FAMILIAR_MACOS_SPIKE=claude-code <generated command>; :
FAMILIAR_MACOS_SPIKE=codex <generated command>; :
```

The trailing shell no-op keeps a shell executor alive as Familiar runs, making
it visible in the ancestor chain. If the Codex hook does not run, record the
failure and stop its setup work; do not infer quoting from the JSON field shape.

Launch OpenCode with:

```sh
FAMILIAR_MACOS_SPIKE=opencode opencode
```

Trigger a real tool event in each session and record agent/terminal versions.

- [ ] **Step 3: Walk and evaluate each chain**

Starting at each recorded `hook_pid`, follow PPIDs to PID 1 in both tables. Record the first post-hook ancestor with TTY other than `??`. The currently approved rule proceeds only if the measured basenames are exactly:

```text
claude-code -> claude
codex       -> codex
opencode    -> opencode
```

If any differs or a same-named daemon precedes the terminal owner, stop and revise the design with the measured discriminator.

Also record every frame between Familiar and the agent. For each agent, state
whether the temporary `; :` command ran through a visible shell and include the
shell's `comm` and `command` rows. A shell frame confirms shell quoting for that
agent. Its absence does not authorize Codex quoting: stop and investigate or
amend the setup design. OpenCode is expected to show the direct `spawn` boundary
already specified by `integrations/opencode/hook.js`.

- [ ] **Step 4: Restore source and write the evidence note**

Remove only the temporary source block with `apply_patch`, then manually restore
the two agent configuration command strings. The note records hardware, OS,
terminal and agent versions, exact commands, full raw ancestor rows, selected
basename/TTY predicate, observed depth, and the shell-boundary result for every
agent. Verify:

```bash
git diff -- bin/familiar
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add docs/ref/2026-08-22-macos-agent-process-spike.md
git commit -m "docs(macos): record live agent ancestry"
```

---

### Task 2: Normalize records and add a lazy Darwin snapshot

**Files:**
- Modify: `src/bus/proc.js`
- Modify: `src/adapters/claude-code.js`
- Modify: `src/adapters/codex.js`
- Modify: `src/adapters/opencode.js`
- Modify: `test/proc.test.js`
- Modify: `test/claude-code.test.js`
- Modify: `test/codex.test.js`
- Modify: `test/opencode.test.js`

**Interfaces:**
- Produces: `createProcessOps(options)`, exported `defaultProcessOps`, and delegated exports `ancestors`, `recordOf`, `startTimeOf`, `isAlive`, and `pidExists`.
- Record: `{ pid, ppid, comm, tty, starttime }`; Linux `tty` is `true|null`, Darwin `tty` is `string|null`.
- Test seams: `platform`, `runPs(args): string`, and `kill(pid, 0)`.

- [ ] **Step 1: Write failing normalization/parser tests**

Change Linux expectations and adapter fixtures from `ttyNr: 0|number` to `tty: null|true`. Add to `test/proc.test.js`:

```js
test('Darwin ps keeps comm last and canonicalizes tty', () => {
  assert.deepEqual(parseDarwinRow(
    '77266 77264 ttys000 Sat Aug 22 23:24:46 2026 /Applications/Some App/claude'
  ), {
    pid: 77266,
    ppid: 77264,
    comm: 'claude',
    tty: 'ttys000',
    starttime: Date.parse('Sat Aug 22 23:24:46 2026') / 1000,
  });
});

test('Darwin tty accepts full and abbreviated ptys only', () => {
  assert.equal(normalizeDarwinTty('??'), null);
  assert.equal(normalizeDarwinTty('ttys003'), 'ttys003');
  assert.equal(normalizeDarwinTty('s003'), 'ttys003');
  for (const raw of ['console', '../ttys003', 'ttys003/x', '/dev/ttys003']) {
    assert.throws(() => normalizeDarwinTty(raw), /unsafe Darwin tty/);
  }
});

test('one Darwin snapshot serves ancestry, start time, and liveness', () => {
  let spawns = 0;
  const ops = createProcessOps({
    platform: 'darwin',
    runPs: () => {
      spawns++;
      return [
        '30 20 ?? Sat Aug 22 23:24:47 2026 /usr/bin/node',
        '20 10 ttys003 Sat Aug 22 23:24:46 2026 /opt/bin/claude',
        '10 1 ttys003 Sat Aug 22 23:00:00 2026 /bin/zsh',
      ].join('\n');
    },
    kill: () => {},
  });
  const chain = ops.ancestors(30);
  assert.deepEqual(chain.map((record) => record.pid), [30, 20, 10]);
  assert.equal(ops.startTimeOf(20), chain[1].starttime);
  assert.equal(ops.isAlive(20, { starttime: chain[1].starttime }), true);
  assert.equal(spawns, 1);
});
```

Also test malformed PID/PPID, invalid `lstart`, empty `comm`, nonzero `ps`, missing identity, and start-time mismatch.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test test/proc.test.js test/claude-code.test.js test/codex.test.js test/opencode.test.js
```

Expected: missing Darwin exports and old adapter predicates fail.

- [ ] **Step 3: Implement strict parsing**

Change Linux output to `tty: ttyNr === 0 ? null : true`. Add:

```js
const DARWIN_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

export function normalizeDarwinTty(raw) {
  if (raw === '??') return null;
  const match = /^(?:tty)?s([0-9a-f]+)$/i.exec(raw);
  if (!match) throw new Error(`Darwin ps: unsafe Darwin tty ${JSON.stringify(raw)}`);
  return `ttys${match[1]}`;
}

export function parseDarwinRow(line) {
  const match = DARWIN_ROW.exec(line);
  if (!match) throw new Error(`Darwin ps: malformed row ${JSON.stringify(line)}`);
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const starttime = Date.parse(match[4]) / 1000;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0
      || !Number.isInteger(starttime) || match[5].trim() === '') {
    throw new Error(`Darwin ps: malformed row ${JSON.stringify(line)}`);
  }
  return {
    pid, ppid, comm: basename(match[5]),
    tty: normalizeDarwinTty(match[3]), starttime,
  };
}
```

- [ ] **Step 4: Implement `createProcessOps`**

Keep explicit `linux`, `darwin`, and unsupported branches. The Darwin branch lazily caches `new Map(records.map(record => [record.pid, record]))`; `ancestors`, `recordOf`, `startTimeOf`, and `isAlive` share it. Default full-table execution is exactly:

```js
spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,tty=,lstart=,comm='], {
  encoding: 'utf8',
  env: { ...process.env, LC_ALL: 'C' },
});
```

Throw named errors for spawn errors, signals, nonzero status, or malformed rows. `isAlive` retains `kill(pid, 0)` with `EPERM` meaning the PID exists, then compares snapshot start time.

Instantiate and delegate the existing top-level API once:

```js
export const defaultProcessOps = createProcessOps();
export const ancestors = (...args) => defaultProcessOps.ancestors(...args);
export const recordOf = (...args) => defaultProcessOps.recordOf(...args);
export const startTimeOf = (...args) => defaultProcessOps.startTimeOf(...args);
export const isAlive = (...args) => defaultProcessOps.isAlive(...args);
export const pidExists = (...args) => defaultProcessOps.pidExists(...args);
```

- [ ] **Step 5: Update evidence-backed adapter predicates**

Use the Task 1 basenames and:

```js
const agent = chain.find((p, i) => i > 0 && p.comm === AGENT_COMM && p.tty !== null);
```

Link the Darwin claim in each adapter comment to the committed spike note.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/proc.test.js test/claude-code.test.js test/codex.test.js test/opencode.test.js
git add src/bus/proc.js src/adapters test/proc.test.js test/claude-code.test.js test/codex.test.js test/opencode.test.js
git commit -m "feat(process): add Darwin process snapshots"
```

---

### Task 3: Share the invocation view with transactions and locks

**Files:**
- Modify: `src/bus/proc.js`
- Modify: `src/bus/lock.js`
- Modify: `src/bus/transaction.js`
- Modify: `bin/familiar`
- Modify: `test/lock.test.js`
- Modify: `test/transaction.test.js`

**Interfaces:**
- Consumes: `createProcessOps()` from Task 2.
- Produces: `processOps.lockHolderAlive`; `withLock` options `startTimeOf` and `isAlive`; transaction dependency `processOps`.

- [ ] **Step 1: Write failing injection tests**

In `test/lock.test.js`, assert minting uses the supplied identity:

```js
test('lock token uses the invocation start-time reader', async (t) => {
  const path = lockPath(t);
  let calls = 0;
  await withLock(path, async () => {
    assert.match(readFileSync(path, 'utf8'), new RegExp(`^${process.pid}:12345:`));
  }, { startTimeOf: () => { calls++; return 12345; } });
  assert.equal(calls, 1);
});
```

In `test/transaction.test.js`, replace the separate process seams in `harness()` with:

```js
processOps: {
  ancestors: () => [{
    pid: 4242, ppid: 1, comm: 'claude', tty: true, starttime: 987654,
  }],
  recordOf: () => null,
  startTimeOf: () => 987654,
  isAlive: () => true,
  lockHolderAlive: () => true,
},
```

- [ ] **Step 2: Run focused tests and confirm the old imports bypass the seams**

```bash
node --test test/lock.test.js test/transaction.test.js
```

Expected: injected token identity and transaction process view are not used.

- [ ] **Step 3: Make lock identity explicit**

In `src/bus/lock.js`:

```js
const mintToken = (startTimeOf) =>
  `${process.pid}:${startTimeOf(process.pid)}:${randomUUID()}`;

// withLock options
startTimeOf = defaultStartTimeOf,
isAlive = defaultLockHolderAlive,

const token = mintToken(startTimeOf);
```

In Darwin process ops, implement `lockHolderAlive` with a cache keyed by `${pid}:${starttime}` and targeted arguments:

```js
['-p', String(pid), '-o', 'pid=,ppid=,tty=,lstart=,comm=']
```

If `kill(pid, 0)` says absent, return false. If PID existence is established but the targeted identity is unreadable, return true so reclaim cannot steal an unverifiable live lock. Otherwise compare start times.

Expose the targeted reader as `freshRecordOf(pid)` and `freshStartTimeOf(pid)` on both platform objects. Linux performs one fresh `/proc/<pid>/stat` read; Darwin performs the targeted `ps` above. `lockHolderAlive` reuses `freshRecordOf` rather than implementing a second parser path.

- [ ] **Step 4: Use one view in both transaction entry points**

In `src/bus/transaction.js`:

```js
const processOps = deps.processOps ?? defaultProcessOps;
const resolveAgentPid = deps.resolveAgentPid ?? (() =>
  adapter.resolveAgentPid({ ancestors: processOps.ancestors }));
```

Use `processOps.startTimeOf` for new records and `processOps.isAlive` for pruning. Pass these lock options in both `applyHookEvent` and `reap`:

```js
{
  startTimeOf: processOps.startTimeOf,
  isAlive: processOps.lockHolderAlive,
}
```

Pass the default lazy process view from `bin/familiar` to `hook` and `reap`; do not construct a second view in the emitter.

- [ ] **Step 5: Add the N-record spawn-count assertion**

Create three bus records in a transaction test, inject Darwin `runPs` with a counter, perform one hook transaction, and assert exactly one full-table call. The uncontended test must inject lock-holder behavior so it cannot add a targeted read.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/proc.test.js test/lock.test.js test/lock-multiprocess.test.js test/transaction.test.js
git add src/bus/proc.js src/bus/lock.js src/bus/transaction.js bin/familiar test/proc.test.js test/lock.test.js test/transaction.test.js
git commit -m "refactor(process): share one invocation snapshot"
```

---

### Task 4: Port the suite lease and owner scope

**Files:**
- Modify: `tools/test-runner.mjs`
- Modify: `test/test-runner.test.js`

**Interfaces:**
- Consumes: existing `withLock` and default process ops from Task 3.
- Produces: `withSuiteLease(fn, deps)`; version-2 owner records retain `pidNamespace`, with Darwin returning `darwin-host`.

- [ ] **Step 1: Write failing platform tests**

Add to `test/test-runner.test.js`:

```js
test('Darwin suite lease holds the existing file lock around its callback', async () => {
  const calls = [];
  const value = await withSuiteLease(async () => 'ran', {
    platform: 'darwin',
    tmpdir: () => '/private/tmp',
    uid: () => 501,
    withLock: async (path, fn, options) => {
      calls.push({ path, options });
      return fn();
    },
    processOps: { startTimeOf: () => 10, lockHolderAlive: () => true },
  });
  assert.equal(value, 'ran');
  assert.equal(calls[0].path, '/private/tmp/familiar-test-suite-501.lock');
  assert.equal(calls[0].options.staleMs, Infinity);
});

test('Darwin owner scope keeps the v2 pidNamespace field', () => {
  assert.equal(pidNamespaceOf({ platform: 'darwin' }), 'darwin-host');
});
```

Also inject a `withLock` rejection and assert `test runner: could not acquire suite lease`, without claiming a live suite was found.

- [ ] **Step 2: Verify failure**

```bash
node --test test/test-runner.test.js
```

Expected: missing exports and the unconditional `/proc/self/ns/pid` read fail.

- [ ] **Step 3: Wrap the suite in one platform lease**

Rename existing socket helpers to `acquireSocketLease`/`releaseSocketLease`, then add:

```js
export async function withSuiteLease(fn, {
  platform = process.platform,
  tmpdir: getTmpdir = tmpdir,
  uid = process.getuid,
  withLock: lock = withLock,
  processOps = defaultProcessOps,
  create = createServer,
  lockOptions = {},
} = {}) {
  if (platform === 'linux') {
    const lease = await acquireSocketLease(SUITE_LEASE, { create });
    try { return await fn(); }
    finally { await releaseSocketLease(lease); }
  }
  if (platform === 'darwin') {
    const path = join(getTmpdir(), `familiar-test-suite-${uid()}.lock`);
    let entered = false;
    try {
      return await lock(path, async () => {
        entered = true;
        return fn();
      }, {
        ...lockOptions,
        staleMs: Infinity,
        startTimeOf: processOps.startTimeOf,
        isAlive: processOps.lockHolderAlive,
      });
    } catch (error) {
      if (entered) throw error;
      throw new Error('test runner: could not acquire suite lease', { cause: error });
    }
  }
  throw new Error(`test runner: unsupported platform ${JSON.stringify(platform)}`);
}
```

Replace `runSuite`'s separate `startTime` and `isAlive` defaults with
`processOps = defaultProcessOps`; pass `processOps.isAlive` into root reaping.
Wrap the existing `runSuite` body with `withSuiteLease`, passing that same
`processOps`, instead of acquiring and releasing separately.

After `spawned` resolves, change the worker stamp from the snapshot-backed reader to:

```js
const starttime = processOps.freshStartTimeOf(child.pid);
```

The parent owner stamp remains `processOps.startTimeOf(process.pid)`, from the invocation snapshot. Add a test whose snapshot omits the subsequently spawned fake child but whose `freshStartTimeOf` returns its identity; assert the worker owner record is written with that value.

- [ ] **Step 4: Make the existing owner scope provider portable**

```js
export function pidNamespaceOf({
  platform = process.platform,
  readlink = readlinkSync,
} = {}) {
  if (platform === 'linux') return readlink('/proc/self/ns/pid');
  if (platform === 'darwin') return 'darwin-host';
  throw new Error(`test runner: unsupported platform ${JSON.stringify(platform)}`);
}
```

Keep `version: 2`, `pidNamespace`, and the exact-key validator unchanged.

- [ ] **Step 5: Cover crashed guards and live refusal**

Create a dead lock plus `.reclaim` guard in a temporary directory, age the guard past five seconds with `utimesSync`, and assert the Darwin callback runs with the real `withLock`. Separately pass `lockOptions: { retries: 1, delayMs: 0 }` around a held live lease and assert the generic lease error. Add a callback-throw test proving its original error is not relabeled as lease acquisition.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/test-runner.test.js test/lock.test.js test/lock-multiprocess.test.js
git add tools/test-runner.mjs test/test-runner.test.js
git commit -m "feat(test): add Darwin suite lease"
```

---

### Task 5: Separate terminal path and environment at the emitter

**Files:**
- Create: `src/render/term/target.js`
- Modify: `src/render/term/emit.js`
- Modify: `bin/familiar`
- Create: `test/terminal-target.test.js`
- Modify: `test/emit.test.js`
- Modify: `test/bin-familiar.test.js`

**Interfaces:**
- Produces: `terminalTarget(pid, { platform, record, hookEnv, readEnviron }): { path, env }`.
- Changes: `emit` requires `terminal: { path, env }` and performs no `/proc` or ambient-environment lookup.
- Consumes: `processOps.recordOf(intent.pid)` from the one invocation snapshot.

- [ ] **Step 1: Write failing target tests**

Create `test/terminal-target.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalTarget } from '../src/render/term/target.js';

test('Linux binds path and environment to the agent pid', () => {
  assert.deepEqual(terminalTarget(42, {
    platform: 'linux',
    readEnviron: () => 'TERM=xterm-kitty\0A=x=y\0',
  }), {
    path: '/proc/42/fd/1',
    env: { TERM: 'xterm-kitty', A: 'x=y' },
  });
});

test('Darwin combines validated agent tty with hook environment', () => {
  const hookEnv = { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' };
  assert.deepEqual(terminalTarget(42, {
    platform: 'darwin', record: { pid: 42, tty: 'ttys003' }, hookEnv,
  }), { path: '/dev/ttys003', env: hookEnv });
});

test('Darwin refuses missing and noncanonical tty records', () => {
  for (const tty of [null, true, 's003', '../ttys003']) {
    assert.throws(() => terminalTarget(42, {
      platform: 'darwin', record: { pid: 42, tty }, hookEnv: {},
    }), /validated Darwin tty/);
  }
});

test('unreadable Linux environ degrades graphics only', () => {
  assert.deepEqual(terminalTarget(42, {
    platform: 'linux', readEnviron: () => { throw new Error('gone'); },
  }), { path: '/proc/42/fd/1', env: undefined });
});
```

- [ ] **Step 2: Make emitter fixtures explicit**

In `test/emit.test.js`, replace `readEnviron: KITTY_ENVIRON` in `captureEmission` with:

```js
terminal: {
  path: '/proc/4242/fd/1',
  env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' },
},
```

Update the unreadable-environment case to pass `env: undefined`; retain assertions that graphics disappear while tint/bell remain. Assert the open seam receives `terminal.path`.

- [ ] **Step 3: Verify failure**

```bash
node --test test/terminal-target.test.js test/emit.test.js
```

Expected: missing target module and old emitter signature fail.

- [ ] **Step 4: Implement the target boundary**

Move `envOf` from `emit.js` into `target.js` and add:

```js
export function terminalTarget(pid, {
  platform = process.platform,
  record,
  hookEnv = process.env,
  readEnviron = readFileSync,
} = {}) {
  if (platform === 'linux') {
    let env;
    try { env = envOf(pid, readEnviron); }
    catch { /* graphics become none; tint/bell still use the validated fd */ }
    return { path: `/proc/${pid}/fd/1`, env };
  }
  if (platform === 'darwin') {
    if (!record || typeof record.tty !== 'string'
        || !/^ttys[0-9a-f]+$/i.test(record.tty)) {
      throw new Error(`terminal target: agent pid ${pid} has no validated Darwin tty`);
    }
    return { path: `/dev/${record.tty}`, env: hookEnv };
  }
  throw new Error(`terminal target: unsupported platform ${JSON.stringify(platform)}`);
}
```

Change `emit` to require `terminal`, compute capability from `terminal.env`, and call `open(terminal.path, 'a')`. Preserve precomputed bytes, `isatty`, complete-write, and open-failure behavior.

- [ ] **Step 5: Bind terminal data once in `bin/familiar`**

Before both normal and SessionEnd emission:

```js
const intentPid = next?.pid ?? prev?.pid;
const terminal = terminalTarget(intentPid, {
  record: processOps.recordOf(intentPid),
  hookEnv: process.env,
});
```

Pass `terminal` to `emit`. Add a CLI test that forces a resolver/TTY error and asserts one `familiar:` diagnostic with exit status zero.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/terminal-target.test.js test/emit.test.js test/bin-familiar.test.js
npm test
git add src/render/term/target.js src/render/term/emit.js bin/familiar test/terminal-target.test.js test/emit.test.js test/bin-familiar.test.js
git commit -m "feat(terminal): add validated Darwin target"
```

---

### Task 6: Add permanent macOS CI and correct status claims

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `docs/install.md`
- Modify: `docs/specs/2026-08-22-macos-support-design.md`

**Interfaces:**
- Consumes: this plan plus the completed theme and setup plans.
- Produces: permanent `macos-14` / Node 22 coverage; live rendering remains provisional.

- [ ] **Step 1: Add the permanent job**

Append:

```yaml
  macos:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - name: fast suite with Darwin tests enforced
        run: |
          npm test 2>&1 | tee "$RUNNER_TEMP/familiar-tests.log"
          ! grep -F 'SKIP requires Darwin' "$RUNNER_TEMP/familiar-tests.log"
          grep -F 'Darwin ps keeps comm last' "$RUNNER_TEMP/familiar-tests.log"
          grep -F 'Darwin copies a stable local pack' "$RUNNER_TEMP/familiar-tests.log"
      - name: linked command smoke
        run: |
          npm link
          familiar --help
          familiar setup codex | node -e '
            let text = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", chunk => text += chunk);
            process.stdin.on("end", () => {
              const value = JSON.parse(text);
              if (!value.hooks?.SessionEnd) process.exit(1);
            });
          '
```

Use standard shell tools; add no dependency. Keep the Linux Node 22/26 matrix and Linux smoke job.

- [ ] **Step 2: Verify Linux locally**

```bash
npm ci
npm test
git diff --check
```

Expected: full suite passes with named `requires Darwin` skips.

- [ ] **Step 3: Commit, push, and inspect all jobs**

```bash
git add .github/workflows/test.yml
git commit -m "ci(macos): run core support suite"
git push
gh run watch --exit-status
```

Expected: Linux Node 22/26, Linux smoke, and macOS Node 22 succeed. In the macOS log, the enforced Darwin test names run without `SKIP requires Darwin`.

- [ ] **Step 4: Correct historical status claims**

Only after the CI commit is an ancestor and the described files exist, change the design header to:

```markdown
**Status:** implemented for CI-backed core; physical terminal rendering remains provisional
```

Add the permanent run URL to its evidence section. Keep the physical Kitty/Ghostty checklist and provisional OpenCode renderer language in `docs/install.md`.

- [ ] **Step 5: Commit and verify**

```bash
git add docs/install.md docs/specs/2026-08-22-macos-support-design.md
git commit -m "docs(macos): record core implementation status"
npm test
git diff --check
git status --short
```

Expected: tests pass, no whitespace errors, and a clean worktree.

---

### Task 7: Run the physical terminal promotion gate

**Files:**
- Create: `docs/ref/2026-08-22-macos-terminal-smoke.md`
- Modify only after every check passes: `docs/install.md`
- Modify only after every check passes: `docs/specs/2026-08-22-macos-support-design.md`

**Interfaces:**
- Consumes: the permanent green macOS CI job and evidence-backed resolvers.
- Produces: versioned Kitty/Ghostty evidence; either retains provisional labels with recorded failures or promotes only the verified combinations.

- [ ] **Step 1: Record the test matrix before running it**

Create the evidence note with one row for each combination:

```markdown
| Agent | Kitty | Ghostty |
| --- | --- | --- |
| Claude Code | pending | pending |
| Codex | pending | pending |
| OpenCode | pending | pending |
```

Record macOS, hardware, terminal, agent, Node, and Familiar commit versions above the table.

- [ ] **Step 2: Exercise each applicable lifecycle**

For each cell, record pass/fail for launch/idle, working, approval, done/error where the adapter exposes it, normal session exit, and `familiar reap` after force-terminating one session. Record the resolved ancestor basename, raw/canonical TTY, inherited `TERM`, `COLORTERM`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, and `TMUX` markers without recording unrelated environment values.

Claude Code must visibly exercise Familiar's status-line sprite, tint, and bell. Codex must exercise hook-driven tint/bell plus its native generated pet. OpenCode must load `integrations/opencode/sprite-plugin.tsx` and visibly exercise its sprite renderer as well as hook-driven tint/bell.

- [ ] **Step 3: Apply the promotion rule**

If any cell fails, replace `pending` with a concise failure and commit the evidence note only; leave every provisional claim unchanged. If every cell passes, replace each value with `pass` and change the design status to:

```markdown
**Status:** implemented; macOS core and physical Kitty/Ghostty rendering verified
```

Remove only the corresponding provisional warnings from `docs/install.md`; do not broaden claims to tmux, Intel, macOS 13, or other terminals.

- [ ] **Step 4: Commit evidence and any earned promotion**

For a failed or partial pass:

```bash
git add docs/ref/2026-08-22-macos-terminal-smoke.md
git commit -m "docs(macos): record terminal smoke results"
```

For a complete pass:

```bash
git add docs/ref/2026-08-22-macos-terminal-smoke.md docs/install.md docs/specs/2026-08-22-macos-support-design.md
git commit -m "docs(macos): promote verified terminal support"
```

- [ ] **Step 5: Verify claims against evidence**

```bash
rg -n 'provisional|verified|tmux|Intel|macOS 13' docs/install.md docs/specs/2026-08-22-macos-support-design.md docs/ref/2026-08-22-macos-terminal-smoke.md
git diff --check HEAD^..HEAD
```

Expected: every promoted claim has a passing evidence row; deferred platforms remain explicitly unclaimed.
