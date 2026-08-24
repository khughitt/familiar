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
- The escape vocabulary is closed: `OSC 11`, `OSC 12`, `OSC 111`, `OSC 112`, `BEL`, the
  Kitty graphics `APC`, and — for the OpenCode sprite writer alone — the placement
  envelope `ESC 7`, one `CSI <row>;<col> H`, and `ESC 8`. Anything else fails the cell,
  and the envelope appearing in a hook write is itself a failure.
- Nothing the code under test reports about itself may be the only check on that thing.
  Capability and terminal device are asserted from outside; the ringing-state set lives
  in the verifier, taken from the design rather than from `emit.js`.
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

test('the opencode placement envelope is recognised, not dumped into OTHER', () => {
  // Exactly what integrations/opencode/sprite.js placeAt() produces.
  const bytes = Buffer.from(`\x1b7\x1b[12;3H\x1b_Ga=p,i=99,p=1,c=8,r=4,q=2,C=1${ST}\x1b8`, 'binary');
  assert.deepEqual(decomposeEscapes(bytes), [
    { k: 'ESC', code: '7' },
    { k: 'CSI', params: '12;3', final: 'H' },
    { k: 'APC', keys: 'a=p,i=99,p=1,c=8,r=4,q=2,C=1', len: 0, sha256: sha('') },
    { k: 'ESC', code: '8' },
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

// Sticky, so a multi-megabyte graphics buffer is not re-sliced on every scan step.
const CSI = /\x1b\[([0-9;]*)([A-Za-z])/y;

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

    // THE OPENCODE PLACEMENT ENVELOPE. integrations/opencode/sprite.js placeAt() wraps its
    // APC in DECSC, one absolute cursor move, and DECRC, so the visible cursor returns to
    // where OpenTUI left it. Recognised narrowly -- these three forms and nothing else --
    // because the alternative is every visible OpenCode placement landing in OTHER.
    if (text.startsWith('\x1b7', i)) { out.push({ k: 'ESC', code: '7' }); i += 2; continue; }
    if (text.startsWith('\x1b8', i)) { out.push({ k: 'ESC', code: '8' }); i += 2; continue; }
    CSI.lastIndex = i;
    const csi = CSI.exec(text);
    if (csi) {
      out.push({ k: 'CSI', params: csi[1], final: csi[2] });
      i = CSI.lastIndex;
      continue;
    }

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

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the record-writer tests**

Append to `test/gate-trace.test.js`:

```js
import { setTraceContext, traceWrite, tracePath } from '../src/render/term/trace.js';

const EXPECT = {
  source: 'emit', capability: 'kitty-animation', state: 'needs-approval',
  reset: false, imageId: 42, backdrop: '#1a1b26', base: '#e0af68',
  commands: 3, frames: 2, placement: { cols: 8, rows: 4 },
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
    reset: false, imageId: 99, backdrop: null, base: null,
    commands: null, frames: null, placement: null };
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

Expected: PASS, 11 tests. The `len: 15` literal is the byte count of
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
      trace: { target: null, expect: { source: 'emit', state: 'working' } },
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
  assert.equal(record.expect.reset, false);
  assert.equal(record.expect.rings, undefined, 'the ringing decision belongs to the verifier');
  assert.equal(record.expect.imageId, imageIdFor(clipsIntent().sessionId));
  assert.equal(record.expect.backdrop, clipsIntent().color.backdrop);
  assert.equal(record.expect.base, clipsIntent().color.base);
  assert.ok(record.expect.commands > 0, 'the encoder command count travels with the write');
  assert.ok(record.expect.frames >= 1, 'the PROGRAM frame count travels with the write');
  assert.ok(record.expect.placement.rows >= 1 && record.expect.placement.cols >= 1);
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
    // SPIKE-ONLY, see trace.js. `commands` comes from the encoder and can only prove that
    // no bytes were lost between encoding and the terminal. `frames` and `placement` come
    // from the PROGRAM and the sprite -- planAnimation and boxFor, neither of which the
    // encoder produced -- so they are the checks that can actually catch a wrong encoding.
    plannedCommands = encoded.metrics.commands;
    plannedFrames = Array.isArray(program.frames) ? program.frames.length : 1;
    plannedPlacement = { cols: placement.cols, rows: placement.rows };
```

Declare `let plannedCommands = null, plannedFrames = null, plannedPlacement = null;` beside
`let graphics = Buffer.alloc(0);`, and change the write to carry the descriptor:

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
        reset: nextState === null,
        imageId: graphics.length > 0 ? imageIdFor(intent.sessionId) : null,
        backdrop: nextState === null ? null : intent.color.backdrop,
        base: nextState === null ? null : intent.color.base,
        commands: plannedCommands,
        frames: plannedFrames,
        placement: plannedPlacement,
      },
    } });
```

**No `rings` field, deliberately.** Recording "this state rings" from the same `RINGS` set
that decides whether to emit the bell would make the bell check circular: change `RINGS`
and both sides change together. The record carries `state` only, and the verifier owns its
own ringing set, taken from the design rather than from the code under test. `RINGS` stays
module-private here; do not export it.

The event-to-state mapping itself is **out of this gate's scope** and is not independently
checked here — it is covered by each adapter's unit tests in CI. What this gate checks is
that the state the emitter acted on produced the right bytes on the right device.

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
          state: null, reset: false,
          imageId: imageIdFor(`opencode:${pid}`),
          backdrop: null, base: null,
          // The runtime plans and encodes inside sprite-runtime.js, so these are not
          // available here. OpenCode graphics are therefore checked for image identity,
          // key grammar, and placement-envelope shape only -- not frame count. The
          // evidence note must say so rather than implying parity with the hook path.
          commands: null, frames: null, placement: null,
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
  reset: false, imageId: 42, backdrop: '#1a1b26', base: '#e0af68',
  commands: 1, frames: null, placement: null,
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
const noGraphics = { imageId: null, commands: null };

test('a write matching its own expectation has no violations', () => {
  const { violations } = verifyTrace([rec([apc('a=t,f=100,i=42'), ...tint])], noRestore);
  assert.deepEqual(violations, []);
});

test('an fd on a different device than the opened target is a violation', () => {
  const { violations } = verifyTrace([rec([...tint], noGraphics, { fdRdev: 999 })], noRestore);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rdev 999/);
});

test('two null devices are not a match', () => {
  const { violations } = verifyTrace(
    [rec([...tint], noGraphics, { fdRdev: null, targetRdev: null })], noRestore,
  );
  assert.ok(violations.some((v) => /no device identity/.test(v)));
});

test("the run's terminal constrains hook writes too, not only in-process ones", () => {
  // A resolver that picked the wrong tty opens it AND writes to it, so target === fd.
  // Only the externally captured device catches that.
  const consistentlyWrong = { target: '/dev/ttys009', targetRdev: 111, fdRdev: 111 };
  const { violations } = verifyTrace(
    [rec([...tint], noGraphics, consistentlyWrong)],
    { ...noRestore, expectRdev: 268435460 },
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /this run's terminal is 268435460/);
});

test('an in-process write is checked against the expected device instead of a target', () => {
  const sprite = { source: 'opencode-sprite', backdrop: null, base: null, commands: null };
  const base = { target: null, targetRdev: null, fdRdev: 268435460 };
  assert.deepEqual(
    verifyTrace([rec([apc('a=t,i=42')], sprite, base)], { ...noRestore, expectRdev: 268435460 }).violations,
    [],
  );
  assert.match(
    verifyTrace([rec([apc('a=t,i=42')], sprite, base)], { ...noRestore, expectRdev: 111 }).violations[0],
    /this run's terminal is 111/,
  );
});

test('the tint must carry the exact theme colours, not merely be present', () => {
  const wrong = [{ k: 'OSC', code: '11', payload: '#000000' }, { k: 'OSC', code: '12', payload: '#e0af68' }];
  const { violations } = verifyTrace([rec([apc('a=t,i=42'), ...wrong])], noRestore);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /OSC 11 .*expected #1a1b26/);
});

test('every chunk must address the expected image, not just the first', () => {
  const { violations } = verifyTrace(
    [rec([apc('a=t,i=42'), apc('a=d,d=i,i=7'), ...tint], { commands: 2 })], noRestore,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /addresses image 7, expected 42/);
});

test('malformed graphics keys fail whatever they would decode to', () => {
  // An empty pair. Not `a=t;i=42` -- splitBody cuts on the first `;`, so a key string
  // the parser produced can never contain one, and testing that would test nothing.
  const { violations } = verifyTrace([rec([apc('a=t,,i=42'), ...tint])], noRestore);
  assert.ok(violations.some((v) => /malformed graphics keys/.test(v)));
});

test('graphics chunks lost between the encoder and the terminal are caught', () => {
  const { violations } = verifyTrace(
    [rec([apc('a=t,i=42'), ...tint], { commands: 3 })], noRestore,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /1 graphics chunks reached the terminal, encoder produced 3/);
});

test('the placement box must be the one boxFor computed from the sprite', () => {
  const placed = (c, r) => rec(
    [apc(`a=T,U=1,f=100,i=42,c=${c},r=${r}`), ...tint],
    { placement: { cols: 8, rows: 4 } },
  );
  assert.deepEqual(verifyTrace([placed(8, 4)], noRestore).violations, []);
  assert.match(verifyTrace([placed(9, 4)], noRestore).violations[0], /placed 9x4 cells/);
});

test('the bell is decided from the recorded state, not from a flag the writer set', () => {
  assert.deepEqual(
    verifyTrace([rec([apc('a=t,i=42'), ...tint, { k: 'BEL' }],
      { state: 'needs-approval' })], noRestore).violations,
    [],
  );
  assert.match(
    verifyTrace([rec([apc('a=t,i=42'), ...tint], { state: 'needs-approval' })], noRestore).violations[0],
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
  assert.match(verifyTrace([rec([both[0], both[0]], end)]).violations[0], /112=false/);
});

test('a restore outside a session end is a violation', () => {
  const { violations } = verifyTrace(
    [rec([{ k: 'OSC', code: '111', payload: '' }, { k: 'OSC', code: '112', payload: '' }], noGraphics)],
    noRestore,
  );
  assert.ok(violations.some((v) => /outside a session-end/.test(v)));
});

test('a cell trace with no restore at all fails, which is the point of requireRestore', () => {
  const { violations } = verifyTrace([rec([apc('a=t,i=42'), ...tint])]);
  assert.ok(violations.some((v) => /never restored/.test(v)));
});

test('capability is asserted from outside, so a broken marker scrub cannot pass itself', () => {
  const none = { capability: 'none', imageId: null, commands: null };
  const asNone = { ...noRestore, expectCapability: 'none' };

  assert.deepEqual(verifyTrace([rec([...tint], none)], asNone).violations, []);

  // Graphics under a self-reported `none` is caught either way.
  assert.match(
    verifyTrace([rec([apc('a=t,i=42'), ...tint], none)], asNone).violations[0],
    /capability none/,
  );

  // THE CASE THE EXTERNAL ASSERTION EXISTS FOR: the scrub failed, so the writer
  // classified as graphics-capable and its output agrees with its own expectation.
  const scrubFailed = verifyTrace([rec([apc('a=t,i=42'), ...tint])], asNone);
  assert.match(scrubFailed.violations[0], /required to classify as "none"/);

  // Tint must survive degradation.
  assert.match(
    verifyTrace([rec([{ k: 'BEL' }], { ...none, state: 'error' })], asNone).violations[0],
    /OSC 11 was null/,
  );
});

test('a transmission addressed to no image fails', () => {
  // `a=t` is well-formed and sets firstAction, but names nothing.
  const { violations } = verifyTrace([rec([apc('a=t'), ...tint])], noRestore);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no graphics chunk carried an image id, expected 42/);
});

test('the opencode placement envelope is accepted there and refused anywhere else', () => {
  const envelope = [
    { k: 'ESC', code: '7' },
    { k: 'CSI', params: '12;3', final: 'H' },
    apc('a=p,i=42,p=1,c=8,r=4,q=2,C=1'),
    { k: 'ESC', code: '8' },
  ];
  const sprite = { source: 'opencode-sprite', backdrop: null, base: null, commands: null };
  const inProcess = { target: null, targetRdev: null };
  assert.deepEqual(verifyTrace([rec(envelope, sprite, inProcess)], noRestore).violations, []);

  // Bare APCs outside an envelope are fine: hidePlacement and freeImage are unwrapped.
  assert.deepEqual(
    verifyTrace([rec([apc('a=d,d=i,i=42,p=1,q=2')], sprite, inProcess)], noRestore).violations,
    [],
  );

  // The hook never moves the cursor. If it did, that is a real defect.
  assert.match(
    verifyTrace([rec(envelope, noGraphics)], noRestore).violations[0],
    /cursor control from a non-sprite writer/,
  );

  // Anything else wearing the envelope's clothes is refused.
  assert.match(
    verifyTrace([rec([{ k: 'CSI', params: '2', final: 'J' }], sprite, inProcess)], noRestore).violations[0],
    /not part of the placement envelope/,
  );
});

test('the envelope is checked as a sequence, so counting saves and restores cannot save it', () => {
  const sprite = { source: 'opencode-sprite', backdrop: null, base: null, commands: null };
  const inProcess = { target: null, targetRdev: null };
  const problems = (escapes) =>
    verifyTrace([rec(escapes, sprite, inProcess)], noRestore).violations.join(' | ');

  // THE CASE COUNTING MISSES: perfectly balanced, and the cursor is left where the
  // sprite put it.
  const reversed = [
    { k: 'ESC', code: '8' },
    { k: 'CSI', params: '12;3', final: 'H' },
    apc('a=p,i=42'),
    { k: 'ESC', code: '7' },
  ];
  assert.match(problems(reversed), /restore with no matching save/);
  assert.match(problems(reversed), /never closed/);

  // No move at all: the placement lands wherever the cursor happened to be.
  assert.match(
    problems([{ k: 'ESC', code: '7' }, apc('a=p,i=42'), { k: 'ESC', code: '8' }]),
    /wrote before moving the cursor/,
  );

  // Unclosed, and nested.
  assert.match(
    problems([{ k: 'ESC', code: '7' }, { k: 'CSI', params: '1;1', final: 'H' }, apc('a=p,i=42')]),
    /never closed/,
  );
  assert.match(
    problems([{ k: 'ESC', code: '7' }, { k: 'ESC', code: '7' }]),
    /nested placement envelope/,
  );

  // A delete inside an envelope built to place: balanced, ordered, and still wrong.
  assert.match(
    problems([
      { k: 'ESC', code: '7' }, { k: 'CSI', params: '1;1', final: 'H' },
      apc('a=d,d=i,i=42'), { k: 'ESC', code: '8' },
    ]),
    /non-placement command/,
  );

  // Two placements inside one envelope, and two envelopes in one write. sprite-runtime
  // calls writeTerminal once per builder, so neither shape is one it can produce.
  const one = [
    { k: 'ESC', code: '7' }, { k: 'CSI', params: '1;1', final: 'H' },
    apc('a=p,i=42'), { k: 'ESC', code: '8' },
  ];
  assert.match(
    problems([...one.slice(0, 3), apc('a=p,i=42'), { k: 'ESC', code: '8' }]),
    /carried 2 placement commands/,
  );
  assert.match(problems([...one, ...one]), /2 placement envelopes in one write/);
});

test('out-of-vocabulary, unterminated and untagged writes each fail', () => {
  const out = verifyTrace([
    rec([{ k: 'OTHER', hex: '6869' }], noGraphics),
    rec([{ k: 'UNTERMINATED', hex: '1b5d' }], noGraphics),
    rec([{ k: 'OSC', code: '2', len: 4, sha256: 'x' }], noGraphics),
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
    rec([...tint, { k: 'BEL' }], { state: 'error', imageId: null, commands: null }),
    rec([{ k: 'OSC', code: '111', payload: '' }, { k: 'OSC', code: '112', payload: '' }], end),
  ]);
  assert.deepEqual(summary, {
    agents: ['claude-code'], writes: 3, apcChunks: 2, bells: 1, restores: 1,
  });
});
```

- [ ] **Step 1b: Write the golden test against real encoder output**

The checks above are hand-written key strings. One test proves the verifier accepts what
`encodeKittyProgram` actually produces, which is the only thing that can catch a grammar
this plan guessed wrong. Append to `test/gate-verify.test.js`:

```js
import { decomposeEscapes } from '../src/render/term/trace.js';
import { encodeKittyProgram } from '../src/render/term/kitty-animation.js';
import { imageIdFor } from '../src/render/term/placeholder.js';

test('real encoder output satisfies the verifier, and a corrupted id does not', () => {
  // Reuse whatever program fixture test/kitty-animation.test.js already builds rather
  // than inventing a second one; read that file and lift its smallest animation case.
  const { program, root, readFrame, rows } = smallestAnimationFixture();
  const id = imageIdFor('session-under-test');
  const placement = { kind: 'virtual', ...boxFor(readFrame(root), rows) };
  const encoded = encodeKittyProgram(program, { id, placement, lifecycle: 'create', readFrame });

  const expect = {
    source: 'emit', capability: 'kitty-animation', state: 'working', reset: false,
    imageId: id, backdrop: null, base: null,
    commands: encoded.metrics.commands,
    frames: program.frames.length,
    placement: { cols: placement.cols, rows: placement.rows },
  };
  const record = {
    t: 'T', pid: 1, kind: 'write', agent: 'claude-code', event: 'PreToolUse',
    fd: 7, target: '/dev/ttys004', targetRdev: 1, fdRdev: 1,
    len: encoded.bytes.length, expect, escapes: decomposeEscapes(encoded.bytes),
  };
  assert.deepEqual(verifyTrace([record], { requireRestore: false }).violations, []);

  // Corrupt one non-first chunk's image id: the id-set check must catch it.
  const corrupted = { ...record, escapes: record.escapes.map((e, index) =>
    (e.k === 'APC' && index > 0 && /i=\d+/.test(e.keys)
      ? { ...e, keys: e.keys.replace(/i=\d+/, 'i=1') }
      : e)) };
  const { violations } = verifyTrace([corrupted], { requireRestore: false });
  assert.ok(violations.some((v) => /addresses image 1/.test(v)));
});
```

Write `smallestAnimationFixture()` by lifting the existing fixture construction from
`test/kitty-animation.test.js` — read that file first and reuse its clip set, root sprite,
and `readFrame` stub. Import `boxFor` from `../src/render/term/box.js`. If the corruption
test finds no APC chunk past index 0 carrying an id, the fixture is a single-chunk static
program: pick a larger one so the chunked path is exercised.

**What this gate does not check.** Frame-by-frame sequence validation is deliberately
absent. Reimplementing the encoder's chunking rules inside the verifier would produce a
second copy of the encoder, and a copy of a thing is not an independent check of it. The
golden test above covers the real byte stream end to end; `frames` is recorded in every
trace as reviewable evidence; and the independent checks that can catch a wrong encoding —
image identity across every chunk, key grammar, and the `boxFor` placement box — are
implemented above. The evidence note states this limit rather than implying parity.

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

// The ringing states, taken from the DESIGN (§11.2), not from emit.js. If this list and
// emit.js's RINGS ever disagree, the gate fails -- which is the entire point of not
// letting the code under test tell us what it was supposed to do.
const RINGING = new Set(['needs-input', 'needs-approval', 'error']);

// APC control keys are `k=v` pairs. Anything else is malformed, whatever it decodes to.
const KEYS = /^[A-Za-z]=[^,]*(,[A-Za-z]=[^,]*)*$/;

// The only cursor control the OpenCode placement envelope may contain: an absolute move
// with a row and a column (integrations/opencode/sprite.js placeAt).
const CUP = /^\d+;\d+$/;

// The envelope contract is a SEQUENCE with fixed contents: save, exactly one absolute
// move, exactly one `a=p` placement, restore -- which is precisely what placeAt() emits.
// Counting saves against restores accepts `ESC8, CSI, APC, ESC7`, which balances perfectly
// and leaves the cursor exactly where the sprite put it: the visible bug. Accepting any
// APC in the placement slot accepts `ESC7, CSI, a=d, ESC8`, which deletes from inside an
// envelope built to place. Bare APCs OUTSIDE an envelope are correct and expected:
// hidePlacement and freeImage are unwrapped (integrations/opencode/sprite-runtime.js).
export function envelopeProblems(escapes) {
  const problems = [];
  let state = 'outside';
  let envelopes = 0, placed = 0;
  const save = (e) => e.k === 'ESC' && e.code === '7';
  const restore = (e) => e.k === 'ESC' && e.code === '8';
  const move = (e) => e.k === 'CSI';
  const isPlacement = (e) => /(^|,)a=p(,|$)/.test(e.keys);

  const close = () => {
    if (placed !== 1) {
      problems.push(`placement envelope carried ${placed} placement commands, expected exactly one`);
    }
    state = 'outside';
  };

  for (const escape of escapes) {
    if (state === 'outside') {
      if (save(escape)) { state = 'saved'; envelopes += 1; placed = 0; continue; }
      if (move(escape)) { problems.push('cursor move outside a placement envelope'); continue; }
      if (restore(escape)) { problems.push('cursor restore with no matching save'); continue; }
      continue;   // bare APCs out here are hidePlacement and freeImage, which are unwrapped
    }
    if (save(escape)) { problems.push('nested placement envelope'); continue; }

    if (state === 'saved') {
      if (move(escape)) { state = 'moved'; continue; }
      if (restore(escape)) { problems.push('placement envelope contained no cursor move'); close(); continue; }
      problems.push('placement envelope wrote before moving the cursor');
      state = 'placing';
      if (escape.k === 'APC') { placed += 1; if (!isPlacement(escape)) problems.push(`placement envelope carries a non-placement command ${JSON.stringify(escape.keys)}`); }
      continue;
    }
    if (state === 'moved') {
      if (move(escape)) { problems.push('placement envelope moved the cursor twice'); continue; }
      if (restore(escape)) { close(); continue; }
      if (escape.k === 'APC') {
        state = 'placing';
        placed += 1;
        // placeAt() emits `a=p` and nothing else. An `a=d` here would delete inside an
        // envelope built to place, which is not a thing this renderer does.
        if (!isPlacement(escape)) {
          problems.push(`placement envelope carries a non-placement command ${JSON.stringify(escape.keys)}`);
        }
        continue;
      }
      problems.push(`unexpected ${escape.k} inside a placement envelope`);
      continue;
    }
    if (move(escape)) { problems.push('placement envelope moved the cursor after placing'); continue; }
    if (restore(escape)) { close(); continue; }
    if (escape.k === 'APC') {
      placed += 1;
      if (!isPlacement(escape)) {
        problems.push(`placement envelope carries a non-placement command ${JSON.stringify(escape.keys)}`);
      }
      continue;
    }
    problems.push(`unexpected ${escape.k} inside a placement envelope`);
  }
  if (state !== 'outside') problems.push('placement envelope was never closed');
  // sprite-runtime.js calls writeTerminal once per builder: one placeAt, or one
  // hidePlacement, or one freeImage. Two envelopes in one write is not a shape it produces.
  if (envelopes > 1) problems.push(`${envelopes} placement envelopes in one write, expected one`);
  return problems;
}

export function verifyTrace(records, {
  expectRdev = null, expectCapability = null, requireRestore = true,
} = {}) {
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
    const sprite = expect.source === 'opencode-sprite';

    // --- capability, asserted from OUTSIDE. Without this the negative control would be
    // --- checking the classifier against itself: a broken marker scrub classifies as
    // --- graphics-capable, emits graphics, and agrees with its own expectation.
    if (expectCapability !== null && expect.capability !== expectCapability) {
      violations.push(
        `${where}: classified as ${JSON.stringify(expect.capability)}, but this run was ` +
        `required to classify as ${JSON.stringify(expectCapability)}`,
      );
    }

    // --- device identity. Two nulls are not a match, and the externally captured device
    // --- constrains EVERY write: target === fd only proves emit wrote to what it opened,
    // --- which a resolver that picked the wrong tty also satisfies.
    if (record.fdRdev === null || record.fdRdev === undefined) {
      violations.push(`${where}: the written fd has no device identity`);
    } else {
      if (record.target !== null && record.target !== undefined) {
        if (record.targetRdev === null || record.targetRdev === undefined) {
          violations.push(`${where}: target ${record.target} could not be identified`);
        } else if (record.targetRdev !== record.fdRdev) {
          violations.push(
            `${where}: wrote to rdev ${record.fdRdev}, but opened ${record.target} ` +
            `(rdev ${record.targetRdev})`,
          );
        }
      }
      if (expectRdev !== null && record.fdRdev !== expectRdev) {
        violations.push(
          `${where}: reached rdev ${record.fdRdev}, but this run's terminal is ${expectRdev}`,
        );
      }
    }

    // --- decompose what actually went out ---
    let firstAction = null, apcCount = 0, bel = 0;
    let osc11 = null, osc12 = null, has111 = false, has112 = false;
    const ids = new Set();
    for (const escape of record.escapes) {
      if (escape.k === 'BEL') { bel += 1; continue; }
      if (escape.k === 'OTHER') { violations.push(`${where}: out-of-vocabulary bytes ${escape.hex}`); continue; }
      if (escape.k === 'UNTERMINATED') { violations.push(`${where}: unterminated escape ${escape.hex}`); continue; }

      if (escape.k === 'ESC' || escape.k === 'CSI') {
        // The placement envelope belongs to opencode's renderer alone. The hook's emit()
        // never moves the cursor, and a cursor move appearing there would be a real defect.
        if (!sprite) {
          violations.push(`${where}: cursor control from a non-sprite writer`);
          continue;
        }
        const known = (escape.k === 'ESC' && (escape.code === '7' || escape.code === '8'))
          || (escape.k === 'CSI' && escape.final === 'H' && CUP.test(escape.params));
        if (!known) {
          violations.push(
            `${where}: ${escape.k} ${JSON.stringify(escape.code ?? `${escape.params}${escape.final}`)} ` +
            'is not part of the placement envelope',
          );
        }
        continue;   // ORDER is checked separately, below; counting these proves nothing.
      }

      if (escape.k === 'APC') {
        apcCount += 1;
        if (!KEYS.test(escape.keys)) {
          violations.push(`${where}: malformed graphics keys ${JSON.stringify(escape.keys)}`);
        }
        const id = /(^|,)i=(\d+)(,|$)/.exec(escape.keys);
        if (id) ids.add(Number(id[2]));
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

    // --- the envelope must occur in ORDER, not merely in equal numbers ---
    if (sprite) {
      for (const problem of envelopeProblems(record.escapes)) {
        violations.push(`${where}: ${problem}`);
      }
    }

    // --- graphics against the plan ---
    if (expect.capability === 'none') {
      if (apcCount > 0) violations.push(`${where}: graphics emitted under capability none`);
    } else if (expect.imageId !== null && expect.imageId !== undefined) {
      if (apcCount === 0) {
        violations.push(`${where}: expected graphics for image ${expect.imageId}, none transmitted`);
      } else if (firstAction === null) {
        violations.push(`${where}: graphics carried no action chunk to name the image`);
      }
      // At least one chunk must NAME the image. `a=t` alone is well-formed, sets
      // firstAction, and leaves the id set empty -- so a transmission addressed to no
      // image would otherwise pass every other check.
      if (apcCount > 0 && ids.size === 0) {
        violations.push(`${where}: no graphics chunk carried an image id, expected ${expect.imageId}`);
      }
      // EVERY id, not just the first: a later chunk addressing another image would place
      // or delete something that is not ours.
      for (const id of ids) {
        if (id !== expect.imageId) {
          violations.push(`${where}: graphics chunk addresses image ${id}, expected ${expect.imageId}`);
        }
      }
      if (expect.commands !== null && expect.commands !== undefined && apcCount !== expect.commands) {
        // Byte integrity between encoder and terminal, not an independent check of the
        // encoder: `commands` is the encoder's own count.
        violations.push(`${where}: ${apcCount} graphics chunks reached the terminal, encoder produced ${expect.commands}`);
      }
      // Placement comes from boxFor(sprite, theme rows) -- neither the encoder nor the
      // trace produced it -- so this IS independent of the code that wrote the bytes.
      if (expect.placement && firstAction !== null && /(^|,)a=[tT](,|$)/.test(firstAction)) {
        const cols = /(^|,)c=(\d+)(,|$)/.exec(firstAction);
        const rows = /(^|,)r=(\d+)(,|$)/.exec(firstAction);
        if (!cols || !rows) {
          violations.push(`${where}: transmit chunk "${firstAction}" carries no placement box`);
        } else if (Number(cols[2]) !== expect.placement.cols || Number(rows[2]) !== expect.placement.rows) {
          violations.push(
            `${where}: placed ${cols[2]}x${rows[2]} cells, the sprite box is ` +
            `${expect.placement.cols}x${expect.placement.rows}`,
          );
        }
      }
    }

    // --- tint: the exact colours the theme chose ---
    if (expect.backdrop !== null && expect.backdrop !== undefined && osc11 !== expect.backdrop) {
      violations.push(`${where}: OSC 11 was ${osc11 === null ? 'null' : osc11}, expected ${expect.backdrop}`);
    }
    if (expect.base !== null && expect.base !== undefined && osc12 !== expect.base) {
      violations.push(`${where}: OSC 12 was ${osc12 === null ? 'null' : osc12}, expected ${expect.base}`);
    }

    // --- bell: decided HERE from the recorded state, never from a flag the writer set ---
    if (!sprite) {
      const wanted = expect.state !== null && RINGING.has(expect.state) ? 1 : 0;
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
      'usage: gate-verify.mjs <trace.jsonl> [--expect-rdev N] ' +
      '[--expect-capability none|static-graphics|kitty-animation] [--no-require-restore]\n',
    );
    process.exit(2);
  }
  const rdevAt = args.indexOf('--expect-rdev');
  const capAt = args.indexOf('--expect-capability');
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { violations, summary } = verifyTrace(records, {
    expectRdev: rdevAt === -1 ? null : Number(args[rdevAt + 1]),
    expectCapability: capAt === -1 ? null : args[capAt + 1],
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

Expected: PASS, 21 tests — the 20 from Step 1 plus Step 1b's golden test.

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
# The Kitty run and the Ghostty run share this directory ON PURPOSE: section 8's
# inventory needs all six cell traces together. So it is created once and reused, and
# what must not already exist is a per-cell FILE, checked in section 5.
mkdir -p -m 700 "$FAMILIAR_GATE_DIR"
chmod 700 "$FAMILIAR_GATE_DIR"
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
block, write it to `$FAMILIAR_GATE_VERSIONS` rather than a shared `versions.txt` (the two
runs share one directory), and add `familiar-commit` and `node-major` lines.

Record the device the matrix expects, which the verifier needs for OpenCode's in-process
writes:

```sh
export FAMILIAR_GATE_RDEV="$(node -e 'process.stdout.write(String(require("node:fs").fstatSync(1).rdev))')"
case "$FAMILIAR_TERMINAL" in
  kitty)   export FAMILIAR_GATE_CAPABILITY=kitty-animation ;;
  ghostty) export FAMILIAR_GATE_CAPABILITY=static-graphics ;;
esac
export FAMILIAR_GATE_VERSIONS="$FAMILIAR_GATE_DIR/versions-$FAMILIAR_TERMINAL.txt"
printf 'terminal-rdev=%s\n' "$FAMILIAR_GATE_RDEV" >> "$FAMILIAR_GATE_VERSIONS"
printf 'expected-capability=%s\n' "$FAMILIAR_GATE_CAPABILITY" >> "$FAMILIAR_GATE_VERSIONS"
```

Both values are asserted **from outside** when the traces are verified. The capability in
particular must not be taken from Familiar's own classification: that is precisely what
the section 6 negative control is testing.

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
test ! -e "$FAMILIAR_GATE_TRACE"      # never append to a previous attempt's evidence
```

If that `test` fails, move the earlier file aside under a new name; do not delete it and
do not append to it.

Include the per-agent state lists from §11.2 of the spec verbatim — six for Claude Code,
four for Codex, five for OpenCode — and both expected-behaviour notes: Codex's
`SessionStart` fires at the first turn rather than at window open, and OpenCode's hook
path sees no tool events, so `working` comes from `session.busy`. Claude Code's cell
additionally requires the tester to confirm the status-line sprite is visible, the only
cell exercising the two-process `imageIdFor(sessionId)` rendezvous.

Each cell ends with the two non-state checks. Normal exit is checked by the verifier
rather than by grep, because the verifier is what knows a restore needs both halves:

```sh
node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_TRACE" \
  --expect-rdev "$FAMILIAR_GATE_RDEV" \
  --expect-capability "$FAMILIAR_GATE_CAPABILITY"
```

Expected: exit 0. A `never restored colours` violation means the session-end transition
did not happen or did not restore both background and cursor. A `this run's terminal is`
violation means bytes reached a device that is not this window — the wrong-target failure
the whole gate exists to catch.

`FAMILIAR_GATE_CAPABILITY` is set once per terminal in section 2, from the terminal being
tested rather than from anything Familiar computed: `kitty-animation` for Kitty,
`static-graphics` for Ghostty.

Abnormal termination, as the four-step sequence from §11.2. The normal-exit check above
ended the cell's session, so **start a fresh one first**: launch the agent again in the
same window, drive it to any state so it reaches the bus, and leave it running.

The session is then identified before the kill, and that same identity is carried through
every step. A nonempty bus and a nonempty `reap` line prove nothing on their own, because
either could belong to a different session:

```sh
CELL="$FAMILIAR_TERMINAL-$FAMILIAR_GATE_AGENT"
BUS=~/.local/state/familiar/agents.json
SESSION_FILE="$FAMILIAR_GATE_DIR/reap-session-$CELL.json"
PID_FILE="$FAMILIAR_GATE_DIR/reap-pid-$CELL.txt"

# 0. Name the session and verify the process identity BEFORE anything is killed.
#
#    The session id is written as JSON, not as a line: it arrives verbatim from the
#    agent's payload, which accepts any non-empty string (src/adapters/payload.js), so it
#    may contain whitespace or newlines. Every later comparison decodes this file and
#    compares the exact string in Node. `eval` on it would be a command injection hole,
#    and line-oriented tools would silently mangle it.
#
#    Identity is pid PLUS starttime, which is Familiar's own definition
#    (src/bus/transaction.js: "A pid alone is a number the kernel reuses; the pair is a
#    process"). Comparing the stored start time against a fresh reading is what makes
#    `kill -9` safe: a recycled pid now owned by another instance of the same agent has
#    the same basename and would pass a `comm` check.
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { startTimeOf } from "./src/bus/proc.js";

const [busPath, sessionOut, pidOut] = process.argv.slice(2);
const bus = JSON.parse(readFileSync(busPath, "utf8"));
const ids = Object.keys(bus);
if (ids.length !== 1) {
  throw new Error(`expected exactly one live session, found ${ids.length}`);
}
const record = bus[ids[0]];
if (!Number.isInteger(record.pid) || record.pid <= 1) {
  throw new Error(`refusing to name pid ${JSON.stringify(record.pid)} as a kill target`);
}
const fresh = startTimeOf(record.pid);
if (fresh !== record.starttime) {
  throw new Error(
    `pid ${record.pid} start time is ${fresh}, the bus recorded ${record.starttime}: ` +
    "this pid has been recycled and is NOT the agent. Do not kill it."
  );
}
writeFileSync(sessionOut, JSON.stringify(ids[0]));
writeFileSync(pidOut, `${record.pid}\n`);
process.stdout.write(`session verified, pid ${record.pid} starttime ${fresh}\n`);
' "$BUS" "$SESSION_FILE" "$PID_FILE" | tee "$FAMILIAR_GATE_DIR/reap-identity-$CELL.txt"

AGENT_PID="$(cat "$PID_FILE")"
case "$AGENT_PID" in ''|*[!0-9]*) printf 'not a pid: %s\n' "$AGENT_PID" >&2; exit 1 ;; esac

# 0b. Record what that pid is, for the evidence and for a human sanity check.
ps -p "$AGENT_PID" -o pid=,comm= | tee "$FAMILIAR_GATE_DIR/reap-target-$CELL.txt"
```

The start-time comparison is the guard; the `ps` line is corroboration for the reader.
Its basename should be the agent under test — `claude`, `codex`, or `opencode`. If step 0
threw, do not continue and do not kill anything.

```sh
kill -9 "$AGENT_PID"

# 1. THAT session must still be on the bus. Any hook from any agent would have pruned
#    it, which is why exactly one session may be live during this check.
cp "$BUS" "$FAMILIAR_GATE_DIR/before-reap-$CELL.json"

# 2. reap must name THAT session.
"$FAMILIAR_GATE_BIN" reap | tee "$FAMILIAR_GATE_DIR/reap-$CELL.txt"

# 3. and THAT session must be the one now absent.
cp "$BUS" "$FAMILIAR_GATE_DIR/after-reap-$CELL.json"

# All three comparisons in Node, against the exact decoded id. No shell, no grep: a
# session id is agent-supplied text and is neither a pattern nor a line.
node -e '
const fs = require("node:fs");
const [beforePath, reapPath, afterPath, sessionPath] = process.argv.slice(2);
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
const reaped = fs.readFileSync(reapPath, "utf8");
if (!(session in before)) throw new Error("the session was already gone before reap ran");
// Whole-string equality. `reap`'s eviction lines go to stderr (bin/familiar
// reportEvictions), so the tee'd stdout is exactly its `reaped <ids>` line and nothing
// else -- and with exactly one live session that line is fully determined. Equality also
// survives an id containing a newline, which the payload contract permits.
if (reaped !== `reaped ${session}\n`) {
  throw new Error("reap stdout was not exactly the killed session");
}
if (session in after) throw new Error("the session survived reap");
process.stdout.write("present before, named by reap, absent after\n");
' "$FAMILIAR_GATE_DIR/before-reap-$CELL.json" \
  "$FAMILIAR_GATE_DIR/reap-$CELL.txt" \
  "$FAMILIAR_GATE_DIR/after-reap-$CELL.json" \
  "$SESSION_FILE"
```

The step-0 guard that exactly one session is on the bus is what makes the identity
unambiguous, and it is the mechanical form of the prerequisite that no other agent session
runs during the pass. If it throws, stop and close the other session rather than picking a
key by hand.

State that the terminal stays tinted after the force-kill and that this is correct, not a
failure: nothing restores colours without a `SessionEnd`, and `reap` writes no terminal
bytes at all.

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
`capability-none-opencode.jsonl`. Both traces are verified with
`--expect-capability none`, which is the check that matters here: without it, a marker
scrub that silently failed would classify as graphics-capable, emit graphics, agree with
its own recorded expectation, and pass. The two suppression sites are different code: the
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
`bg-command.txt`, seven reap artifacts per cell, `versions-kitty.txt` and `versions-ghostty.txt`, and the tester's notes.

The tester runs the verifier over every trace before sending, and records each result:

Each cell was already verified as it was captured, in section 5, with that run's
`--expect-rdev` and `--expect-capability`. This section re-runs them together as a final
sweep, reading each run's device from its own `versions-<terminal>.txt`:

```bash
KITTY_RDEV=$(sed -n 's/^terminal-rdev=//p' "$FAMILIAR_GATE_DIR/versions-kitty.txt")
GHOSTTY_RDEV=$(sed -n 's/^terminal-rdev=//p' "$FAMILIAR_GATE_DIR/versions-ghostty.txt")
V="$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs"

for agent in claude-code codex opencode; do
  node "$V" "$FAMILIAR_GATE_DIR/kitty-$agent.jsonl" \
    --expect-rdev "$KITTY_RDEV" --expect-capability kitty-animation
  node "$V" "$FAMILIAR_GATE_DIR/ghostty-$agent.jsonl" \
    --expect-rdev "$GHOSTTY_RDEV" --expect-capability static-graphics
done

node "$V" "$FAMILIAR_GATE_DIR/spot-check.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability kitty-animation
node "$V" "$FAMILIAR_GATE_DIR/capability-none-claude-code.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability none
node "$V" "$FAMILIAR_GATE_DIR/capability-none-opencode.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability none --no-require-restore
```

Because the two runs happen in different terminal windows, `--expect-rdev` differs
between them; that is exactly why it is recorded per run rather than assumed. Redaction targets the same secret shapes the previous run swept
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

- Capture branch: `spike/macos-terminal-gate`, disposable and never merged. Pushed to
  `origin` only as transport to the test machine and deleted from the remote afterwards;
  the tester pushed nothing.
- Runbook: `docs/ref/2026-08-24-macos-terminal-gate-handoff.md` on that branch.
- Evidence per cell: one `<terminal>-<agent>.jsonl` trace plus six reap artifacts
  (`reap-session.json`, `reap-pid`, `reap-identity`, `reap-target`, `before-reap`,
  `reap`, `after-reap`).
- Host, OS, terminal, agent, and Node versions: pending.
- Terminal device (`rdev`) and asserted capability per run: pending.

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
- Frame-by-frame graphics sequence. The verifier checks image identity across every
  chunk, key grammar, the `boxFor` placement box, and chunk count against the encoder;
  it deliberately does not reimplement the encoder's chunking rules, because a copy of
  the encoder is not an independent check of it.
- OpenCode graphics depth. Its renderer plans and encodes inside `sprite-runtime.js`, so
  its records carry no planned frame count or placement; its graphics are checked for
  image identity, key grammar, and placement-envelope shape only.
- The event-to-state mapping, which each adapter's unit tests cover in CI. This gate
  checks that the state the emitter acted on produced the right bytes on the right device.
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

- [ ] **Step 1: Confirm both branches are clean, then push the capture branch as transport**

```bash
git -C .worktrees/macos-terminal-spike status --short
git -C .worktrees/macos-terminal-gate status --short
git -C .worktrees/macos-terminal-spike log --oneline main..spike/macos-terminal-gate
git push origin spike/macos-terminal-gate
git rev-parse spike/macos-terminal-gate
```

Expected: both worktrees clean, four commits on the spike branch, and the push accepted.
The branch is pushed **only as transport**; Task 6 Step 6 deletes it from the remote once
the artifacts are in hand. If pushing is not acceptable for this run, produce a bundle
instead and name it in the handoff message:

```bash
git bundle create /tmp/familiar-gate.bundle spike/macos-terminal-gate
```

- [ ] **Step 2: Write the handoff message**

It names: the branch `spike/macos-terminal-gate` and the exact commit SHA; the runbook
path; that the run happens **twice**, `FAMILIAR_TERMINAL=kitty` then `ghostty`, sharing
one output directory, with the appendix and negative control run once under Kitty; that
Node 22 is selected via nvm for the matrix; that exactly one agent session may be live on
the machine during each reap check; that the tester pushes nothing back and commits no raw
artifact; and the artifact list from Task 4 Step 8 to return.

- [ ] **Step 3: On return, verify the artifacts mechanically before reading the notes**

```bash
R=<the returned artifact directory>
KITTY_RDEV=$(sed -n 's/^terminal-rdev=//p' "$R"/versions-kitty.txt)
GHOSTTY_RDEV=$(sed -n 's/^terminal-rdev=//p' "$R"/versions-ghostty.txt)

for agent in claude-code codex opencode; do
  node tools/gate-verify.mjs "$R/kitty-$agent.jsonl" \
    --expect-rdev "$KITTY_RDEV" --expect-capability kitty-animation
  node tools/gate-verify.mjs "$R/ghostty-$agent.jsonl" \
    --expect-rdev "$GHOSTTY_RDEV" --expect-capability static-graphics
done
node tools/gate-verify.mjs "$R/spot-check.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability kitty-animation
node tools/gate-verify.mjs "$R/capability-none-claude-code.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability none
node tools/gate-verify.mjs "$R/capability-none-opencode.jsonl" \
  --expect-rdev "$KITTY_RDEV" --expect-capability none --no-require-restore

test ! -s "$R/probe2.jsonl"                         # the fail-closed run wrote nothing

# Cleanup, per cell, re-checked here rather than trusted from the tester's notes: the
# recorded session is present before, named by reap, and absent after. The id is decoded
# from JSON and compared as an exact string -- it is agent-supplied text, so it is neither
# a pattern nor guaranteed to be one line.
for cell in kitty ghostty; do
  for agent in claude-code codex opencode; do
    node -e '
const fs = require("node:fs");
const [beforePath, reapPath, afterPath, sessionPath] = process.argv.slice(2);
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
if (!(session in before)) throw new Error(`${beforePath}: session absent before reap`);
if (fs.readFileSync(reapPath, "utf8") !== `reaped ${session}\n`) {
  throw new Error(`${reapPath}: reap stdout was not exactly the killed session`);
}
if (session in after) throw new Error(`${afterPath}: session survived reap`);
' "$R/before-reap-$cell-$agent.json" "$R/reap-$cell-$agent.txt" \
  "$R/after-reap-$cell-$agent.json" "$R/reap-session-$cell-$agent.json"
  done
done
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

- [ ] **Step 6: Delete the transport branch from the remote**

```bash
git push origin --delete spike/macos-terminal-gate
git branch -vv | grep macos-terminal
```

Expected: the remote branch is gone and the local capture branch has no upstream. The
local branch and worktree stay until the evidence note is accepted.

- [ ] **Step 7: Verify promoted claims against the evidence**

```bash
grep -n 'provisional\|verified\|tmux\|Intel\|macOS 13\|macOS 14' docs/install.md docs/specs/2026-08-22-macos-support-design.md docs/ref/2026-08-24-macos-terminal-smoke.md
git diff --check HEAD^..HEAD
```

Expected: every promoted claim has a passing evidence row; macOS 14 live-agent coverage,
tmux, Intel, macOS 13, and other terminals remain explicitly unclaimed.
