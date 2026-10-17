# Project Colour from tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A registered project's familiar shows the project's tasks colour: the label
in the exact colour, the pet from the nearest slot, the chrome in its hue.

**Architecture:** One pure colour-to-slot rule beside the slot table; one bounded
reader of `tasks resolve --json`; the colour rides the agent record (resolved
outside the bus lock, carried while the checkout is unchanged) into
`resolveIdentity`, which decides slot, source and the pin check, and into
`identityColors`, which adds a `project` stop the HUD paints the name with. The
CLI surfaces and the Codex sync call the same reader.

**Tech Stack:** Node.js 22+, ES modules, `node:test`, Git, `tasks` 0.4.0 (optional
at runtime), Python 3 `tools/tt`, just. No new package dependency.

**Spec:** `docs/specs/2026-10-17-project-colour-design.md`, accepted by the user
2026-10-17 (round 3). Task: `fam-053b0d`. Engine baseline: `8019302`.

## Global Constraints

- The reader spawns exactly `tasks resolve --json <repoRoot>` with `execFile`, a
  `TASKS_TIMEOUT_MS = 2_000` timeout and `killSignal: 'SIGKILL'`. Outside a Git
  repository (`repoRoot === null`) nothing is spawned and the colour is `null`.
- `ENOENT` from the spawn means tasks is absent: colour `null`, no warnings.
- A colour is valid only as `^#[0-9a-f]{6}$`.
- Warnings are forwarded whenever no colour is returned (`unregistered` rows
  included) and dropped when a colour is returned; each is written to stderr as
  `familiar: tasks: <warning>`. Familiar never parses warning text.
- Slot rule: OKLCH chroma `< 0.05` → slot 11; otherwise the slot among 0–10
  whose table `hue` is nearest the colour's unrounded HSL hue on the circle;
  ties go to the lower slot.
- With a colour: slot from the colour, `source: 'colour'`; a matching pin whose
  slot differs faults with exactly
  `pin declares slot <p>, but project colour <hex> (from tasks) maps to slot <c>: remove the pin or change the project's colour`.
  Without: pin slot (`'pin'`) or `autoSlot` (`'auto'`).
- Colours: with a project colour, `ramp(HSL hue of the colour, slot's sat, tone)`
  plus `project: <the colour>`; without, today's slot ramp plus `project: light`.
- The agent record carries an own `projectColor` (`'#rrggbb'` or `null`). A record
  without it faults with exactly `session record lacks projectColor; wait for its next hook`.
- No config switch, no project discovery, no change to the slot table, the hash,
  the pin parser or the catalog location. No compatibility layer.
- Tests run through `just test-fast` (there is no `test-one` recipe); `just check`
  passes before every commit. The suite never depends on the host's tasks install:
  the runner puts `test/fixtures/fake-tasks` first on `PATH` (Task 2).
- Live checks run this worktree's code by explicit path
  (`.worktrees/project-colour/bin/familiar`); no launcher, symlink or hook
  config on the host is repointed.

## Review Focus

1. A user environment with `TASKS_FORMAT=pretty`: the reader must still get JSON,
   so it passes `--json` (Task 2 asserts the exact argv).
2. A tasks binary too old to have `resolve` (exit 2, usage text on stderr): one
   error line that quotes tasks' stderr, not a JSON parse error (Task 2).
3. A checkout path with spaces: passed as one argument, never through a shell
   (Task 2).
4. A session that moves between checkouts, and within one checkout's
   subdirectories: re-query on a checkout change only (Task 4).
5. `familiar projects` over several directories while tasks warns: each distinct
   warning written once (Task 5).

## Workspace

All work happens in `.worktrees/project-colour` (branch `feat/project-colour`,
hydrated with `npm ci`), where `fam-053b0d` is claimed. Paths below are
repository paths inside it. Each task is one child record of `fam-053b0d`, each
depending on the one before; start it with `tasks start <child>` before its first
change and close it with `tasks done <child> "<what landed>"` when its commit lands.

| Task | Record | Size, complexity |
| --- | --- | --- |
| 1 — Map a colour to a slot | `fam-e0c282` | s, low |
| 2 — Read a project's colour from tasks | `fam-577d64` | s, low |
| 3 — Identity, colours and HUD take a project colour | `fam-e13178` | m, mid |
| 4 — Resolve on the hook, carry on the record | `fam-0b2c16` | m, mid |
| 5 — whoami, projects and the Codex sync | `fam-a4f5d5` | m, mid |
| 6 — Benchmark, document and accept | `fam-1b0712` | m, mid |

---

### Task 1: Map a colour to a slot

**Files:**
- Create: `src/protocol/color.js`
- Modify: `src/protocol/slot-hues.js`
- Test: `test/color.test.js` (new), `test/slots.test.js`

**Interfaces:**
- Produces, in `src/protocol/color.js`:
  - `HEX_COLOR = /^#[0-9a-f]{6}$/`
  - `assertHexColor(value) → string`: returns `value` or throws
    `` `not a #rrggbb colour: ${JSON.stringify(value)}` ``.
  - `hexToHsl(hex) → { h, s, l }`: `h` in [0, 360), `s` and `l` in 0–100, unrounded.
  - `oklchChroma(hex) → number`: OKLab chroma of the sRGB colour (standard
    Björn Ottosson matrices, sRGB linearised with the 0.04045 knee).
- Produces, in `src/protocol/slot-hues.js`:
  - `GREY_CHROMA = 0.05`, `GREY_SLOT = 11`
  - `nearestSlotForHue(hue) → 0..10`
  - `slotForColor(hex) → 0..11` (calls `assertHexColor` first)

- [ ] **Step 1: Write the failing tests**

`test/color.test.js`:

```js
test('hexToHsl recovers unrounded HSL', () => {
  const fam = hexToHsl('#bc8369');
  assert.equal(fam.h.toFixed(2), '18.80');
  assert.equal(fam.s.toFixed(2), '38.25');
  assert.equal(fam.l.toFixed(2), '57.45');
  assert.deepEqual(hexToHsl('#ff0000'), { h: 0, s: 100, l: 50 });
  assert.equal(hexToHsl('#808080').s, 0);
});

test('oklchChroma separates the grey projects from the most muted colour', () => {
  assert.equal(oklchChroma('#776558').toFixed(4), '0.0305');
  assert.equal(oklchChroma('#947782').toFixed(4), '0.0392');
  assert.equal(oklchChroma('#859982').toFixed(4), '0.0405');
  assert.equal(oklchChroma('#72638f').toFixed(4), '0.0698');
  assert.ok(oklchChroma('#808080') < 1e-6);
});

test('assertHexColor accepts only lowercase #rrggbb', () => {
  assert.equal(assertHexColor('#bc8369'), '#bc8369');
  for (const bad of ['#BC8369', '#abc', 'bc8369', 'red', '', null, undefined, 42]) {
    assert.throws(() => assertHexColor(bad), /not a #rrggbb colour/);
  }
});
```

In `test/slots.test.js`:

```js
test('nearestSlotForHue wraps the circle and ties to the lower slot', () => {
  assert.equal(nearestSlotForHue(31), 0);     // 22 and 40 tie
  assert.equal(nearestSlotForHue(192), 5);    // 172 and 212 tie
  assert.equal(nearestSlotForHue(6), 0);      // 350 and 22 tie across 0°
  assert.equal(nearestSlotForHue(5.9), 10);
  assert.equal(nearestSlotForHue(6.1), 0);
  assert.equal(nearestSlotForHue(359), 10);
});

test('slotForColor sends low chroma to the grey slot', () => {
  assert.equal(slotForColor('#808080'), GREY_SLOT);
  assert.equal(slotForColor('#776558'), 11);
  assert.equal(slotForColor('#72638f'), 8);   // muted, still chromatic
  assert.throws(() => slotForColor('#BC8369'), /not a #rrggbb colour/);
});

// The spec's appendix: every registered colour on 2026-10-17 and its slot.
const REGISTERED = [
  ['#7995cd', 6], ['#d2647a', 10], ['#0ba880', 5], ['#70882e', 3], ['#776558', 11],
  ['#bc8369', 0], ['#db49af', 9], ['#cf6305', 0], ['#993ec8', 8], ['#2f9fb1', 5],
  ['#786cfe', 7], ['#a95479', 10], ['#d063e5', 9], ['#947782', 11], ['#d72633', 10],
  ['#058dfa', 6], ['#c72583', 9], ['#859982', 11], ['#72638f', 8], ['#317d01', 3],
  ['#9e83eb', 7], ['#8d6803', 1], ['#6671c6', 7], ['#0b6eae', 6], ['#2cab36', 4],
  ['#9c65bc', 8], ['#25786d', 5], ['#ff5e4a', 0], ['#aa8c0e', 2], ['#a8523a', 0],
  ['#2f63e1', 6], ['#fd538f', 10], ['#b780ad', 9],
];
test('slotForColor reproduces the spec appendix', () => {
  for (const [hex, slot] of REGISTERED) assert.equal(slotForColor(hex), slot, hex);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `just test-fast`
Expected: FAIL; `test/color.test.js` cannot import `../src/protocol/color.js`,
and `slots.test.js` reports `nearestSlotForHue` / `slotForColor` not exported.

- [ ] **Step 3: Implement `src/protocol/color.js` and the slot rule**

`color.js` imports nothing. `nearestSlotForHue` scans `SLOTS` minus slot 11 with
circular distance `min(|a−b| mod 360, 360 − …)`, keeping the first (lowest) slot
on equal distance. `slotForColor` returns `GREY_SLOT` when
`oklchChroma(hex) < GREY_CHROMA`, else `nearestSlotForHue(hexToHsl(hex).h)`. Add a
comment beside `GREY_CHROMA` that both thresholds are frozen with the table:
changing either reassigns pets.

- [ ] **Step 4: Run to see them pass**

Run: `just test-fast`
Expected: PASS, no other test changed.

- [ ] **Step 5: Commit**

```bash
just check
git add src/protocol/color.js src/protocol/slot-hues.js test/color.test.js test/slots.test.js
git commit -m "feat(identity): map a project colour to its nearest slot"
```

---

### Task 2: Read a project's colour from tasks

**Files:**
- Create: `src/bus/project-color.js`, `test/project-color.test.js`,
  `test/fixtures/fake-tasks/tasks` (executable, git mode 100755)
- Modify: `tools/test-runner.mjs` (the worker's `env`)

**Interfaces:**
- Consumes: `assertHexColor` (Task 1).
- Produces, in `src/bus/project-color.js`:
  - `TASKS_TIMEOUT_MS = 2_000`
  - `NO_PROJECT = Object.freeze({ prefix: null, color: null, warnings: Object.freeze([]) })`
  - `lookupProjectColor(dir, { exec = promisify(execFile), timeoutMs = TASKS_TIMEOUT_MS } = {})
    → Promise<{ prefix: string|null, color: string|null, warnings: string[] }>`
  - Errors: `Error` whose message starts `` `tasks resolve ${dir}: ` ``; a timeout
    carries `code: 'FAMILIAR_TASKS_TIMEOUT'`.
- Produces, `test/fixtures/fake-tasks/tasks`: appends `"$*"` as one line to
  `$FAKE_TASKS_LOG` when set; prints `$FAKE_TASKS_OUTPUT` when set, otherwise
  `{"results":[{"input":"<last arg>","kind":"path","status":"unregistered"}],"warnings":[],"fake":true}`;
  writes `$FAKE_TASKS_STDERR` to stderr when set; exits `${FAKE_TASKS_EXIT:-0}`.
  Header comment in the `fake-tmux` style: why it exists and that the runner
  puts its directory first on `PATH`.

- [ ] **Step 1: Write the failing tests**

`test/project-color.test.js`, with an `exec` fake that records its calls and
returns `{ stdout }` or rejects with an execFile-shaped error
(`Object.assign(new Error(m), { code, stdout, stderr, killed, signal })`):

```js
const row = (fields, warnings = []) =>
  JSON.stringify({ results: [{ input: '/r', kind: 'path', ...fields }], warnings });
// fakeExec(calls, answer): records [file, argv, options]; resolves `answer` when it
// has only `stdout`, otherwise rejects with it as an execFile-shaped error.

test('spawns tasks resolve --json with the checkout as one argument', async () => {
  const calls = [];
  await lookupProjectColor('/home/k/my repo',
    { exec: fakeExec(calls, { stdout: row({ status: 'unregistered' }) }) });
  assert.deepEqual(calls, [['tasks', ['resolve', '--json', '/home/k/my repo'],
    { timeout: 2000, killSignal: 'SIGKILL' }]]);
});

test('a resolved colour comes back and its warnings are dropped', ...);
// stdout: status resolved, prefix 'fam', color '#bc8369', warnings ['other: x']
// → { prefix: 'fam', color: '#bc8369', warnings: [] }

test('a resolved project without a colour forwards the warnings', ...);
// status resolved, prefix 'mind3', no color, warnings ['w'] → { prefix: 'mind3', color: null, warnings: ['w'] }

test('a linked checkout whose project config fails forwards its warning', ...);
// status unregistered, warnings
//   ['nexc: its checkout is not matched and its color is not reported (invalid color)']
// → { prefix: null, color: null, warnings: [that string] }

test('tasks absent is no project', ...);
// exec rejects { code: 'ENOENT' } → deepEqual NO_PROJECT

test('every other answer is an error naming the directory', async () => {
  const cases = [
    [{ code: 1, stdout: '{"error":{"kind":"io"}}', stderr: '' }, /^tasks resolve \/r: exited 1/],
    [{ code: 2, stdout: '', stderr: "error: unrecognized subcommand 'resolve'" },
      /exited 2: error: unrecognized subcommand 'resolve'/],
    [{ stdout: 'not json' }, /not JSON/],
    [{ stdout: '{"results":[],"warnings":[]}' }, /expected one result, got 0/],
    [{ stdout: row({ status: 'ambiguous' }) }, /status "ambiguous"/],
    [{ stdout: row({ status: 'invalid' }) }, /status "invalid"/],
    [{ stdout: row({ status: 'resolved', prefix: 'fam', color: '#BC8369' }) }, /not a #rrggbb colour/],
    [{ stdout: '{"results":[{"status":"unregistered"}],"warnings":"x"}' }, /warnings/],
  ];
  // a case with `stdout` only resolves; the others reject with that shape
});

test('a timeout is its own error', ...);
// exec rejects { killed: true, signal: 'SIGKILL' } → rejects with
// code 'FAMILIAR_TASKS_TIMEOUT' and /timed out after 2000ms/

test('the suite runs against the fake tasks, never the host one', () => {
  const out = JSON.parse(execFileSync('tasks', ['resolve', '--json', '/x'], { encoding: 'utf8' }));
  assert.equal(out.fake, true);
});
```

The non-zero-exit message includes tasks' trimmed stderr when non-empty, else its
trimmed stdout, so both an old binary's usage line and a JSON error are shown.

- [ ] **Step 2: Run to see them fail**

Run: `just test-fast`
Expected: FAIL; the module does not exist, and the last test reports the host's
real output (no `fake`) or `ENOENT` on CI.

- [ ] **Step 3: Implement `lookupProjectColor`, the fake and the runner change**

Timeout detection matches `gitContext` (`error.killed === true || error.signal === 'SIGKILL'`).
Validate `results` is a one-element array and `warnings` an array of strings
before reading the row. In `tools/test-runner.mjs`, the worker's env becomes
`{ ...process.env, TMPDIR: scratch, PATH: `${FAKE_TASKS}:${process.env.PATH ?? ''}` }`
with `FAKE_TASKS` resolved from the runner's own URL
(`../test/fixtures/fake-tasks`).

- [ ] **Step 4: Run to see them pass**

Run: `just test-fast`
Expected: PASS, the whole suite included.

- [ ] **Step 5: Commit**

```bash
just check
git add src/bus/project-color.js test/project-color.test.js test/fixtures/fake-tasks/tasks tools/test-runner.mjs
git commit -m "feat(identity): read a project's colour from tasks resolve"
```

---

### Task 3: Let identity, colours and the HUD take a project colour

**Files:**
- Modify: `src/theme/ramp.js`, `src/bus/resolve.js`, `src/render/term/hud.js`,
  `src/bus/transaction.js` (record field only), `bin/familiar.js` (callers),
  `src/install/codex.js` (caller)
- Test: `test/ramp.test.js`, `test/resolve.test.js`, `test/hud.test.js`,
  `test/transaction.test.js`, plus every test that hand-writes an agent record
  or a `resolveIdentity` context (`grep -ln "repositoryRoot" test/*.js`) or calls
  `identityColors(<slot>, …)`

**Interfaces:**
- Consumes: `slotForColor`, `assertHexColor`, `hexToHsl` (Task 1).
- Produces:
  - `identityColors({ slot, projectColor }, tone) → { shadow, base, light, highlight, backdrop, project }`;
    `projectColor` `undefined` throws `identityColors: projectColor must be a #rrggbb string or null`.
  - `resolveIdentity({ projectKey, project, remote, repoRoot, repositoryRoot, projectColor, catalog, pack })
    → { projectKey, project, slot, member, label, projectColor, source }`, `source`
    one of `'colour' | 'pin' | 'auto'`; `projectColor` `undefined` throws
    `resolveIdentity: projectColor must be a #rrggbb string or null`.
  - `resolveIdentities` reads `record.projectColor` behind the own-property guard.
  - Agent records written by `applyHookEvent` gain `projectColor: null` (Task 4
    replaces the constant with the looked-up value).
  - Temporary callers pass `projectColor: null`: `identityResolver().resolve` in
    `bin/familiar.js` and `planCodexProjectForPath` (Task 5 replaces both);
    `theme show`, `theme sheet` and `sheetRowCaptions` pass `{ slot, projectColor: null }`
    permanently (they show slots, not projects).

- [ ] **Step 1: Write the failing tests**

`test/ramp.test.js` (update the existing slot-0 test to the new call and stop):

```js
test('without a project colour the ramp is the slot\'s and the label is its light stop', () => {
  assert.deepEqual(identityColors({ slot: 0, projectColor: null }, DARK), {
    shadow: '#954d23', base: '#d68251', light: '#e5af8f',
    highlight: '#f1d5c5', backdrop: '#1f1814', project: '#e5af8f',
  });
});

test('a project colour supplies the hue; the slot supplies saturation; the label is exact', () => {
  assert.deepEqual(identityColors({ slot: 3, projectColor: '#317d01' }, DARK), {
    shadow: '#547f39', base: '#8bbd6b', light: '#b4d4a0',
    highlight: '#d8e9ce', backdrop: '#191d16', project: '#317d01',
  });
  assert.equal(identityColors({ slot: 3, projectColor: '#317d01' }, LIGHT).base, '#6ba249');
  assert.equal(identityColors({ slot: 3, projectColor: '#317d01' }, LIGHT).project, '#317d01');
  assert.equal(identityColors({ slot: 1, projectColor: '#8d6803' }, DARK).base, '#d2b156');
});

test('identityColors refuses a missing projectColor', () => {
  assert.throws(() => identityColors({ slot: 0 }, DARK), /projectColor must be a #rrggbb string or null/);
});
```

`test/resolve.test.js` (the existing `ctx` gains `projectColor: null`; the PACK
fixture's members hold slots 0, 3, 6 and the rest through `maine-coon`):

```js
test('a project colour decides the slot', () => {
  const id = resolveIdentity({ ...ctx, projectColor: '#317d01', catalog: NO_PINS, pack: PACK });
  assert.deepEqual([id.slot, id.member, id.source, id.projectColor], [3, 'dog-in-disguise', 'colour', '#317d01']);
});

test('an agreeing pin keeps its member choice under a colour', ...);
// pin path ctx.repoRoot slot 6 members { cats: 'maine-coon' }, projectColor '#058dfa' (→ 6)
// → slot 6, member 'maine-coon', source 'colour'

test('a pin that disagrees with the colour is a fault naming both', () => {
  const catalog = parseIdentities(`identities:\n  - path: ${ctx.repoRoot}\n    slot: 4\n`);
  assert.throws(() => resolveIdentity({ ...ctx, projectColor: '#317d01', catalog, pack: PACK }), {
    message: "pin declares slot 4, but project colour #317d01 (from tasks) maps to slot 3: "
      + "remove the pin or change the project's colour",
  });
});

test('without a colour the pin, then the hash, decide as before', ...);
// source 'pin' with the pin's slot; source 'auto' with autoSlot(projectKey)

test('projectColor is required and validated', ...);
// undefined → /projectColor must be a #rrggbb string or null/; '#BC8369' → /not a #rrggbb colour/

test('a record without its own projectColor faults until its next hook', ...);
// mirror the existing repositoryRoot guard test: deleted → faults
// 'session record lacks projectColor; wait for its next hook';
// inherited through the prototype → faults; own null → resolves

test('the intent carries the exact colour as its project stop', ...);
// resolveIntent with identity from projectColor '#317d01' → current.color.project === '#317d01'
```

`test/hud.test.js`:

```js
test('the project name is painted with the project stop, not the light stop', () => {
  const color = identityColors({ slot: 3, projectColor: '#317d01' }, DARK);
  const [identity] = hudLines({ intent: { color, urgency: 'none', state: 'idle' },
    fields: { project: 'ns', branch: null, model: null, usedPercent: null }, rows: 4 });
  assert.ok(identity.includes(fg('#317d01') + 'ns'));
  assert.ok(!identity.includes(fg(color.light) + 'ns'));
});
```

`test/transaction.test.js`: the first test's expected record gains
`projectColor: null`.

- [ ] **Step 2: Run to see them fail**

Run: `just test-fast`
Expected: FAIL in ramp, resolve, hud and transaction tests on the new
assertions; fixtures still lack `projectColor`.

- [ ] **Step 3: Implement**

- `ramp.js`: `identityColors` takes `{ slot, projectColor }`; with a colour it
  builds `ramp(hexToHsl(projectColor).h, slotSpec(slot).sat, tone)`.
- `resolve.js`: the slot rule and fault from Global Constraints, before the
  existing member/slot check; `source` and `projectColor` on the identity; the
  guard in `resolveIdentities` beside the `repositoryRoot` one;
  `resolveIntent` calls `identityColors(identity, tone)`.
- `hud.js`: `project: wrap('project')`; update the comment on `penFor` (the label
  is the project's own colour when it has one).
- `transaction.js`: the record literal gains `projectColor: null` after
  `repositoryRoot`.
- Sweep: every hand-written record fixture and `resolveIdentity` context gains
  `projectColor: null`; every `identityColors(n, tone)` becomes
  `identityColors({ slot: n, projectColor: null }, tone)`.

- [ ] **Step 4: Run to see them pass**

Run: `just test-fast`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
just check
git add -A src bin test
git commit -m "feat(identity): take a project colour into slot, colours and HUD label"
```

---

### Task 4: Resolve the colour on the hook and carry it on the record

**Files:**
- Modify: `src/bus/transaction.js`, `bin/familiar.js` (hook branch)
- Test: `test/transaction.test.js`, `test/bin-familiar.test.js`

**Interfaces:**
- Consumes: `lookupProjectColor`, `NO_PROJECT` (Task 2); records and identity
  from Task 3.
- Produces:
  - `applyHookEvent` accepts `deps.lookupProjectColor` (default: Task 2's) and
    returns `{ prev, next, seq, intent, evicted, warnings }`; `warnings` is `[]`
    unless this event spawned tasks and got no colour.
  - `carriedProjectColor(record, repoRoot) → string | null | undefined`,
    exported from `transaction.js`: the record's own `projectColor` when the
    record exists, its `repoRoot` equals `repoRoot`, and it owns the property;
    otherwise `undefined` (meaning "look it up").

- [ ] **Step 1: Write the failing tests**

`test/transaction.test.js`: `harness()` gains the default
`lookupProjectColor: async () => NO_PROJECT`, so no unit test spawns a process.
Then, with a `lookup` fake that records the directories it is asked about:

```js
test('the first event looks the colour up once; later events in the checkout carry it', async () => {
  const calls = [];
  const lookupProjectColor = async (dir) => { calls.push(dir); return { prefix: 'api', color: '#317d01', warnings: [] }; };
  const { paths, deps } = harness({ lookupProjectColor });
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  await applyHookEvent({ event: 'PreToolUse', stdin, deps });
  assert.deepEqual(calls, ['/home/k/d/api']);
  const agents = await readJson(paths.agentsPath);
  assert.equal(agents.s1.projectColor, '#317d01');
  const intent = await readJson(paths.intentPath);
  assert.equal(intent.s1.current.identity.slot, 3);
  assert.equal(intent.s1.current.color.project, '#317d01');
});

test('a null colour is carried too', ...);
// lookup returns NO_PROJECT → second event makes no call; record projectColor null

test('a change of checkout looks again; a subdirectory does not', ...);
// gitContext switches repoRoot '/home/k/d/api' → '/home/k/d/web' between events → 2 calls;
// a third event in cwd '/home/k/d/web/src' with repoRoot '/home/k/d/web' → still 2

test('a session never borrows another session\'s colour', ...);
// agents.json pre-seeded with s2 in the same repoRoot carrying '#317d01'
// (with projectColor own) → s1's first event still calls lookup once

test('outside a repository and on SessionEnd nothing is looked up', ...);
// gitContext → all null: record projectColor null, 0 calls; SessionEnd: 0 calls

test('warnings come back only from the event that looked', ...);
// lookup → { prefix: null, color: null, warnings: ['w'] }: first result.warnings ['w'],
// second [] (carried)

test('a tasks failure aborts before anything is written', ...);
// lookup rejects new Error('tasks resolve /home/k/d/api: exited 1: x') →
// applyHookEvent rejects with it; agents.json does not exist

test('an old record without projectColor is looked up and rewritten', ...);
// pre-seed s1 with repoRoot '/home/k/d/api' and no projectColor key → 1 call;
// rewritten record owns projectColor
```

`test/bin-familiar.test.js`, using the existing `pinned()`, `worktreeLayout()`
and `hookIdentity()` helpers (the wrapper resolves the agent; the runner's fake
tasks answers):

```js
test('the hook writes tasks warnings to stderr and still records the session', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'),
    FAKE_TASKS_OUTPUT: JSON.stringify({ results: [{ input: main, kind: 'path', status: 'unregistered' }],
      warnings: ['nexc: its checkout is not matched and its color is not reported (bad)'] }) };
  const r = spawnSync(process.execPath, [benchWrapper, bin, 'hook', 'PreToolUse', '--agent', 'claude-code'], {
    cwd: main, encoding: 'utf8', env: e, input: JSON.stringify({ session_id: 'warn', cwd: main }) });
  assert.equal(r.status, 0);
  assert.equal(r.stderr,
    'familiar: tasks: nexc: its checkout is not matched and its color is not reported (bad)\n');
  const agents = JSON.parse(readFileSync(join(e.FAMILIAR_STATE_DIR, 'agents.json'), 'utf8'));
  assert.equal(agents.warn.projectColor, null);
});

test('the status line paints the label in the colour its record carries', ...);
// the existing motion-off status line test's setup, its record gaining
// projectColor: '#317d01' → status 0, stderr '', stdout includes fg('#317d01') + 'api'
// (fg from src/render/term/sgr.js); with FAKE_TASKS_LOG set to a fresh path, that
// file is never created (the status line spawns no tasks)
```

- [ ] **Step 2: Run to see them fail**

Run: `just test-fast`
Expected: FAIL; the lookup is never called and records hold the Task 3 `null`.

- [ ] **Step 3: Implement**

In `applyHookEvent`, after `gitContext` and before `withLock`: when `level !== null`
and `context.repoRoot !== null`, read `agents.json` unlocked
(`(await readJson(paths.agentsPath)) ?? {}`), take
`carriedProjectColor(agents[sessionId], context.repoRoot)`, and call
`lookupProjectColor(context.repoRoot)` only when it is `undefined`. Write the
result into the record; return its `warnings` (or `[]`). Comment why the read is
unlocked (atomic renames; a race costs one redundant spawn, never a wrong colour)
and why no other session's record is reused. In `bin/familiar.js`'s hook branch,
write each returned warning as `familiar: tasks: <warning>\n`, before
`reportEvictions`.

- [ ] **Step 4: Run to see them pass**

Run: `just test-fast`
Expected: PASS, whole suite (the existing `hookIdentity` tests still see empty
stderr: the fake answers `unregistered` with no warnings).

- [ ] **Step 5: Commit**

```bash
just check
git add src/bus/transaction.js bin/familiar.js test/transaction.test.js test/bin-familiar.test.js
git commit -m "feat(identity): resolve the project colour on the hook and carry it"
```

---

### Task 5: Show the colour in whoami, projects and the Codex sync

**Files:**
- Modify: `bin/familiar.js` (`identityResolver`, `whoami`, `projects`, `install pets`),
  `src/install/codex.js`
- Test: `test/bin-familiar.test.js`, `test/cli-help.test.js`,
  `test/install-codex-single.test.js`

**Interfaces:**
- Consumes: `lookupProjectColor`, `NO_PROJECT` (Task 2); `resolveIdentity`
  with `projectColor` and `source` (Task 3).
- Produces:
  - `identityResolver().resolve(cwd) → { identity, pin, prefix, warnings }`
    (`warnings` from Task 2's rule). The commands write each distinct warning
    once, in first-seen order, to stderr before their stdout.
  - `whoami` JSON adds `color` (hex or `null`) and `source`; text adds
    `  colour  <hex> · <prefix>` after the slot line when there is a colour.
  - `projects` JSON rows add `color`; `source` becomes `identity.source`. Text:
    the swatch is the project colour when there is one, else today's `base`;
    the caption ends `· <source>`.
  - `planCodexProjectForPath({ path, pinned, catalog, pack, member = null, lookupProjectColor })`
    looks the colour up only when it must resolve the member itself and the path
    is in a repository; its outcomes past discovery carry `warnings`.
    `planCodexProjectSync({ catalog, pack, cwd, lookupProjectColor })` returns
    `{ configs, excludes, manual, missing, unpinnedSkip, warnings }` (distinct,
    first-seen); `install pets --sync-projects` writes them to stderr.

- [ ] **Step 1: Write the failing tests**

`test/bin-familiar.test.js`, beside the worktree parity tests:

```js
const resolvedAs = (color, warnings = []) => JSON.stringify({
  results: [{ input: 'x', kind: 'path', status: 'resolved', prefix: 'api', ...(color ? { color } : {}) }],
  warnings,
});

test('a registered colour reaches whoami, projects and the hook on every worktree', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'), FAKE_TASKS_OUTPUT: resolvedAs('#317d01') };
  for (const dir of [main, internal, external]) {
    const w = whoami(e, dir);
    assert.deepEqual([w.slot, w.color, w.source], [3, '#317d01', 'colour']);
  }
  assert.deepEqual(projectsJson(e, [main, internal]).map((p) => [p.slot, p.color, p.source]),
    [[3, '#317d01', 'colour'], [3, '#317d01', 'colour']]);
  const hooked = hookIdentity(e, internal);
  assert.deepEqual([hooked.slot, hooked.projectColor, hooked.source], [3, '#317d01', 'colour']);
});

test('whoami refuses a pin that disagrees with the colour', ...);
// pinned(main path, slot 7) + resolvedAs('#317d01') → status 1, stderr matches
// /pin declares slot 7, but project colour #317d01 \(from tasks\) maps to slot 3/

test('without tasks on PATH whoami behaves as before', ...);
// PATH = a temp dir holding only a `git` symlink (to `which git`'s answer);
// spawn with process.execPath → status 0, stderr '', color null, source 'auto'

test('a tasks failure is one error line naming the command', ...);
// FAKE_TASKS_EXIT=2, FAKE_TASKS_OUTPUT='', FAKE_TASKS_STDERR="error: unrecognized subcommand 'resolve'"
// → whoami status 1, stderr matches /tasks resolve .*: exited 2: error: unrecognized subcommand 'resolve'/

test('projects writes each tasks warning once', ...);
// unregistered row + warnings ['w1', 'w2'] for three dirs → stderr exactly
// 'familiar: tasks: w1\nfamiliar: tasks: w2\n'; rows color null, source 'auto'
```

`test/cli-help.test.js`, extending the existing whoami and projects tests' style:

```js
test('whoami text names the project colour and its tasks project', ...);
// FAKE_TASKS_OUTPUT resolvedAs('#317d01') → stdout matches /^  colour\s+#317d01 · api$/m

test('projects shows the project colour and its source', ...);
// same env, FAMILIAR_COLOR unset (no colour) → the cell's first line is
// '  #317d01  widget' and its caption ends '· slot 3 · colour'
```

`test/install-codex-single.test.js`:

```js
test('the Codex sync selects the pet the colour decides and reports warnings', async (t) => {
  // seedRepo + THEME (theme-slots: slot 3 → alpha, slot 7 → beta)
  const lookupProjectColor = async () => ({ prefix: 'api', color: '#317d01', warnings: [] });
  const plan = await planCodexProjectForPath({ path: repo, pinned: false, catalog: { identities: [] },
    pack: THEME, lookupProjectColor });
  assert.equal(plan.member, 'alpha');
  const warned = await planCodexProjectSync({ catalog: { identities: [] }, pack: THEME, cwd: repo,
    lookupProjectColor: async () => ({ prefix: null, color: null, warnings: ['w'] }) });
  assert.deepEqual(warned.warnings, ['w']);
});

test('a supplied member is never looked up', ...);
// lookupProjectColor that throws; member: 'beta' given → resolves, member 'beta'
```

- [ ] **Step 2: Run to see them fail**

Run: `just test-fast`
Expected: FAIL on the new assertions (`color` and `source` undefined, slot from
the hash, no warnings).

- [ ] **Step 3: Implement**

`identityResolver().resolve` calls `lookupProjectColor(repoRoot)` when `repoRoot`
is non-null, else uses `NO_PROJECT`, passes `projectColor` to `resolveIdentity`,
and returns `prefix` and `warnings`. `whoami` and `projects` gather warnings,
write the distinct ones, then print. `planCodexProjectForPath` takes
`lookupProjectColor` with Task 2's function as default; `planCodexProjectSync`
threads it through and collects warnings. Update `projects`' help text and the
empty-catalog hint only if they say who decides the slot.

- [ ] **Step 4: Run to see them pass**

Run: `just test-fast`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
just check
git add bin/familiar.js src/install/codex.js test/bin-familiar.test.js test/cli-help.test.js test/install-codex-single.test.js
git commit -m "feat(cli): show the project colour in whoami, projects and the Codex sync"
```

---

### Task 6: Benchmark, document and accept

**Files:**
- Modify: `test/fixtures/bench-hook-cli.mjs`, `tools/bench-hook.mjs`,
  `docs/install.md`, `docs/specs/2026-10-17-project-colour-design.md` (status),
  `docs/notes/2026-10-07-project-identity-brief.md` (result line)
- Test: `test/bench-hook.test.js`

**Interfaces:**
- Consumes: the finished hook (Task 4).
- Produces:
  - The wrapper records `tasks` runs like Git runs, written to `$BENCH_TASKS_LOG`
    when set; every warmup and sample gains `tasks: [{ args, ms, exit, signal }]`.
  - `EXPECTED_GIT = { baseline: { main: 2, linked: 3 }, candidate: { main: 2, linked: 3 } }`.
  - Structural check: in each batch, the first event (first warmup, or first
    sample when there are none) has at most one `tasks` run and every later event
    none; failure text `tasks spawns <n> after the first event`. The report adds,
    per batch, `firstEventTasks` (that event's `tasks` runs).

- [ ] **Step 1: Write the failing tests**

In `test/bench-hook.test.js`: a `structuralChecks` case where a candidate sample
after the first carries one `tasks` run fails with
`tasks spawns 1 after the first event`, and one where only the first event has it
passes; the recipe smoke test additionally asserts every sample has a `tasks`
array and `report.pairs[0].contexts.main.candidate.firstEventTasks.length <= 1`.
Export `structuralChecks` if it is not already reachable.

- [ ] **Step 2: Run to see them fail**

Run: `just test-fast`
Expected: FAIL; samples have no `tasks`, and the check does not exist.

- [ ] **Step 3: Implement the wrapper and driver changes**

Mirror the Git recording (`basename(file) === 'tasks'`); pass
`BENCH_TASKS_LOG` beside `BENCH_GIT_LOG` in the worker; keep the report scrubbed
of machine paths (its scrubber already walks every value).

- [ ] **Step 4: Run to see them pass, then commit**

Run: `just test-fast` — Expected: PASS.

```bash
just check
git add test/fixtures/bench-hook-cli.mjs tools/bench-hook.mjs test/bench-hook.test.js
git commit -m "test(bench): count tasks spawns and require none after a session's first event"
```

- [ ] **Step 5: Measure baseline and candidate in one sitting**

From the main checkout:

```sh
work-link --ensure .worktrees
git worktree add --detach .worktrees/colour-bench-baseline 8019302
git worktree lock --reason "on WORK_ROOT storage (host: $(uname -n))" .worktrees/colour-bench-baseline
npm --prefix .worktrees/colour-bench-baseline ci
bench_fixture=$(mktemp -d)
cd .worktrees/project-colour
just bench-hook compare ../colour-bench-baseline "$PWD" "$bench_fixture" 30 5 4
```

Run it in the foreground with a timeout that covers it (the 2026-10-08 sitting
took minutes, not hours). Expected: structural checks pass (Git 2/3 on both
sides, no `tasks` spawn after a batch's first event); timing status
`review-required`. Attach `$bench_fixture/report.json` to the Task 6 record
(`tasks attach`), and note a disposition: no consistent steady-state slowdown on
either context, judged from paired medians, order breakdown and p95 tails, as
`fam-f3d48e` was. A first-event `tasks` run appears only in the candidate's
`firstEventTasks`; record its duration. If the sitting is disturbed or
contradictory, analyse it, then repeat in a fresh fixture. Remove the baseline
checkout afterwards (`git -C .worktrees/colour-bench-baseline status --ignored --porcelain`,
`tt-report`, `git worktree unlock`, `git worktree remove`).

- [ ] **Step 6: Document**

In `docs/install.md`, under "Project identity and Git worktrees", add a
"Project colour" part: a registered project's colour comes from
`tasks resolve`, so every worktree shows the registered colour; the label is
that exact colour, the chrome its hue, the pet the nearest slot (greys to the
grey familiar); a pin on a registered project must name that slot or it is an
error naming both; unregistered checkouts and hosts without `tasks` (or with
`tasks` off the hook's `PATH`) keep pins and the hash; tasks warnings appear as
`familiar: tasks:` lines when no colour comes back; a colour edited in tasks
reaches a running session at its next checkout change or next session; records
from before the upgrade leave the bus until their next hook. Update the
`familiar projects` sentence to say the colour, a pin or the hash chose each
slot. Mark the spec implemented (header line) and add one dated line to the
brief's scope-rerun section pointing at it.

```bash
just check
git add docs/install.md docs/specs/2026-10-17-project-colour-design.md docs/notes/2026-10-07-project-identity-brief.md
git commit -m "docs(identity): document the project colour source and rules"
```

- [ ] **Step 7: The user judges the result**

Ask the user to run, from the main checkout,
`! .worktrees/project-colour/bin/familiar projects ~/d/familiar ~/d/ops ~/d/tasks ~/d/crew ~/d/flows ~/d/lit ~/d/natural-systems`
(any registered checkouts they like) and judge whether each swatch, name and pet
agree. This needs their eye: park `--waiting-on user --reason review` until they
answer. A rejection that changes the colour rule returns to the spec.

- [ ] **Step 8: Close out**

After the whole-branch review and integration: `tasks done` this step and
`fam-053b0d`, then `tasks note ops-30b965 "familiar now paints a registered project's label in its tasks colour and picks its pet from the nearest slot (fam-053b0d)"`.
