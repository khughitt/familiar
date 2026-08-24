# macOS Terminal Promotion Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the capture apparatus, runbook, and evidence skeleton that let one
physical-Mac session close the §11 terminal promotion gate and the background/daemon
resolver gap.

**Architecture:** A single opt-in tee at `writeAllSync` — the one choke point both the
hook's `emit()` and OpenCode's `sprite-plugin.tsx` already pass through — appends one
self-describing JSON record per terminal write. Each record holds what went out (escapes
decomposed into introducer, control keys, payload length, and digest) *and* what the
writer meant to send: the image id, the planned command count, the exact backdrop and
base, whether this state rings, whether this is the session-end restore. Every check is
therefore internal to one record, so nothing depends on correlating two — which is what
lets OpenCode's in-process writer participate at all. An offline verifier checks a
returned trace against the §11.1 contract. The tee and runbook live on a disposable
capture branch; only the reviewed evidence note reaches `main`.

**Tech Stack:** Node 22 ESM, `node:test`, `node:crypto`, Darwin `/bin/ps`, Kitty and
Ghostty, Claude Code / Codex / OpenCode.

**Spec:** `docs/specs/2026-08-22-macos-support-design.md` §§4, 10, 11.1–11.7, 14.

## Global Constraints

- Two branches, and they never mix. Tasks 1–4 land on `spike/macos-terminal-gate`
  (worktree `.worktrees/macos-terminal-spike`), which is **disposable and never merged**.
  Task 5 lands on `docs/macos-terminal-gate` (worktree `.worktrees/macos-terminal-gate`),
  which is intended for `main`.
- The capture branch is pushed to `origin` only as transport to the Mac, exactly as the
  2026-08-23 handoff was, and deleted from the remote once artifacts are received. The
  **tester** pushes nothing back — no branch, no capture, no amended commit. A `git
  bundle` is the offline alternative.
- The tee is instrumentation, not a feature. No `FAMILIAR_GATE_*` surface may appear in
  `HELP`, `docs/install.md`, or any document destined for `main`.
- The escape vocabulary is closed: `OSC 11`, `OSC 12`, `OSC 111`, `OSC 112`, `BEL`, and
  the Kitty graphics `APC`. Anything else fails the cell.
- Record `OSC 11`/`12`/`111`/`112` and `BEL` verbatim. Record every other payload —
  graphics and any out-of-vocabulary OSC — as length plus SHA-256 only.
- Every write record carries the writer's own expectation. A write reaching a terminal
  with no expectation attached is itself a violation, not an untested case.
- One trace file per cell (`<terminal>-<agent>.jsonl`), never one per terminal: shared
  files let one agent's restore satisfy another's missing one.
- The trace file is created mode 600, not merely placed in a private directory.
- The runbook uses `node` for JSON and bus inspection. Python is not a declared
  prerequisite and must not become one.
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
| `src/render/term/io.js` (modify) | Accepts a `trace` descriptor and calls `traceWrite` after the drain loop succeeds. |
| `src/render/term/emit.js` (modify) | Keeps the encoder metrics, and passes the `{ target, expect }` descriptor into `writeAllSync`. |
| `integrations/opencode/sprite-plugin.tsx` (modify) | Supplies its own descriptor; it is the writer that never reaches `emit()`. |
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
  `decomposeEscapes(bytes) -> Array<Escape>`, `traceWrite(fd, bytes, descriptor, options)`.
- Escape kinds: `{ k: 'BEL' }`, `{ k: 'OSC', code, payload }` for the four verbatim
  codes, `{ k: 'OSC', code, len, sha256 }` for any other code, `{ k: 'APC', keys, len,
  sha256 }`, `{ k: 'OTHER', hex }`, `{ k: 'UNTERMINATED', hex }`.
- Record: `{ t, pid, kind: 'write', agent, event, fd, target, targetRdev, fdRdev, len,
  expect, escapes }`.
- `expect` is `{ source, capability, state, rings, reset, imageId, backdrop, base,
  commands }`, where `source` is `'emit'` or `'opencode-sprite'`.
- All work on `spike/macos-terminal-gate` in `.worktrees/macos-terminal-spike`.

**Why one self-describing record.** An earlier draft emitted a separate `target` record
from `emit()` and correlated it with the write by pid. That failed three ways: it put an
`appendFileSync` between the resolver and the terminal write, so a trace fault could
suppress the output being measured; OpenCode's sprite plugin calls `writeAllSync`
directly from inside OpenCode and never reaches `emit()`, so it could never produce a
target to correlate against; and a record holding only bytes cannot check them against
anything, leaving the verifier able to confirm vocabulary but not the exact colours,
image id, or bell that §11.1 promises. Carrying the emitter's own expectation in the
same record fixes all three: the check is internal, and the writer that has no `emit()`
supplies its own expectation instead of being an unexplained gap.

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

// SPIKE-ONLY INSTRUMENTATION for the §11 terminal promotion gate. This file and its call
// sites are the entire tee; deleting it is how the instrumentation is removed. It must
// never reach main.
//
// One record per terminal write, carrying BOTH what went out and what the emitter meant to
// send. The verifier checks a record against itself, so nothing depends on correlating two
// records -- which matters because OpenCode's sprite plugin writes from inside OpenCode and
// never passes through emit().
//
// Every record is written AFTER the write it describes has already drained, so a fault here
// cannot suppress the output the gate exists to measure. Faults are not swallowed.

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

// `descriptor` is { target, expect } or null. A null descriptor still records the write --
// an untagged write reaching a terminal is itself something the verifier must see.
export function traceWrite(fd, bytes, descriptor = null, {
  env = process.env, now = () => new Date().toISOString(),
  appendFile = appendFileSync, fstat = fstatSync, stat = statSync,
} = {}) {
  const file = tracePath(env);
  if (file === null) return;

  let fdRdev = null;
  try { fdRdev = fstat(fd).rdev; } catch { fdRdev = null; }

  const target = descriptor?.target ?? null;
  let targetRdev = null;
  if (target !== null) {
    try { targetRdev = stat(target).rdev; } catch { targetRdev = null; }
  }

  const line = JSON.stringify({
    t: now(), pid: process.pid, kind: 'write',
    agent: context.agent, event: context.event,
    fd, target, targetRdev, fdRdev, len: bytes.length,
    expect: descriptor?.expect ?? null,
    escapes: decomposeEscapes(bytes),
  });
  // mode applies on creation only, which is when it matters: the trace must not be
  // world-readable even for the moment before anyone chmods it.
  appendFile(file, `${line}\n`, { mode: 0o600 });
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
import { setTraceContext, traceWrite, tracePath } from '../src/render/term/trace.js';

const EXPECT = {
  source: 'emit', capability: 'kitty-animation', state: 'needs-approval',
  rings: true, reset: false, imageId: 42, backdrop: '#1a1b26', base: '#e0af68',
  commands: 3,
};

test('nothing is written and nothing is stat-ed when the trace is not enabled', () => {
  let touched = 0;
  const bump = () => { touched += 1; throw new Error('must not be called'); };
  traceWrite(7, Buffer.from('x'), { target: '/dev/ttys004', expect: EXPECT },
    { env: {}, appendFile: bump, fstat: bump, stat: bump });
  assert.equal(touched, 0);
  assert.equal(tracePath({}), null);
});

test('a record carries the write, both device identities, and the emitter expectation', () => {
  setTraceContext({ agent: 'claude-code', event: 'PreToolUse' });
  const lines = [];
  traceWrite(7, Buffer.from(`\x1b]11;#1a1b26${ST}\x07`, 'binary'),
    { target: '/dev/ttys004', expect: EXPECT }, {
      env: { FAMILIAR_GATE_TRACE: '/tmp/t.jsonl' },
      now: () => 'T1',
      appendFile: (_file, line, options) => lines.push({ line: JSON.parse(line), options }),
      fstat: (fd) => { assert.equal(fd, 7); return { rdev: 268435460 }; },
      stat: (path) => { assert.equal(path, '/dev/ttys004'); return { rdev: 268435460 }; },
    });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].options, { mode: 0o600 });
  assert.deepEqual(lines[0].line, {
    t: 'T1', pid: process.pid, kind: 'write',
    agent: 'claude-code', event: 'PreToolUse',
    fd: 7, target: '/dev/ttys004', targetRdev: 268435460, fdRdev: 268435460, len: 15,
    expect: EXPECT,
    escapes: [{ k: 'OSC', code: '11', payload: '#1a1b26' }, { k: 'BEL' }],
  });
});

test('an in-process write with no target records a null target rather than inventing one', () => {
  const lines = [];
  const sprite = { source: 'opencode-sprite', capability: 'kitty-animation', state: null,
    rings: false, reset: false, imageId: 99, backdrop: null, base: null, commands: null };
  traceWrite(1, Buffer.from('\x07', 'binary'), { target: null, expect: sprite }, {
    env: { FAMILIAR_GATE_TRACE: '/tmp/t.jsonl' },
    now: () => 'T2',
    appendFile: (_file, line) => lines.push(JSON.parse(line)),
    fstat: () => ({ rdev: 268435461 }),
    stat: () => { throw new Error('must not stat a null target'); },
  });
  assert.equal(lines[0].target, null);
  assert.equal(lines[0].targetRdev, null);
  assert.equal(lines[0].fdRdev, 268435461);
  assert.equal(lines[0].expect.source, 'opencode-sprite');
});

test('an unstattable fd records a null device rather than failing the write path', () => {
  const lines = [];
  traceWrite(7, Buffer.from('\x07', 'binary'), null, {
    env: { FAMILIAR_GATE_TRACE: '/tmp/t.jsonl' },
    now: () => 'T3',
    appendFile: (_file, line) => lines.push(JSON.parse(line)),
    fstat: () => { throw new Error('EBADF'); },
  });
  assert.equal(lines[0].fdRdev, null);
  assert.equal(lines[0].expect, null);
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

### Task 2: Wire the tee into the three writers

**Files:**
- Modify: `src/render/term/io.js`
- Modify: `src/render/term/emit.js`
- Modify: `integrations/opencode/sprite-plugin.tsx`
- Modify: `bin/familiar`
- Modify: `test/term-io.test.js`
- Modify: `test/emit.test.js`

**Interfaces:**
- Consumes: `traceWrite`, `setTraceContext` from Task 1.
- Produces: `writeAllSync(bytes, { write, fd, trace })` where `trace` is the
  `{ target, expect }` descriptor or `null`.

- [ ] **Step 1: Write the failing io tests**

Append to `test/term-io.test.js`:

```js
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const traced = (fn) => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-')), 'trace.jsonl');
  process.env.FAMILIAR_GATE_TRACE = file;
  try { fn(); } finally { delete process.env.FAMILIAR_GATE_TRACE; }
  return file;
};
const readTrace = (file) =>
  readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a successful drain appends exactly one record carrying its descriptor', () => {
  const file = traced(() => {
    writeAllSync(Buffer.from('\x07'), {
      fd: 1,
      write: (_fd, _b, _o, len) => len,
      trace: { target: null, expect: { source: 'emit', rings: true } },
    });
  });
  const lines = readTrace(file);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].escapes, [{ k: 'BEL' }]);
  assert.equal(lines[0].expect.source, 'emit');
});

test('a short write that drains in three calls still traces once, not three times', () => {
  const accepts = [1, 1, 99];
  const file = traced(() => {
    writeAllSync(Buffer.from('abc'), {
      fd: 1,
      write: (_fd, _b, _o, len) => Math.min(accepts.shift(), len),
    });
  });
  assert.equal(readTrace(file).length, 1);
});

test('a failed write traces nothing, because there is no output to describe', () => {
  const file = traced(() => {
    assert.throws(() => writeAllSync(Buffer.from('x'), { fd: 1, write: () => 0 }));
  });
  assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/);
});

test('the trace file is created private to its owner', () => {
  const file = traced(() => {
    writeAllSync(Buffer.from('\x07'), { fd: 1, write: (_fd, _b, _o, len) => len });
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
node --test test/term-io.test.js
```

Expected: FAIL — the trace file is never created.

- [ ] **Step 3: Wire `io.js`**

In `src/render/term/io.js`, add the import and the `trace` option:

```js
import { writeSync } from 'node:fs';
import { traceWrite } from './trace.js';   // SPIKE-ONLY, see trace.js

export function writeAllSync(bytes, { write = writeSync, fd = 1, trace = null } = {}) {
```

and immediately before `return offset;`:

```js
  // AFTER the drain, never before: a trace fault must not be able to suppress the
  // terminal output this gate exists to measure. Inert unless FAMILIAR_GATE_TRACE is set.
  traceWrite(fd, bytes, trace);
  return offset;
```

- [ ] **Step 4: Run to verify they pass**

```bash
node --test test/term-io.test.js
```

Expected: PASS, including the five pre-existing tests.

- [ ] **Step 5: Write the failing emit expectation test**

Append to `test/emit.test.js`. `captureEmission` is the file's existing emit helper
(`test/emit.test.js:96`) and `KITTY_TERMINAL` its terminal fixture (line 66); reuse both.
Add `mkdtempSync` and `readFileSync` to the file's `node:fs` import — `tmpdir` and `join`
are already imported.

```js
test('emit records what it meant to send alongside what it sent', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-')), 'trace.jsonl');
  process.env.FAMILIAR_GATE_TRACE = file;
  try {
    captureEmission({ terminal: { ...KITTY_TERMINAL, path: '/dev/ttys004' } });
  } finally {
    delete process.env.FAMILIAR_GATE_TRACE;
  }
  const [record] = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(record.target, '/dev/ttys004');
  assert.equal(record.expect.source, 'emit');
  assert.equal(record.expect.capability, 'kitty-animation');
  assert.equal(record.expect.state, 'working');
  assert.equal(record.expect.rings, false);
  assert.equal(record.expect.reset, false);
  assert.equal(record.expect.imageId, imageIdFor(clipsIntent().sessionId));
  assert.equal(record.expect.backdrop, clipsIntent().color.backdrop);
  assert.equal(record.expect.base, clipsIntent().color.base);
  assert.ok(record.expect.commands > 0, 'the planned command count travels with the write');
});
```

Read `captureEmission` before writing this and use the state its default fixture actually
produces; the assertions above assume its default `next` is `working`. Correct the literal
to match the helper rather than changing the helper.

- [ ] **Step 6: Run to verify it fails**

```bash
node --test test/emit.test.js
```

Expected: FAIL — `record.expect` is `null`, because `emit` passes no descriptor.

- [ ] **Step 7: Wire `emit.js`**

Capture the encoder metrics rather than discarding them. Replace:

```js
    graphics = encode(program, {
      id: imageIdFor(intent.sessionId),
      placement,
      lifecycle,
      readFrame: readCachedFrame,
    }).bytes;
```

with:

```js
    const encoded = encode(program, {
      id: imageIdFor(intent.sessionId),
      placement,
      lifecycle,
      readFrame: readCachedFrame,
    });
    graphics = encoded.bytes;
    plannedCommands = encoded.metrics.commands;   // SPIKE-ONLY, see trace.js
```

Declare `let plannedCommands = null;` beside `let graphics = Buffer.alloc(0);`, and change
the write to carry the descriptor:

```js
    if (!checkTty(fd)) return;
    // SPIKE-ONLY. The expectation travels WITH the bytes so the verifier can check the
    // colours, the image id, the bell and the restore against what this call intended,
    // rather than against a guess reconstructed from the byte stream.
    return writeAllSync(bytes, { fd, write, trace: {
      target: terminal.path,
      expect: {
        source: 'emit',
        capability,
        state: nextState,
        rings: nextState !== null && RINGS.has(nextState),
        reset: nextState === null,
        imageId: graphics.length > 0 ? imageIdFor(intent.sessionId) : null,
        backdrop: nextState === null ? null : intent.color.backdrop,
        base: nextState === null ? null : intent.color.base,
        commands: plannedCommands,
      },
    } });
```

`RINGS` is already module-private in this file; do not export it.

- [ ] **Step 8: Run to verify it passes**

```bash
node --test test/emit.test.js
```

Expected: PASS.

- [ ] **Step 9: Give the OpenCode sprite plugin its own expectation**

In `integrations/opencode/sprite-plugin.tsx`, the runtime is constructed with
`writeTerminal: (output) => writeAllSync(Buffer.from(output))`. This is the writer that
never reaches `emit()`, so it supplies its own descriptor. Replace that line with:

```tsx
    // SPIKE-ONLY (src/render/term/trace.js). This writer is inside opencode, on its own
    // fd 1, so it has no emit() target to name -- it declares what it is instead.
    writeTerminal: (output) => writeAllSync(Buffer.from(output), {
      trace: {
        target: null,
        expect: {
          source: 'opencode-sprite',
          capability,
          state: null, rings: false, reset: false,
          imageId: imageIdFor(`opencode:${pid}`),
          backdrop: null, base: null, commands: null,
        },
      },
    }),
```

`capability`, `pid`, and `imageIdFor` are all already in scope in that function.

- [ ] **Step 10: Set the trace context in the hook branch**

In `bin/familiar`, add to the imports:

```js
import { setTraceContext } from '../src/render/term/trace.js';   // SPIKE-ONLY
```

Locate the `hook` branch (guarded by `command === 'hook'`, near the
`parseLeaf(rest, { help: 'hook' })` call at roughly line 681) and add, once `agent` and
the event name are in scope:

```js
    setTraceContext({ agent, event });
```

Read the surrounding lines first and use the variable names actually in scope.

- [ ] **Step 11: Run the full suite**

```bash
npm test
```

Expected: one pre-existing failure only — `a status line invocation makes exactly one
cheap git call`, the known cold-`git` `BRANCH_TIMEOUT_MS` timing failure recorded in §6
of `docs/ref/2026-08-23-macos-agent-process-spike.md`. Any other failure is a real
regression: stop and fix before committing.

- [ ] **Step 12: Commit**

```bash
git add src/render/term/io.js src/render/term/emit.js integrations/opencode/sprite-plugin.tsx bin/familiar test/term-io.test.js test/emit.test.js
git commit -m "test(gate): carry the emitter expectation into each traced write"
```

---

### Task 3: The offline verifier

**Files:**
- Create: `tools/gate-verify.mjs`
- Create: `test/gate-verify.test.js`

**Interfaces:**
- Consumes: records of the shape Task 1 produces.
- Produces: `verifyTrace(records, { expectRdev, requireRestore })` returning
  `{ violations: string[], summary: { agents, writes, apcChunks, bells, restores } }`,
  and a CLI exiting 1 when `violations` is non-empty.

- [ ] **Step 1: Write the failing verifier tests**

Create `test/gate-verify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyTrace } from '../tools/gate-verify.mjs';

const EXPECT = {
  source: 'emit', capability: 'kitty-animation', state: 'working',
  rings: false, reset: false, imageId: 42, backdrop: '#1a1b26', base: '#e0af68',
  commands: 1,
};
const tint = [
  { k: 'OSC', code: '11', payload: '#1a1b26' },
  { k: 'OSC', code: '12', payload: '#e0af68' },
];
const apc = (keys) => ({ k: 'APC', keys, len: 10, sha256: 'x' });
const rec = (escapes, expect = {}, over = {}) => ({
  t: 'T', pid: 1, kind: 'write', agent: 'claude-code', event: 'PreToolUse',
  fd: 7, target: '/dev/ttys004', targetRdev: 268435460, fdRdev: 268435460,
  len: 1, expect: { ...EXPECT, ...expect }, escapes, ...over,
});
const noRestore = { requireRestore: false };

test('a write matching its own expectation has no violations', () => {
  const { violations } = verifyTrace([rec([apc('a=t,f=100,i=42'), ...tint])], noRestore);
  assert.deepEqual(violations, []);
});

test('an fd on a different device than the opened target is a violation', () => {
  // A tint-only write, so the device mismatch is the ONLY thing that can fail here.
  const noGraphics = { imageId: null, commands: null };
  const { violations } = verifyTrace([rec([...tint], noGraphics, { fdRdev: 999 })], noRestore);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rdev 999/);
});

test('two null devices are not a match', () => {
  const { violations } = verifyTrace(
    [rec([...tint], {}, { fdRdev: null, targetRdev: null })], noRestore,
  );
  assert.ok(violations.some((v) => /no device identity/.test(v)));
});

test('an in-process write is checked against the expected device instead of a target', () => {
  const sprite = { source: 'opencode-sprite', rings: false, backdrop: null, base: null, commands: null };
  const base = { target: null, targetRdev: null, fdRdev: 268435460 };
  assert.deepEqual(
    verifyTrace([rec([apc('a=t,i=42')], sprite, base)], { ...noRestore, expectRdev: 268435460 }).violations,
    [],
  );
  assert.match(
    verifyTrace([rec([apc('a=t,i=42')], sprite, base)], { ...noRestore, expectRdev: 111 }).violations[0],
    /expected 111/,
  );
});

test('the tint must carry the exact theme colours, not merely be present', () => {
  const wrong = [{ k: 'OSC', code: '11', payload: '#000000' }, { k: 'OSC', code: '12', payload: '#e0af68' }];
  const { violations } = verifyTrace([rec([apc('a=t,i=42'), ...wrong])], noRestore);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /OSC 11 .*expected #1a1b26/);
});

test('a graphics id that is not the expected image id fails', () => {
  const { violations } = verifyTrace([rec([apc('a=t,i=7'), ...tint])], noRestore);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /not the expected 42/);
});

test('fewer graphics commands than the encoder planned fails', () => {
  const { violations } = verifyTrace(
    [rec([apc('a=t,i=42'), ...tint], { commands: 3 })], noRestore,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /1 graphics commands, planned 3/);
});

test('a bell is required for a ringing state and forbidden otherwise', () => {
  assert.deepEqual(
    verifyTrace([rec([apc('a=t,i=42'), ...tint, { k: 'BEL' }],
      { state: 'needs-approval', rings: true })], noRestore).violations,
    [],
  );
  assert.match(
    verifyTrace([rec([apc('a=t,i=42'), ...tint],
      { state: 'needs-approval', rings: true })], noRestore).violations[0],
    /0 bells/,
  );
  assert.match(
    verifyTrace([rec([apc('a=t,i=42'), ...tint, { k: 'BEL' }])], noRestore).violations[0],
    /1 bells/,
  );
});

test('a session end must restore both background and cursor', () => {
  const end = { reset: true, imageId: null, backdrop: null, base: null, commands: null, state: null };
  const both = [{ k: 'OSC', code: '111', payload: '' }, { k: 'OSC', code: '112', payload: '' }];
  assert.deepEqual(verifyTrace([rec(both, end)]).violations, []);
  assert.match(
    verifyTrace([rec([both[0], both[0]], end)]).violations[0],
    /112=false/,
  );
});

test('a restore outside a session end is a violation', () => {
  const { violations } = verifyTrace(
    [rec([{ k: 'OSC', code: '111', payload: '' }, { k: 'OSC', code: '112', payload: '' }])],
    noRestore,
  );
  assert.ok(violations.some((v) => /outside a session-end/.test(v)));
});

test('a cell trace with no restore at all fails, which is the point of requireRestore', () => {
  const { violations } = verifyTrace([rec([apc('a=t,i=42'), ...tint])]);
  assert.ok(violations.some((v) => /never restored/.test(v)));
});

test('graphics under capability none fail, and tint must survive', () => {
  const none = { capability: 'none', imageId: null, commands: null };
  assert.deepEqual(verifyTrace([rec([...tint], none)], noRestore).violations, []);
  assert.match(
    verifyTrace([rec([apc('a=t,i=42'), ...tint], none)], noRestore).violations[0],
    /capability none/,
  );
  assert.match(
    verifyTrace([rec([{ k: 'BEL' }], { ...none, rings: true })], noRestore).violations[0],
    /OSC 11 was null/,
  );
});

test('out-of-vocabulary, unterminated and untagged writes each fail', () => {
  const out = verifyTrace([
    rec([{ k: 'OTHER', hex: '6869' }]),
    rec([{ k: 'UNTERMINATED', hex: '1b5d' }]),
    rec([{ k: 'OSC', code: '2', len: 4, sha256: 'x' }]),
    rec([...tint], undefined, { expect: null }),
  ], noRestore);
  assert.ok(out.violations.some((v) => /out-of-vocabulary bytes/.test(v)));
  assert.ok(out.violations.some((v) => /unterminated/.test(v)));
  assert.ok(out.violations.some((v) => /OSC 2/.test(v)));
  assert.ok(out.violations.some((v) => /no expectation/.test(v)));
});

test('the summary counts what a reviewer reads first', () => {
  const end = { reset: true, imageId: null, backdrop: null, base: null, commands: null, state: null };
  const { summary } = verifyTrace([
    rec([apc('a=t,i=42,m=1'), apc('m=0'), ...tint], { commands: 2 }),
    rec([...tint, { k: 'BEL' }], { state: 'error', rings: true, imageId: null, commands: null }),
    rec([{ k: 'OSC', code: '111', payload: '' }, { k: 'OSC', code: '112', payload: '' }], end),
  ]);
  assert.deepEqual(summary, {
    agents: ['claude-code'], writes: 3, apcChunks: 2, bells: 1, restores: 1,
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
// docs/specs/2026-08-22-macos-support-design.md §11.1. Every check is internal to one
// record: the emitter's own expectation travels with the bytes it produced, so this
// never has to reconstruct intent from the byte stream or correlate two records.

export function verifyTrace(records, { expectRdev = null, requireRestore = true } = {}) {
  const violations = [];
  const agents = new Set();
  let writes = 0, apcChunks = 0, bells = 0, restores = 0;

  for (const record of records) {
    if (record.agent) agents.add(record.agent);
    if (record.kind !== 'write') { violations.push(`unknown record kind ${record.kind}`); continue; }
    writes += 1;

    const expect = record.expect;
    const where = `${record.agent ?? 'unknown'}/${record.event ?? expect?.source ?? '?'}`;
    if (expect === null || expect === undefined) {
      violations.push(`${where}: a write reached a terminal with no expectation attached`);
      continue;
    }

    // --- device identity. Two nulls are not a match. ---
    if (record.fdRdev === null || record.fdRdev === undefined) {
      violations.push(`${where}: the written fd has no device identity`);
    } else if (record.target !== null && record.target !== undefined) {
      if (record.targetRdev === null || record.targetRdev === undefined) {
        violations.push(`${where}: target ${record.target} could not be identified`);
      } else if (record.targetRdev !== record.fdRdev) {
        violations.push(
          `${where}: wrote to rdev ${record.fdRdev}, but opened ${record.target} ` +
          `(rdev ${record.targetRdev})`,
        );
      }
    } else if (expectRdev !== null && record.fdRdev !== expectRdev) {
      violations.push(
        `${where}: in-process write reached rdev ${record.fdRdev}, expected ${expectRdev}`,
      );
    }

    // --- decompose what actually went out ---
    let firstAction = null, apcCount = 0, bel = 0;
    let osc11 = null, osc12 = null, has111 = false, has112 = false;
    for (const escape of record.escapes) {
      if (escape.k === 'BEL') { bel += 1; continue; }
      if (escape.k === 'OTHER') { violations.push(`${where}: out-of-vocabulary bytes ${escape.hex}`); continue; }
      if (escape.k === 'UNTERMINATED') { violations.push(`${where}: unterminated escape ${escape.hex}`); continue; }
      if (escape.k === 'APC') {
        apcCount += 1;
        // Only a chunk carrying an action names the image; continuations carry m= alone.
        if (firstAction === null && /(^|,)a=/.test(escape.keys)) firstAction = escape.keys;
        continue;
      }
      if (escape.k === 'OSC') {
        if (escape.code === '11') osc11 = escape.payload;
        else if (escape.code === '12') osc12 = escape.payload;
        else if (escape.code === '111') has111 = true;
        else if (escape.code === '112') has112 = true;
        else violations.push(`${where}: OSC ${escape.code} is outside the closed vocabulary`);
        continue;
      }
      violations.push(`${where}: unknown escape kind ${escape.k}`);
    }
    apcChunks += apcCount;
    bells += bel;

    // --- graphics against the plan ---
    if (expect.capability === 'none') {
      if (apcCount > 0) violations.push(`${where}: graphics emitted under capability none`);
    } else if (expect.imageId !== null && expect.imageId !== undefined) {
      if (apcCount === 0) {
        violations.push(`${where}: expected graphics for image ${expect.imageId}, none transmitted`);
      } else if (firstAction === null) {
        violations.push(`${where}: graphics carried no action chunk to name the image`);
      } else if (!new RegExp(`(^|,)i=${expect.imageId}(,|$)`).test(firstAction)) {
        violations.push(
          `${where}: graphics id in "${firstAction}" is not the expected ${expect.imageId}`,
        );
      }
      if (expect.commands !== null && expect.commands !== undefined && apcCount !== expect.commands) {
        violations.push(`${where}: ${apcCount} graphics commands, planned ${expect.commands}`);
      }
    }

    // --- tint: the exact colours the theme chose ---
    if (expect.backdrop !== null && expect.backdrop !== undefined && osc11 !== expect.backdrop) {
      violations.push(`${where}: OSC 11 was ${osc11 === null ? 'null' : osc11}, expected ${expect.backdrop}`);
    }
    if (expect.base !== null && expect.base !== undefined && osc12 !== expect.base) {
      violations.push(`${where}: OSC 12 was ${osc12 === null ? 'null' : osc12}, expected ${expect.base}`);
    }

    // --- bell: state-specific, in both directions ---
    if (expect.source === 'emit') {
      const wanted = expect.rings ? 1 : 0;
      if (bel !== wanted) {
        violations.push(
          `${where}: ${bel} bells for state ${JSON.stringify(expect.state ?? null)}, expected ${wanted}`,
        );
      }
    }

    // --- restore: both halves, and only at a session end ---
    if (expect.reset) {
      if (has111 && has112) restores += 1;
      else violations.push(`${where}: session end must restore both, saw 111=${has111} 112=${has112}`);
    } else if (has111 || has112) {
      violations.push(`${where}: colour restore outside a session-end transition`);
    }
  }

  if (requireRestore && writes > 0 && restores === 0) {
    violations.push('this cell never restored colours: no session-end write is present');
  }

  return { violations, summary: { agents: [...agents], writes, apcChunks, bells, restores } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    process.stderr.write(
      'usage: gate-verify.mjs <trace.jsonl> [--expect-rdev N] [--no-require-restore]\n',
    );
    process.exit(2);
  }
  const rdevAt = args.indexOf('--expect-rdev');
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { violations, summary } = verifyTrace(records, {
    expectRdev: rdevAt === -1 ? null : Number(args[rdevAt + 1]),
    requireRestore: !args.includes('--no-require-restore'),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  for (const violation of violations) process.stdout.write(`VIOLATION ${violation}\n`);
  process.exit(violations.length === 0 ? 0 : 1);
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
node --test test/gate-verify.test.js
```

Expected: PASS, 14 tests.

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
- Produces: the document the tester executes, and the artifact inventory they return.

**One trace file per cell, not per terminal.** `FAMILIAR_GATE_TRACE` is re-exported for
every agent, so each cell's evidence is separately attributable and separately
verifiable. A single per-terminal trace would let one agent's restore satisfy another's
missing one, and `gate-verify`'s `requireRestore` check would become meaningless.

- [ ] **Step 1: Read the existing handoff runbook end to end**

```bash
sed -n '1,646p' ../macos-agent-handoff/docs/ref/2026-08-23-macos-agent-process-handoff.md
```

Its sections 1 (checkout), 2 (private output and versions), 3 (configuration backup),
7 (artifact inventory), 8 (redaction), 9 (tester notes), 10 (restore), and 11 (send and
clean up) are reusable scaffolding, already corrected by one real run. Adapt them; do
not reinvent them. Sections 4–6 are replaced by this gate's own captures.

- [ ] **Step 2: Write the prerequisites and the transport instruction**

Create `docs/ref/2026-08-24-macos-terminal-gate-handoff.md` with this section list:
Prerequisites; 1 Check out and verify the capture branch; 2 Prepare private output and
record versions; 3 Back up configuration; 4 Install the generated agent configuration;
5 The Kitty/Ghostty matrix; 6 The capability `none` negative control; 7 The background
and daemon appendix; 8 Validate the artifact inventory; 9 Redact; 10 Tester notes;
11 Restore configuration; 12 Send and clean up.

Prerequisites state: macOS 14+ on Apple Silicon; **Node 22 selected via nvm for the whole
matrix**, with the installed Node used only for the §5 spot-check cell; authenticated
Claude Code, Codex, and OpenCode; both Kitty.app and Ghostty.app; a checkout path
containing no spaces; and **no other agent session running on the machine for the
duration**, which the reap check in §5 depends on.

Transport, stated explicitly because the branch is otherwise unreachable: the author
pushes `spike/macos-terminal-gate` to `origin` for the duration of the run, exactly as
the 2026-08-23 handoff did — its section 1 clones from GitHub. The tester clones it and
**never pushes anything back**: no branch, no capture, no amended commit. The author
deletes the remote branch once the artifacts are received. If pushing the branch is not
acceptable for a given run, the alternative is `git bundle create familiar-gate.bundle
spike/macos-terminal-gate` transferred out of band, and the runbook's section 1 clones
from the bundle instead.

Carry the four guards from §11.7 of the spec verbatim into the runbook's preamble: the
named-in-advance status-line failure, the ban on a shell loop variable called `path`,
version capture through command substitution only, and the run-scoped environment gate
on the hook command.

- [ ] **Step 3: Write sections 1 and 2 — checkout, private output, versions**

Section 1 clones the capture branch, runs `npm ci` and `npm test`, and records
`git rev-parse HEAD` against the commit named in the handoff message. The stop condition
names the known status-line failure as the single permitted failure.

Section 2:

```sh
export FAMILIAR_NODE_TMP="$(node -e 'process.stdout.write(require("node:os").tmpdir())')"
export FAMILIAR_GATE_DIR="$FAMILIAR_NODE_TMP/familiar-macos-terminal-gate"
test ! -e "$FAMILIAR_GATE_DIR"
mkdir -m 700 "$FAMILIAR_GATE_DIR"
export FAMILIAR_GATE_ROOT="$(pwd -P)"
export FAMILIAR_GATE_BIN="$FAMILIAR_GATE_ROOT/bin/familiar"
test -x "$FAMILIAR_GATE_BIN"
export FAMILIAR_TERMINAL=kitty          # or: ghostty
```

`FAMILIAR_GATE_BIN` is this checkout's own `bin/familiar`, not whatever `npm link` may
have put on `PATH`; every later section invokes it by that variable. `FAMILIAR_GATE_TRACE`
is deliberately **not** set here — it is set per cell in section 5.

Versions are captured exactly as the existing runbook's section 2 does it — every value
through a command substitution, never a bare command inside a redirected block. Copy that
block and add `familiar-commit` and `node-major` lines.

Record the device the matrix expects, which the verifier needs for OpenCode's in-process
writes:

```sh
export FAMILIAR_GATE_RDEV="$(node -e 'process.stdout.write(String(require("node:fs").fstatSync(1).rdev))')"
printf 'terminal-rdev=%s\n' "$FAMILIAR_GATE_RDEV" >> "$FAMILIAR_GATE_DIR/versions.txt"
```

- [ ] **Step 4: Write section 4 — install the generated configuration**

This is the first live exercise of `familiar setup codex`, so it is a step, not a
preamble. Validation uses Node, which is already a prerequisite:

```sh
"$FAMILIAR_GATE_BIN" setup claude-code > "$FAMILIAR_GATE_DIR/claude-code.json"
"$FAMILIAR_GATE_BIN" setup codex       > "$FAMILIAR_GATE_DIR/codex.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$FAMILIAR_GATE_DIR/claude-code.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$FAMILIAR_GATE_DIR/codex.json"
```

The tester merges `codex.json` into `~/.codex/hooks.json` and `claude-code.json` into
`~/.claude/settings.json` **without hand-editing either command string**, since the
generated encoding is what is under test, and records whether every one of Codex's six
configured events fired at least once during the matrix. This section also runs
`familiar install pets` and `familiar install opencode`, noting that the OpenCode
installer refuses a `.jsonc` config and prints the plugin path to add by hand — the case
the 2026-08-23 run hit.

- [ ] **Step 5: Write section 5 — the matrix, one trace per cell**

For the current `$FAMILIAR_TERMINAL`, for each agent in turn:

```sh
export FAMILIAR_GATE_AGENT=claude-code        # then codex, then opencode
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/$FAMILIAR_TERMINAL-$FAMILIAR_GATE_AGENT.jsonl"
```

Include the per-agent state lists from §11.2 of the spec verbatim — six for Claude Code,
four for Codex, five for OpenCode — and both expected-behaviour notes: Codex's
`SessionStart` fires at the first turn rather than at window open, and OpenCode's hook
path sees no tool events, so `working` comes from `session.busy`. Claude Code's cell
additionally requires the tester to confirm the status-line sprite is visible, the only
cell exercising the two-process `imageIdFor(sessionId)` rendezvous.

Each cell ends with the two non-state checks. Normal exit is checked by the verifier
rather than by grep, because the verifier is what knows a restore needs both halves:

```sh
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_TRACE"
```

Expected: exit 0. A `never restored colours` violation means the session-end transition
did not happen or did not restore both background and cursor.

Abnormal termination, as the four-step sequence from §11.2. Every artifact is scoped to
the agent as well as the terminal, so one cell cannot overwrite another's proof:

```sh
CELL="$FAMILIAR_TERMINAL-$FAMILIAR_GATE_AGENT"
AGENT_PID=<the resolved agent pid>       # from the target field of this cell's trace
kill -9 "$AGENT_PID"
# 1. the record must still be THERE. Any hook from any agent would prune it, which is
#    why no other session may be running.
cp ~/.local/state/familiar/agents.json "$FAMILIAR_GATE_DIR/before-reap-$CELL.json"
node -e 'const a=require(process.argv[1]);if(!Object.keys(a).length)throw new Error("bus already empty: the kill was not abnormal, or another hook pruned it")' "$FAMILIAR_GATE_DIR/before-reap-$CELL.json"
# 2. reap must NAME the session it removed. Silence means it removed nothing.
"$FAMILIAR_GATE_BIN" reap | tee "$FAMILIAR_GATE_DIR/reap-$CELL.txt"
test -s "$FAMILIAR_GATE_DIR/reap-$CELL.txt"
# 3. and only now is absence meaningful.
cp ~/.local/state/familiar/agents.json "$FAMILIAR_GATE_DIR/after-reap-$CELL.json"
```

To obtain `AGENT_PID`, read the last `target` device and pid from this cell's trace:

```sh
node -e '
const fs=require("node:fs");
const rows=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);
console.log(rows.at(-1).target, rows.at(-1).pid);
' "$FAMILIAR_GATE_TRACE"
```

That prints the hook's pid, not the agent's; the agent pid is the one `reap` names and
the one visible in `agents.json`. State that the terminal stays tinted after the
force-kill and that this is correct, not a failure.

Finish the section with the Node spot-check: after the Kitty matrix completes under Node
22, switch to the machine's installed Node, repeat the Claude Code / Kitty cell alone
into `$FAMILIAR_GATE_DIR/spot-check.jsonl`, and switch back.

- [ ] **Step 6: Write section 6 — the negative control**

Run once, in Kitty, under Node 22:

```sh
export FAMILIAR_GATE_AGENT=claude-code
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/capability-none-claude-code.jsonl"
env -u KITTY_WINDOW_ID -u KITTY_PID -u TERM_PROGRAM \
    -u GHOSTTY_RESOURCES_DIR -u GHOSTTY_BIN_DIR \
    TERM=xterm-256color claude
```

The tester drives one ringing state and one normal exit, then repeats with `opencode` in
place of `claude`, `FAMILIAR_GATE_AGENT=opencode`, and its own
`capability-none-opencode.jsonl`. The two suppression sites are different code: the
hook's `emit()` skips the graphics block, while `sprite-plugin.tsx` returns before
registering with the renderer. Required: the window still tints and still rings, and no
sprite appears in either. Codex is excluded — it transmits no graphics for a `none`
classification to suppress.

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

Probe 2, the fail-closed case. A LaunchAgent running one headless prompt with no
controlling terminal, its own trace, and its stderr captured:

```sh
export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/probe2.jsonl"
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.familiar.gate-probe.plist
launchctl kickstart -w gui/$(id -u)/dev.familiar.gate-probe
```

The plist sets `FAMILIAR_GATE_TRACE` and `StandardErrorPath` itself, since it inherits no
shell environment; write it out in full in the runbook. Required: the named `could not
find the claude-code process` diagnostic in the captured stderr, exit status zero, and
**zero records** in `probe2.jsonl`. Unload and delete the plist in section 11.

- [ ] **Step 8: Write sections 8 through 12 — inventory, redaction, notes, restore, send**

Adapt the existing runbook's sections 7–11. The inventory for this gate is: six cell
traces (`{kitty,ghostty}-{claude-code,codex,opencode}.jsonl`), `spot-check.jsonl`, the two
`capability-none-*.jsonl`, `probe2.jsonl` and its stderr, `bg-comm.txt` and
`bg-command.txt`, three reap artifacts per cell, `versions.txt`, and the tester's notes.

The tester runs the verifier over every trace before sending, and records each result:

```bash
for cell in kitty-claude-code kitty-codex kitty-opencode \
            ghostty-claude-code ghostty-codex ghostty-opencode; do
  node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_DIR/$cell.jsonl" \
    --expect-rdev "$FAMILIAR_GATE_RDEV"
done
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_DIR/capability-none-claude-code.jsonl"
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_DIR/capability-none-opencode.jsonl" --no-require-restore
```

Note that `--expect-rdev` differs per terminal window: capture it per run in section 2
and use that run's value. Redaction targets the same secret shapes the previous run swept
for (`sk-`, `ghp_`, `AKIA`, `Bearer`, `key=`/`token=`) plus `/Users/<name>`; the traces
carry no payloads by construction, which the verifier's clean exit corroborates.

Restoration restores `~/.claude/settings.json`, `~/.codex/hooks.json`, the OpenCode
config, and removes the LaunchAgent. The privacy rule: the tester pushes nothing, and no
raw artifact is ever committed.

- [ ] **Step 9: Verify the runbook has no unresolved placeholder**

```bash
grep -n 'TODO\|TBD\|XXX' docs/ref/2026-08-24-macos-terminal-gate-handoff.md
```

Expected: no hits. The one operator placeholder, `<the resolved agent pid>`, must be
accompanied by the command that obtains it.

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
