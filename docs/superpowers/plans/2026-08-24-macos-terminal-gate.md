# macOS Terminal Promotion Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the capture apparatus, runbook, and evidence skeleton that let one
physical-Mac session close the §11 terminal promotion gate and the background/daemon
resolver gap.

**Architecture:** A single opt-in tee at `writeAllSync` — the one choke point both the
hook's `emit()` and OpenCode's `sprite-plugin.tsx` already pass through — appends one
JSON line per terminal write to a private file, decomposing each escape into its
introducer, control keys, payload length, and digest. `emit()` adds a matching `target`
record naming the device it opened, and the two are correlated by `rdev`. An offline
verifier checks a returned trace against the §11.1 contract. The tee and runbook live on
a disposable capture branch; only the reviewed evidence note reaches `main`.

**Tech Stack:** Node 22 ESM, `node:test`, `node:crypto`, Darwin `/bin/ps`, Kitty and
Ghostty, Claude Code / Codex / OpenCode.

**Spec:** `docs/specs/2026-08-22-macos-support-design.md` §§4, 10, 11.1–11.7, 14.

## Global Constraints

- Two branches, and they never mix. Tasks 1–4 land on `spike/macos-terminal-gate`
  (worktree `.worktrees/macos-terminal-spike`), which is **disposable, never merged, and
  never pushed to any remote**. Task 5 lands on `docs/macos-terminal-gate` (worktree
  `.worktrees/macos-terminal-gate`), which is intended for `main`.
- The tee is instrumentation, not a feature. No `FAMILIAR_GATE_*` surface may appear in
  `HELP`, `docs/install.md`, or any document destined for `main`.
- The escape vocabulary is closed: `OSC 11`, `OSC 12`, `OSC 111`, `OSC 112`, `BEL`, and
  the Kitty graphics `APC`. Anything else fails the cell.
- Record `OSC 11`/`12`/`111`/`112` and `BEL` verbatim. Record every other payload —
  graphics and any out-of-vocabulary OSC — as length plus SHA-256 only.
- Identify the device by `rdev`, never by name: Node exposes no `ttyname`.
- Tracing runs **after** a successful write, never before, so a trace fault cannot
  suppress the terminal output the gate exists to measure.
- Capability `none` suppresses graphics only. Tint and bell still go out (§4).
- No raw capture is ever committed. Traces live under `$TMPDIR` with mode 600.
- Use conventional commits without attribution trailers.
- Node 22 for the matrix; the Mac's installed Node for the single spot-check cell.

## File Structure

On `spike/macos-terminal-gate`:

| File | Responsibility |
| --- | --- |
| `src/render/term/trace.js` (create) | The whole tee: context, escape decomposition, both record writers. One file so removing the instrumentation is deleting a file plus three call lines. |
| `src/render/term/io.js` (modify) | One call to `traceWrite` after the drain loop succeeds. |
| `src/render/term/emit.js` (modify) | One call to `traceTarget` after the `isatty` gate. |
| `bin/familiar` (modify) | One `setTraceContext({ agent, event })` in the hook branch. |
| `test/gate-trace.test.js` (create) | Decomposition and record-shape tests. |
| `tools/gate-verify.mjs` (create) | Offline verifier: reads a trace, checks it against §11.1, exits nonzero on violation. |
| `test/gate-verify.test.js` (create) | Verifier tests over synthetic traces. |
| `docs/ref/2026-08-24-macos-terminal-gate-handoff.md` (create) | The runbook the tester executes. |

On `docs/macos-terminal-gate`:

| File | Responsibility |
| --- | --- |
| `docs/ref/2026-08-24-macos-terminal-smoke.md` (create) | Evidence note, created with `pending` cells **before** the run, per §11.6. |
| `docs/superpowers/plans/2026-08-22-macos-process-runtime-and-ci.md` (modify) | Mark Task 7 superseded by this plan. |
| `src/adapters/codex.js` (modify) | Delete the stale title claim in its own commit. |

---

### Task 1: The trace module

**Files:**
- Create: `src/render/term/trace.js`
- Create: `test/gate-trace.test.js`

**Interfaces:**
- Produces: `setTraceContext({ agent, event })`, `tracePath(env)`,
  `decomposeEscapes(bytes) -> Array<Record>`, `traceTarget(path, options)`,
  `traceWrite(fd, bytes, options)`.
- Record kinds: `{ k: 'BEL' }`, `{ k: 'OSC', code, payload }`,
  `{ k: 'OSC', code, len, sha256 }` for out-of-vocabulary codes,
  `{ k: 'APC', keys, len, sha256 }`, `{ k: 'OTHER', hex }`,
  `{ k: 'UNTERMINATED', hex }`.
- All work on `spike/macos-terminal-gate` in `.worktrees/macos-terminal-spike`.

- [ ] **Step 1: Write the failing decomposition tests**

Create `test/gate-trace.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { decomposeEscapes } from '../src/render/term/trace.js';

const ST = '\x1b\\';
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'binary')).digest('hex');

test('the in-vocabulary tint, cursor, reset and bell escapes are recorded verbatim', () => {
  const bytes = Buffer.from(
    `\x1b]11;#1a1b26${ST}\x1b]12;#e0af68${ST}\x07\x1b]111${ST}\x1b]112${ST}`,
    'binary',
  );
  assert.deepEqual(decomposeEscapes(bytes), [
    { k: 'OSC', code: '11', payload: '#1a1b26' },
    { k: 'OSC', code: '12', payload: '#e0af68' },
    { k: 'BEL' },
    { k: 'OSC', code: '111', payload: '' },
    { k: 'OSC', code: '112', payload: '' },
  ]);
});

test('a graphics APC is recorded as keys plus length and digest, never as pixels', () => {
  const payload = 'AAAABBBBCCCC';
  const bytes = Buffer.from(`\x1b_Ga=t,q=2,f=100,i=42;${payload}${ST}`, 'binary');
  assert.deepEqual(decomposeEscapes(bytes), [
    { k: 'APC', keys: 'a=t,q=2,f=100,i=42', len: payload.length, sha256: sha(payload) },
  ]);
});

test('every chunk of a chunked transmission is recorded separately', () => {
  const bytes = Buffer.from(
    `\x1b_Ga=t,m=1;AAAA${ST}\x1b_Gm=1;BBBB${ST}\x1b_Gm=0;${ST}`,
    'binary',
  );
  const out = decomposeEscapes(bytes);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.keys), ['a=t,m=1', 'm=1', 'm=0']);
  assert.deepEqual(out.map((e) => e.len), [4, 4, 0]);
});

test('an out-of-vocabulary OSC keeps its code but never its payload', () => {
  // The title escape Familiar must never emit. Its payload is the project name,
  // so recording it verbatim would put private data in the trace; the code alone
  // is what fails the cell.
  const bytes = Buffer.from(`\x1b]2;secret-project${ST}`, 'binary');
  assert.deepEqual(decomposeEscapes(bytes), [
    { k: 'OSC', code: '2', len: 'secret-project'.length, sha256: sha('secret-project') },
  ]);
});

test('bytes outside the vocabulary are recorded as hex rather than dropped', () => {
  assert.deepEqual(decomposeEscapes(Buffer.from('hi', 'binary')), [
    { k: 'OTHER', hex: '6869' },
  ]);
});

test('an unterminated escape is reported rather than swallowed', () => {
  const out = decomposeEscapes(Buffer.from('\x1b]11;#1a1b26', 'binary'));
  assert.equal(out.length, 1);
  assert.equal(out[0].k, 'UNTERMINATED');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/gate-trace.test.js
```

Expected: FAIL — `Cannot find module '../src/render/term/trace.js'`.

- [ ] **Step 3: Write the trace module**

Create `src/render/term/trace.js`:

```js
import { appendFileSync, fstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

// SPIKE-ONLY INSTRUMENTATION for the §11 terminal promotion gate. This file and its three
// call sites are the entire tee; deleting it is how the instrumentation is removed. It must
// never reach main.
//
// Every record is written AFTER the terminal write it describes has already succeeded, so a
// fault here cannot suppress the output the gate exists to measure. Faults are not swallowed:
// the hook's cosmetic boundary reports them, which is what we want to see.

const ST = '\x1b\\';

// The closed vocabulary Familiar actually emits (src/render/term/osc.js). A payload is kept
// verbatim only for these; everything else is reduced to length and digest, because the one
// out-of-vocabulary escape we can name -- the title -- carries the project name.
const VERBATIM_OSC = new Set(['11', '12', '111', '112']);

let context = { agent: process.env.FAMILIAR_GATE_AGENT ?? null, event: null };

export function setTraceContext(next) {
  context = { ...context, ...next };
}

export function tracePath(env = process.env) {
  return env.FAMILIAR_GATE_TRACE ?? null;
}

const sha = (payload) => createHash('sha256').update(Buffer.from(payload, 'binary')).digest('hex');
const hexOf = (chunk) => Buffer.from(chunk, 'binary').toString('hex');

function splitBody(body) {
  const semi = body.indexOf(';');
  return semi === -1 ? [body, ''] : [body.slice(0, semi), body.slice(semi + 1)];
}

export function decomposeEscapes(bytes) {
  // 'binary' (latin1) is a byte-preserving round trip. utf8 would mangle image payloads.
  const text = Buffer.from(bytes).toString('binary');
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x07') { out.push({ k: 'BEL' }); i += 1; continue; }

    const isOsc = text.startsWith('\x1b]', i);
    const isApc = text.startsWith('\x1b_G', i);
    if (isOsc || isApc) {
      const end = text.indexOf(ST, i);
      if (end === -1) { out.push({ k: 'UNTERMINATED', hex: hexOf(text.slice(i)) }); break; }
      const [head, payload] = splitBody(text.slice(i + (isOsc ? 2 : 3), end));
      if (isApc) {
        out.push({ k: 'APC', keys: head, len: payload.length, sha256: sha(payload) });
      } else if (VERBATIM_OSC.has(head)) {
        out.push({ k: 'OSC', code: head, payload });
      } else {
        out.push({ k: 'OSC', code: head, len: payload.length, sha256: sha(payload) });
      }
      i = end + ST.length;
      continue;
    }

    // Outside the vocabulary. Recorded as hex so the verifier can fail the cell and a
    // reviewer can see exactly what appeared, rather than inferring it from a gap.
    let next = i + 1;
    while (next < text.length && text[next] !== '\x1b' && text[next] !== '\x07') next += 1;
    out.push({ k: 'OTHER', hex: hexOf(text.slice(i, next)) });
    i = next;
  }
  return out;
}

function append(line, { env, appendFile }) {
  const file = tracePath(env);
  if (file === null) return;
  appendFile(file, `${JSON.stringify(line)}\n`);
}

export function traceTarget(path, {
  env = process.env, now = () => new Date().toISOString(),
  appendFile = appendFileSync, stat = statSync,
} = {}) {
  if (tracePath(env) === null) return;
  let rdev = null;
  try { rdev = stat(path).rdev; } catch { rdev = null; }
  append({
    t: now(), pid: process.pid, kind: 'target',
    agent: context.agent, event: context.event, path, rdev,
  }, { env, appendFile });
}

export function traceWrite(fd, bytes, {
  env = process.env, now = () => new Date().toISOString(),
  appendFile = appendFileSync, fstat = fstatSync,
} = {}) {
  if (tracePath(env) === null) return;
  let rdev = null;
  try { rdev = fstat(fd).rdev; } catch { rdev = null; }
  append({
    t: now(), pid: process.pid, kind: 'write',
    agent: context.agent, event: context.event,
    fd, rdev, len: bytes.length, escapes: decomposeEscapes(bytes),
  }, { env, appendFile });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/gate-trace.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Write the record-writer tests**

Append to `test/gate-trace.test.js`:

```js
import { setTraceContext, traceTarget, traceWrite, tracePath } from '../src/render/term/trace.js';

test('nothing is written and nothing is stat-ed when the trace is not enabled', () => {
  let touched = 0;
  const bump = () => { touched += 1; throw new Error('must not be called'); };
  traceTarget('/dev/ttys004', { env: {}, appendFile: bump, stat: bump });
  traceWrite(7, Buffer.from('x'), { env: {}, appendFile: bump, fstat: bump });
  assert.equal(touched, 0);
  assert.equal(tracePath({}), null);
});

test('a target record names the device path and its rdev', () => {
  const lines = [];
  traceTarget('/dev/ttys004', {
    env: { FAMILIAR_GATE_TRACE: '/tmp/t.jsonl' },
    now: () => 'T0',
    appendFile: (_file, line) => lines.push(JSON.parse(line)),
    stat: (path) => { assert.equal(path, '/dev/ttys004'); return { rdev: 268435460 }; },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'target');
  assert.equal(lines[0].path, '/dev/ttys004');
  assert.equal(lines[0].rdev, 268435460);
});

test('a write record carries the fd rdev, the length, and the decomposed escapes', () => {
  setTraceContext({ agent: 'claude-code', event: 'PreToolUse' });
  const lines = [];
  traceWrite(7, Buffer.from(`\x1b]11;#1a1b26${ST}\x07`, 'binary'), {
    env: { FAMILIAR_GATE_TRACE: '/tmp/t.jsonl' },
    now: () => 'T1',
    appendFile: (_file, line) => lines.push(JSON.parse(line)),
    fstat: (fd) => { assert.equal(fd, 7); return { rdev: 268435460 }; },
  });
  assert.deepEqual(lines[0], {
    t: 'T1', pid: process.pid, kind: 'write',
    agent: 'claude-code', event: 'PreToolUse',
    fd: 7, rdev: 268435460, len: 15,
    escapes: [{ k: 'OSC', code: '11', payload: '#1a1b26' }, { k: 'BEL' }],
  });
});

test('an unstattable device records a null rdev rather than failing the write path', () => {
  const lines = [];
  traceWrite(7, Buffer.from('\x07', 'binary'), {
    env: { FAMILIAR_GATE_TRACE: '/tmp/t.jsonl' },
    now: () => 'T2',
    appendFile: (_file, line) => lines.push(JSON.parse(line)),
    fstat: () => { throw new Error('EBADF'); },
  });
  assert.equal(lines[0].rdev, null);
});
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test test/gate-trace.test.js
```

Expected: PASS, 10 tests. The `len: 15` literal is the byte count of
`\x1b]11;#1a1b26\x1b\\\x07` — twelve bytes of OSC, two of ST, one of BEL.

- [ ] **Step 7: Commit**

```bash
git add src/render/term/trace.js test/gate-trace.test.js
git commit -m "test(gate): add the terminal trace recorder"
```

---

### Task 2: Wire the tee into the three call sites

**Files:**
- Modify: `src/render/term/io.js`
- Modify: `src/render/term/emit.js`
- Modify: `bin/familiar`
- Modify: `test/term-io.test.js`
- Modify: `test/emit.test.js`

**Interfaces:**
- Consumes: `traceWrite`, `traceTarget`, `setTraceContext` from Task 1.
- Produces: a trace file containing, for one hook invocation, one `target` record
  followed by one `write` record whose `rdev` matches it.

- [ ] **Step 1: Write the failing wiring tests**

Append to `test/term-io.test.js`:

```js
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a successful drain appends exactly one trace record when tracing is enabled', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-')), 'trace.jsonl');
  process.env.FAMILIAR_GATE_TRACE = file;
  try {
    writeAllSync(Buffer.from('\x07'), { fd: 1, write: (_fd, _b, _o, len) => len });
  } finally {
    delete process.env.FAMILIAR_GATE_TRACE;
  }
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'write');
  assert.deepEqual(lines[0].escapes, [{ k: 'BEL' }]);
});

test('a short write that drains in three calls still traces once, not three times', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-')), 'trace.jsonl');
  process.env.FAMILIAR_GATE_TRACE = file;
  const accepts = [1, 1, 99];
  try {
    writeAllSync(Buffer.from('abc'), {
      fd: 1,
      write: (_fd, _b, _o, len) => Math.min(accepts.shift(), len),
    });
  } finally {
    delete process.env.FAMILIAR_GATE_TRACE;
  }
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('a failed write traces nothing, because there is no output to describe', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-')), 'trace.jsonl');
  process.env.FAMILIAR_GATE_TRACE = file;
  try {
    assert.throws(() => writeAllSync(Buffer.from('x'), { fd: 1, write: () => 0 }));
  } finally {
    delete process.env.FAMILIAR_GATE_TRACE;
  }
  assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
node --test test/term-io.test.js
```

Expected: FAIL — the trace file is never created (`ENOENT` on the first two).

- [ ] **Step 3: Wire `io.js`**

In `src/render/term/io.js`, add the import and one call after the drain loop:

```js
import { writeSync } from 'node:fs';
import { traceWrite } from './trace.js';   // SPIKE-ONLY, see trace.js
```

and immediately before `return offset;`:

```js
  // AFTER the drain, never before: a trace fault must not be able to suppress the
  // terminal output this gate exists to measure. Inert unless FAMILIAR_GATE_TRACE is set.
  traceWrite(fd, bytes);
  return offset;
```

- [ ] **Step 4: Run to verify they pass**

```bash
node --test test/term-io.test.js
```

Expected: PASS, all tests including the five pre-existing ones.

- [ ] **Step 5: Write the failing emit target test**

Append to `test/emit.test.js`:

```js
test('emit records the device it opened before the bytes it wrote', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-')), 'trace.jsonl');
  process.env.FAMILIAR_GATE_TRACE = file;
  try {
    captureEmission({ terminal: { ...KITTY_TERMINAL, path: '/dev/ttys004' } });
  } finally {
    delete process.env.FAMILIAR_GATE_TRACE;
  }
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, 'target');
  assert.equal(lines[0].path, '/dev/ttys004');
  assert.ok(lines.slice(1).every((l) => l.kind === 'write'));
});
```

`captureEmission` is the file's existing emit helper (`test/emit.test.js:96`) and
`KITTY_TERMINAL` its terminal fixture (line 66); reuse both rather than building a
second harness. Add `mkdtempSync` and `readFileSync` to the file's `node:fs` import —
`tmpdir` and `join` are already imported.

- [ ] **Step 6: Run to verify it fails**

```bash
node --test test/emit.test.js
```

Expected: FAIL — the first record is a `write`, because no `target` record exists.

- [ ] **Step 7: Wire `emit.js`**

Add to the imports in `src/render/term/emit.js`:

```js
import { traceTarget } from './trace.js';   // SPIKE-ONLY, see trace.js
```

and inside the `try` block, immediately after the `isatty` gate:

```js
    if (!checkTty(fd)) return;
    // The device, named. writeAllSync sees only an fd, so this is the record that
    // says which /dev/ttys<hex> the following write bytes actually reached.
    traceTarget(terminal.path);
    return writeAllSync(bytes, { fd, write });
```

- [ ] **Step 8: Run to verify it passes**

```bash
node --test test/emit.test.js
```

Expected: PASS.

- [ ] **Step 9: Set the trace context in the hook branch**

In `bin/familiar`, add to the imports:

```js
import { setTraceContext } from '../src/render/term/trace.js';   // SPIKE-ONLY
```

Locate the `hook` branch (the one guarded by `command === 'hook'`, near the
`parseLeaf(rest, { help: 'hook' })` call at roughly line 681) and add, as its first
statement inside the branch, after `agent` and `event` are in scope:

```js
    setTraceContext({ agent, event });
```

Read the surrounding lines first: the local variable holding the event name may be
called `event` or destructured from the parse result. Use the names actually in scope.

- [ ] **Step 10: Run the full suite**

```bash
npm test
```

Expected: one pre-existing failure only — `a status line invocation makes exactly one
cheap git call`, the known cold-`git` `BRANCH_TIMEOUT_MS` timing failure recorded in
§6 of `docs/ref/2026-08-23-macos-agent-process-spike.md`. Any other failure is a real
regression: stop and fix before committing.

- [ ] **Step 11: Commit**

```bash
git add src/render/term/io.js src/render/term/emit.js bin/familiar test/term-io.test.js test/emit.test.js
git commit -m "test(gate): tee terminal writes behind an opt-in trace"
```

---

### Task 3: The offline verifier

**Files:**
- Create: `tools/gate-verify.mjs`
- Create: `test/gate-verify.test.js`

**Interfaces:**
- Consumes: a trace file of the shape Task 1 produces.
- Produces: `verifyTrace(records, { expectCapability })` returning
  `{ violations: string[], summary: { agents, writes, apcChunks, bells, resets } }`,
  and a CLI that exits 1 when `violations` is non-empty.

- [ ] **Step 1: Write the failing verifier tests**

Create `test/gate-verify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyTrace } from '../tools/gate-verify.mjs';

const target = (over = {}) => ({
  t: 'T0', pid: 1, kind: 'target', agent: 'claude-code', event: 'PreToolUse',
  path: '/dev/ttys004', rdev: 268435460, ...over,
});
const write = (escapes, over = {}) => ({
  t: 'T1', pid: 1, kind: 'write', agent: 'claude-code', event: 'PreToolUse',
  fd: 7, rdev: 268435460, len: 1, escapes, ...over,
});
const tint = [{ k: 'OSC', code: '11', payload: '#1a1b26' }, { k: 'OSC', code: '12', payload: '#e0af68' }];

test('a clean graphics-capable trace has no violations', () => {
  const { violations } = verifyTrace([
    target(),
    write([{ k: 'APC', keys: 'a=t,q=2,i=42', len: 10, sha256: 'x' }, ...tint]),
  ]);
  assert.deepEqual(violations, []);
});

test('an fd on a different device than the opened target is a violation', () => {
  const { violations } = verifyTrace([target(), write(tint, { rdev: 999 })]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rdev/);
});

test('an out-of-vocabulary escape fails the cell', () => {
  const { violations } = verifyTrace([
    target(),
    write([{ k: 'OSC', code: '2', len: 4, sha256: 'x' }, ...tint]),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /OSC 2/);
});

test('OTHER and UNTERMINATED bytes each fail the cell', () => {
  const { violations } = verifyTrace([
    target(),
    write([{ k: 'OTHER', hex: '6869' }]),
    write([{ k: 'UNTERMINATED', hex: '1b5d' }]),
  ]);
  assert.equal(violations.length, 2);
});

test('an APC without an image id fails, because the status line could not name it', () => {
  const { violations } = verifyTrace([
    target(),
    write([{ k: 'APC', keys: 'a=t,q=2', len: 10, sha256: 'x' }, ...tint]),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /image id/);
});

test('a capability-none run must carry tint but no graphics', () => {
  const clean = verifyTrace([target(), write(tint)], { expectCapability: 'none' });
  assert.deepEqual(clean.violations, []);

  const leaked = verifyTrace([
    target(),
    write([{ k: 'APC', keys: 'a=t,i=42', len: 10, sha256: 'x' }, ...tint]),
  ], { expectCapability: 'none' });
  assert.equal(leaked.violations.length, 1);
  assert.match(leaked.violations[0], /capability none/);

  const silent = verifyTrace([target()], { expectCapability: 'none' });
  assert.match(silent.violations.join(' '), /no tint/);
});

test('a write with no preceding target for its pid is a violation', () => {
  const { violations } = verifyTrace([write(tint)]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no target/);
});

test('the summary counts what a reviewer reads first', () => {
  const { summary } = verifyTrace([
    target(),
    write([{ k: 'APC', keys: 'a=t,i=42,m=1', len: 4, sha256: 'x' }]),
    write([{ k: 'APC', keys: 'm=0', len: 0, sha256: 'y' }, { k: 'BEL' }]),
    write([{ k: 'OSC', code: '111', payload: '' }, { k: 'OSC', code: '112', payload: '' }]),
  ]);
  assert.deepEqual(summary, {
    agents: ['claude-code'], writes: 3, apcChunks: 2, bells: 1, resets: 1,
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
node --test test/gate-verify.test.js
```

Expected: FAIL — `Cannot find module '../tools/gate-verify.mjs'`.

- [ ] **Step 3: Write the verifier**

Create `tools/gate-verify.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Offline check of a returned §11 trace against the evidence contract in
// docs/specs/2026-08-22-macos-support-design.md §11.1. Reads only the redacted trace;
// it never needs the raw capture.

const VOCABULARY = new Set(['11', '12', '111', '112']);

export function verifyTrace(records, { expectCapability = 'graphics' } = {}) {
  const violations = [];
  const targets = new Map();        // pid -> most recent target record
  const agents = new Set();
  let writes = 0, apcChunks = 0, bells = 0, resets = 0, tints = 0;

  for (const record of records) {
    if (record.agent) agents.add(record.agent);
    if (record.kind === 'target') { targets.set(record.pid, record); continue; }
    if (record.kind !== 'write') { violations.push(`unknown record kind ${record.kind}`); continue; }

    writes += 1;
    const target = targets.get(record.pid);
    if (target === undefined) {
      violations.push(`write from pid ${record.pid} has no target record before it`);
    } else if (target.rdev !== record.rdev) {
      // The whole point of the gate: bytes reaching a device other than the one the
      // resolver chose is a wrong-target defect, not a cosmetic difference.
      violations.push(
        `write from pid ${record.pid} has rdev ${record.rdev}, but the opened target ` +
        `${target.path} has rdev ${target.rdev}`,
      );
    }

    for (const escape of record.escapes) {
      if (escape.k === 'BEL') { bells += 1; continue; }
      if (escape.k === 'OTHER') { violations.push(`out-of-vocabulary bytes ${escape.hex}`); continue; }
      if (escape.k === 'UNTERMINATED') { violations.push(`unterminated escape ${escape.hex}`); continue; }
      if (escape.k === 'APC') {
        apcChunks += 1;
        // Only the first chunk of a chunked transmission carries `a=` and the id;
        // continuations carry `m=` alone and must not be required to repeat it.
        const continuation = !/(^|,)a=/.test(escape.keys);
        if (!continuation && !/(^|,)i=\d+/.test(escape.keys)) {
          violations.push(`graphics chunk "${escape.keys}" carries no image id`);
        }
        if (expectCapability === 'none') {
          violations.push(`graphics emitted under capability none: "${escape.keys}"`);
        }
        continue;
      }
      if (escape.k === 'OSC') {
        if (!VOCABULARY.has(escape.code)) {
          violations.push(`OSC ${escape.code} is outside the closed vocabulary`);
          continue;
        }
        if (escape.code === '11' || escape.code === '12') tints += 1;
        if (escape.code === '111' || escape.code === '112') resets += 1;
        continue;
      }
      violations.push(`unknown escape kind ${escape.k}`);
    }
  }

  if (expectCapability === 'none' && tints === 0) {
    violations.push('capability none run recorded no tint: graphics degradation must not silence tint and bell');
  }

  return {
    violations,
    summary: { agents: [...agents], writes, apcChunks, bells, resets: Math.floor(resets / 2) },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, capability = 'graphics'] = process.argv.slice(2);
  if (!file) {
    process.stderr.write('usage: gate-verify.mjs <trace.jsonl> [graphics|none]\n');
    process.exit(2);
  }
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { violations, summary } = verifyTrace(records, { expectCapability: capability });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  for (const violation of violations) process.stdout.write(`VIOLATION ${violation}\n`);
  process.exit(violations.length === 0 ? 0 : 1);
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
node --test test/gate-verify.test.js
```

Expected: PASS, 8 tests. Note `resets` is counted as pairs — `OSC 111` and `OSC 112`
together are one restore. If the summary test fails on that count, fix the
implementation, not the expectation.

- [ ] **Step 5: Commit**

```bash
git add tools/gate-verify.mjs test/gate-verify.test.js
git commit -m "test(gate): verify a returned terminal trace offline"
```

---

### Task 4: The handoff runbook

**Files:**
- Create: `docs/ref/2026-08-24-macos-terminal-gate-handoff.md`
- Read for scaffolding: `.worktrees/macos-agent-handoff/docs/ref/2026-08-23-macos-agent-process-handoff.md`

**Interfaces:**
- Consumes: the tee from Task 2 and the verifier from Task 3.
- Produces: the document the tester executes on the physical Mac, and the artifact
  inventory they return.

- [ ] **Step 1: Read the existing handoff runbook end to end**

```bash
sed -n '1,646p' ../macos-agent-handoff/docs/ref/2026-08-23-macos-agent-process-handoff.md
```

Its sections 1 (checkout), 2 (private output and versions), 3 (configuration backup),
7 (artifact inventory), 8 (redaction), 9 (tester notes), 10 (restore), and 11 (send and
clean up) are directly reusable scaffolding, already corrected by one real run. Adapt
them; do not reinvent them. Sections 4–6 are replaced by this gate's own captures.

- [ ] **Step 2: Write the runbook skeleton and prerequisites**

Create `docs/ref/2026-08-24-macos-terminal-gate-handoff.md` with this section list, in
order: Prerequisites; 1 Check out and verify the disposable branch; 2 Prepare private
output and record versions; 3 Back up configuration; 4 Install the generated agent
configuration; 5 The Kitty/Ghostty matrix; 6 The capability `none` negative control;
7 The background and daemon appendix; 8 Validate the artifact inventory; 9 Redact;
10 Tester notes; 11 Restore configuration; 12 Send and clean up.

Prerequisites state: macOS 14+ on Apple Silicon; **Node 22 selected via nvm for the
whole matrix**, with the installed Node used only for the §5 spot-check cell;
authenticated Claude Code, Codex, and OpenCode; both Kitty.app and Ghostty.app; a
checkout path containing no spaces; and **no other agent session running on the machine
for the duration**, which the reap check in §5 depends on.

Carry the four guards from §11.7 of the spec verbatim into the runbook's own preamble:
the named-in-advance status-line failure, the ban on a shell loop variable called
`path`, version capture through command substitution only, and the run-scoped
environment gate on the hook command.

- [ ] **Step 3: Write section 1 and 2 — checkout, trace directory, versions**

Section 1 clones `spike/macos-terminal-gate`, runs `npm ci` and `npm test`, and records
`git rev-parse HEAD` against the commit named in the handoff message. The stop condition
names the known status-line failure as the single permitted failure.

Section 2 creates the private output root and enables the tee:

```sh
export FAMILIAR_NODE_TMP="$(node -e 'process.stdout.write(require("node:os").tmpdir())')"
export FAMILIAR_GATE_DIR="$FAMILIAR_NODE_TMP/familiar-macos-terminal-gate"
test ! -e "$FAMILIAR_GATE_DIR"
mkdir -m 700 "$FAMILIAR_GATE_DIR"
export FAMILIAR_TERMINAL=kitty          # or: ghostty
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/$FAMILIAR_TERMINAL.jsonl"
export FAMILIAR_GATE_ROOT="$(pwd -P)"
export FAMILIAR_GATE_BIN="$FAMILIAR_GATE_ROOT/bin/familiar"
test -x "$FAMILIAR_GATE_BIN"
```

`FAMILIAR_GATE_BIN` is the checkout's own `bin/familiar`, not whatever `npm link`
may have put on `PATH`; every later section invokes it by that variable.

Versions are captured exactly as the existing runbook's section 2 does it — **every
value through a command substitution**, never a bare command inside a redirected block.
Copy that block and add a `familiar-commit` and a `node-major` line.

- [ ] **Step 4: Write section 4 — install the generated configuration**

This is the first live exercise of `familiar setup codex`, so it is a step, not a
preamble:

```sh
"$FAMILIAR_GATE_BIN" setup claude-code > "$FAMILIAR_GATE_DIR/claude-code.json"
"$FAMILIAR_GATE_BIN" setup codex       > "$FAMILIAR_GATE_DIR/codex.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$FAMILIAR_GATE_DIR/claude-code.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$FAMILIAR_GATE_DIR/codex.json"
```

The runbook instructs the tester to merge `codex.json` into `~/.codex/hooks.json` and
`claude-code.json` into `~/.claude/settings.json` **without hand-editing either
command string**, since the generated encoding is what is under test, and to record
whether every one of Codex's six configured events fired at least once during the
matrix. It also runs `familiar install pets` and `familiar install opencode`, noting
that the OpenCode installer refuses a `.jsonc` config and prints the plugin path to add
by hand — the case the 2026-08-23 run hit.

- [ ] **Step 5: Write section 5 — the matrix**

For the current `$FAMILIAR_TERMINAL`, for each of Claude Code, Codex, and OpenCode, the
tester drives every state that adapter exposes and records what they saw. Include the
per-agent state lists from §11.2 of the spec verbatim — six for Claude Code, four for
Codex, five for OpenCode — and both expected-behaviour notes: Codex's `SessionStart`
fires at the first turn rather than at window open, and OpenCode's hook path sees no
tool events, so `working` comes from `session.busy`.

Claude Code's cell additionally requires the tester to confirm the status-line sprite is
visible, which is the only cell exercising the two-process `imageIdFor(sessionId)`
rendezvous.

Each cell ends with the two non-state checks. Normal exit:

```sh
# after quitting the session normally
grep -c '"code":"111"' "$FAMILIAR_GATE_TRACE"
```

Abnormal termination, as the exact four-step sequence from §11.2 — the ordering is the
evidence, so the runbook numbers it:

```sh
AGENT_PID=<the resolved agent pid>
kill -9 "$AGENT_PID"
# 1. the record must still be THERE. Any hook from any agent would prune it, which is
#    why no other session may be running.
python3 -m json.tool ~/.local/state/familiar/agents.json | tee "$FAMILIAR_GATE_DIR/before-reap-$FAMILIAR_TERMINAL.json"
# 2. reap must NAME the session it removed. Silence means it removed nothing.
"$FAMILIAR_GATE_BIN" reap | tee "$FAMILIAR_GATE_DIR/reap-$FAMILIAR_TERMINAL.txt"
# 3. and only now is absence meaningful.
python3 -m json.tool ~/.local/state/familiar/agents.json | tee "$FAMILIAR_GATE_DIR/after-reap-$FAMILIAR_TERMINAL.json"
```

State that the terminal stays tinted after the force-kill and that this is correct, not
a failure.

Finish the section with the Node spot-check: after the Kitty matrix completes under Node
22, switch to the machine's installed Node, repeat the Claude Code / Kitty cell alone
into `$FAMILIAR_GATE_DIR/spot-check.jsonl`, and switch back.

- [ ] **Step 6: Write section 6 — the negative control**

Run once, in Kitty, under Node 22:

```sh
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/capability-none.jsonl"
env -u KITTY_WINDOW_ID -u KITTY_PID -u TERM_PROGRAM \
    -u GHOSTTY_RESOURCES_DIR -u GHOSTTY_BIN_DIR \
    TERM=xterm-256color claude
```

The tester drives one ringing state and one normal exit, then repeats with `opencode`
in place of `claude` and `FAMILIAR_GATE_AGENT=opencode` exported, because the two
suppression sites are different code: the hook's `emit()` skips the graphics block,
while `sprite-plugin.tsx` returns before registering with the renderer. Required: the
window still tints and still rings, and no sprite appears in either. Codex is excluded —
it transmits no graphics for a `none` classification to suppress.

- [ ] **Step 7: Write section 7 — the background and daemon appendix**

Probe 1, in an interactive Claude Code session under Kitty: ask Claude Code to run a
long-lived shell command in the background, so a hook fires from inside the background
subtree. Immediately capture the chain:

```sh
LC_ALL=C /bin/ps -axo pid=,ppid=,tty=,lstart=,comm= > "$FAMILIAR_GATE_DIR/bg-comm.txt"
LC_ALL=C /bin/ps -axo pid=,ppid=,tty=,lstart=,command= > "$FAMILIAR_GATE_DIR/bg-command.txt"
```

Record all three possible outcomes explicitly, including "could not be induced on this
version", which is a finding rather than a failure. Instruct the tester to stop the
entire run and report immediately if any intermediate `claude` process shows a non-`??`
TTY: that is a wrong-target defect that halts the gate.

Probe 2, the fail-closed case. Write a LaunchAgent that runs one headless prompt with no
controlling terminal, load it once, and capture the hook's stderr:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.familiar.gate-probe.plist
launchctl kickstart -w gui/$(id -u)/dev.familiar.gate-probe
```

Required: the named `could not find the claude-code process` diagnostic in the captured
stderr, exit status zero, and **zero write records** in that run's trace. Unload and
delete the plist in section 11.

- [ ] **Step 8: Write sections 8 through 12 — inventory, redaction, notes, restore, send**

Adapt the existing runbook's sections 7–11. The inventory list for this gate is: one
trace per terminal, `spot-check.jsonl`, `capability-none.jsonl`, the probe-2 trace and
stderr, `bg-comm.txt` / `bg-command.txt`, the three reap files per terminal, `versions.txt`,
and the tester's notes. Redaction targets the same secret shapes the previous run swept
for (`sk-`, `ghp_`, `AKIA`, `Bearer`, `key=`/`token=`) plus `/Users/<name>`; the traces
themselves carry no payloads by construction, which the tester verifies by running:

```bash
node tools/gate-verify.mjs "$FAMILIAR_GATE_DIR/kitty.jsonl"
node tools/gate-verify.mjs "$FAMILIAR_GATE_DIR/ghostty.jsonl"
node tools/gate-verify.mjs "$FAMILIAR_GATE_DIR/capability-none.jsonl" none
```

Restoration restores `~/.claude/settings.json`, `~/.codex/hooks.json`, the OpenCode
config, and removes the LaunchAgent. The privacy rule is unchanged: the branch is never
pushed, and no raw artifact is ever committed.

- [ ] **Step 9: Verify the runbook has no unresolved placeholder**

```bash
grep -n 'TODO\|TBD\|<the resolved agent pid>\|XXX' docs/ref/2026-08-24-macos-terminal-gate-handoff.md
```

Expected: only the deliberate `<the resolved agent pid>` operator placeholder in
section 5, which the runbook must explain how to obtain — from the `target` record's
`pid` in the live trace, or from `ps`. Every other hit is a plan failure to fix.

- [ ] **Step 10: Commit**

```bash
git add docs/ref/2026-08-24-macos-terminal-gate-handoff.md
git commit -m "docs(gate): add the macOS terminal gate runbook"
```

---

### Task 5: Evidence skeleton and supersession

**Files:**
- Create: `docs/ref/2026-08-24-macos-terminal-smoke.md`
- Modify: `docs/superpowers/plans/2026-08-22-macos-process-runtime-and-ci.md`
- Modify: `src/adapters/codex.js`

**Interfaces:**
- Consumes: §11.2 and §11.6 of the spec.
- Produces: the note that receives the run's results, created before the run per §11.6.
- All work on `docs/macos-terminal-gate` in `.worktrees/macos-terminal-gate`.

- [ ] **Step 1: Create the evidence note with pending cells**

Create `docs/ref/2026-08-24-macos-terminal-smoke.md`:

```markdown
# macOS terminal promotion gate — evidence

**Status:** matrix recorded before execution, per §11.6 of the macOS core support
design. No cell has run. No claim in this file is promoted until its row says `pass`.

**Provenance**

- Capture branch: `spike/macos-terminal-gate`, disposable, never merged, never pushed.
- Runbook: `docs/ref/2026-08-24-macos-terminal-gate-handoff.md` on that branch.
- Host, OS, terminal, agent, and Node versions: pending.

## 1. Matrix

Under Node 22. A cell passes only when every state that adapter exposes was exercised
with its byte log verified and its tester observation recorded, the normal exit produced
`OSC 111`/`OSC 112`, and an abnormally terminated session was proven removed by
`familiar reap`.

| Agent | States exercised | Kitty | Ghostty |
| --- | --- | --- | --- |
| Claude Code | six | pending | pending |
| Codex | four; no `needs-input`, no `error` | pending | pending |
| OpenCode | five; no `needs-input` | pending | pending |

Node spot-check, installed Node, Claude Code / Kitty only: pending.

## 2. Capability `none` negative control

Required for any promotion (§11.3). Claude Code: pending. OpenCode: pending.

## 3. Background and daemon appendix

- Probe 1, induced background subtree: pending.
- Probe 2, headless fail-closed: pending.

## 4. Generated configuration

First live exercise of `familiar setup codex`. All six configured Codex events fired:
pending.

## 5. What this evidence does not cover

- macOS 14 with a live agent. CI runs macOS 14 without agents; this capture runs a
  later macOS. The gap §2 records stays open.
- tmux, Intel Macs, macOS 13, and terminals other than Kitty and Ghostty.
```

- [ ] **Step 2: Mark Task 7 of the process-runtime plan superseded**

In `docs/superpowers/plans/2026-08-22-macos-process-runtime-and-ci.md`, replace the
`### Task 7: Run the physical terminal promotion gate` heading line with:

```markdown
### Task 7: Run the physical terminal promotion gate — SUPERSEDED

**Superseded 2026-08-24** by `docs/superpowers/plans/2026-08-24-macos-terminal-gate.md`,
which specifies the evidence standard, the negative control, the cleanup proof, and the
background probes that this task's four steps left undefined. Do not execute the steps
below; they remain for history.
```

Also update that file's `**Implementation status**` block, which currently says Task 7
remains pending, to say Task 7 is superseded rather than pending.

- [ ] **Step 3: Verify the supersession reads correctly**

```bash
grep -n 'SUPERSEDED\|Task 7' docs/superpowers/plans/2026-08-22-macos-process-runtime-and-ci.md
```

Expected: the heading, the status block, and the Global Constraints reference all agree
that Task 7 is superseded.

- [ ] **Step 4: Commit the evidence skeleton and supersession**

```bash
git add docs/ref/2026-08-24-macos-terminal-smoke.md docs/superpowers/plans/2026-08-22-macos-process-runtime-and-ci.md
git commit -m "docs(macos): record the terminal gate matrix before running it"
```

- [ ] **Step 5: Fix the stale Codex title comment, alone**

In `src/adapters/codex.js`, the comment above `printsPlaceholderCells` claims "The
title, the identity tint and the bell still go out ... see osc.js". `osc.js` exports only
`oscBackground`, `oscCursor`, `oscReset`, and `BEL`; there is no title function, and two
emitter tests assert `\x1b]2;` is absent. Change that sentence to name only the tint and
the bell, and drop the title clause and its window-manager aside.

- [ ] **Step 6: Verify no other document repeats the claim**

```bash
grep -rn 'title' src/render/term/ src/adapters/ docs/install.md docs/surfaces.md | grep -iv 'entitle'
```

Expected: no remaining claim that Familiar emits or owns a terminal title. Fix any that
survive, in this same commit.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/codex.js
git commit -m "docs(adapters): drop the stale codex title claim"
```

---

### Task 6: Dispatch

**Files:**
- None created. This task produces the handoff message and, after the run, the
  verification of what comes back.

**Interfaces:**
- Consumes: every artifact from Tasks 1–5.

- [ ] **Step 1: Confirm both branches are clean and the spike branch is unpushed**

```bash
git -C .worktrees/macos-terminal-spike status --short
git -C .worktrees/macos-terminal-gate status --short
git -C .worktrees/macos-terminal-spike log --oneline main..spike/macos-terminal-gate
git branch -vv | grep macos-terminal
```

Expected: both worktrees clean, four commits on the spike branch, and **no upstream
tracking on `spike/macos-terminal-gate`**.

- [ ] **Step 2: Write the handoff message**

It names: the branch `spike/macos-terminal-gate` and the exact commit SHA; the runbook
path; that the run happens **twice**, `FAMILIAR_TERMINAL=kitty` then `ghostty`, with the
appendix and negative control run once under Kitty; that Node 22 is selected via nvm for
the matrix; that no other agent session may run on the machine during the reap checks;
that the branch must never be pushed and no raw artifact committed; and the artifact
list from Task 4 Step 8 to return.

- [ ] **Step 3: On return, verify the artifacts mechanically before reading the notes**

```bash
node tools/gate-verify.mjs <returned>/kitty.jsonl
node tools/gate-verify.mjs <returned>/ghostty.jsonl
node tools/gate-verify.mjs <returned>/capability-none.jsonl none
node tools/gate-verify.mjs <returned>/spot-check.jsonl
grep -c '"kind":"write"' <returned>/probe2.jsonl    # expected: 0
```

Verify independently of the tester's notes, as §8 of the 2026-08-23 evidence note did:
chain integrity in the probe-1 tables, the secret sweep, and agreement between each
`pass` claim and its trace.

- [ ] **Step 4: Fill in the evidence note and apply the promotion rule**

Replace every `pending` with `pass` or a concise failure. Then apply §11.6: any failing
cell means committing the evidence note alone with every provisional claim untouched; a
complete pass additionally updates the design's status and §14 and removes only the
matching provisional warnings from `docs/install.md`. A probe-1 result showing an
intermediate `claude` owning a TTY overrides everything and reopens the design.

- [ ] **Step 5: Commit the outcome**

For a failed or partial pass:

```bash
git add docs/ref/2026-08-24-macos-terminal-smoke.md
git commit -m "docs(macos): record terminal gate results"
```

For a complete pass:

```bash
git add docs/ref/2026-08-24-macos-terminal-smoke.md docs/install.md docs/specs/2026-08-22-macos-support-design.md
git commit -m "docs(macos): promote verified terminal support"
```

- [ ] **Step 6: Verify promoted claims against the evidence**

```bash
grep -n 'provisional\|verified\|tmux\|Intel\|macOS 13\|macOS 14' docs/install.md docs/specs/2026-08-22-macos-support-design.md docs/ref/2026-08-24-macos-terminal-smoke.md
git diff --check HEAD^..HEAD
```

Expected: every promoted claim has a passing evidence row; macOS 14 live-agent coverage,
tmux, Intel, macOS 13, and other terminals remain explicitly unclaimed.
