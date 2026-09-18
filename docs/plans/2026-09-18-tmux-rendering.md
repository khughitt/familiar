# Rendering inside tmux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Familiar draws its cat inside a tmux pane hosted by Kitty or Ghostty, with lifecycle evidence that describes what the terminal actually received.

**Architecture:** A probe (`tmuxFacts`) asks the tmux server for passthrough and the attached client's identity; a still-pure classifier consumes it. Every APC command the encoder or the CLI transmitter produces is wrapped in DCS passthrough per command. Lifecycle evidence moves from the bus's intent record to a per-session transmission ledger, written inside one per-session critical section with the terminal write and ordered by a bus-wide event counter.

**Tech Stack:** Node 22+ ESM, `node:test`, `node:child_process`, tmux ≥ 3.3 (`allow-passthrough all`), util-linux `script` for the pty test.

**Spec:** `docs/specs/2026-09-18-tmux-rendering-design.md` — every task below cites the section it implements; read the section before the task.

## Global Constraints

- `graphicsCapability` stays pure: no subprocess, no `process.env` default (§3.2).
- Only `src/render/term/tmux.js` talks to tmux (§3.1). Probe timeout constant `TMUX_PROBE_TIMEOUT_MS = 1000`, its own name (see the naming note at the top of `src/render/term/statusfields.js`).
- `allow-passthrough on` is refused; only `all` renders (§3.2).
- `ENCODED_BYTES_MAX` and the `encodedBytes` metric describe **unwrapped** bytes (§3.3). Wrapped size is `encodedBytes + 11 × commands`.
- `update` requires valid evidence **and** capability `ANIMATION`; `STATIC` is always `create` (§3.5 step 4).
- The bus lock is never held across a spawn. The transmission lock is per session, `staleMs: Infinity`, `retries: 1500`, holder liveness through `ownerAlive` behind a one-second memo (§3.5).
- Every ledger write goes through `stamp()`; `held` crosses a write only through `inherit()` (§3.5).
- Ledger and lock filenames go through `ledgerName()`; they can never escape `stateDir/transmit/` (§3.5).
- Layout newlines after CLI APC commands stay outside passthrough (§3.4).
- **Detecting a bare APC in tests:** `ESC _ G` also occurs inside a correctly wrapped `ESC ESC _ G`, so never count `'\x1b_G'` substrings. Every test file that checks framing defines and uses
  `const BARE_APC = /(?<!\x1b)\x1b_G/g; const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;`
  and counts wrapped commands with `text.split('\x1bPtmux;').length - 1`.
- Tests: `node --test <file>` for one file; `npm test` for the fast suite; `npm run test:slow` for the slow partition (Task 13 adds it). Run `tasks check` before every commit (pre-commit hook does too).
- Commits: conventional commits, no attribution trailers.
- The repository's `AGENTS.md` and `CLAUDE.md` apply. Comment density in this codebase is high and argumentative; match it where you add code, and never leave a comment that asserts an unmeasured fact.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `src/render/term/tmux.js` (new) | probe, `wrapForTmux`, `transportFor`, `describeTmux` | 1 |
| `src/render/term/capability.js` | classifier with probe input | 2 |
| `src/render/term/kitty-animation.js` | `frame` option on the encoder | 3 |
| `src/render/term/kitty.js` | `frame` option on the CLI transmitter | 3 |
| `src/render/term/placeholder.js` | loses `wrapForTmux` | 1 |
| `src/render/term/target.js` | terminal target carries `tmux` | 4 |
| `src/bus/proc.js` | `ownerAlive` on process ops | 5 |
| `src/bus/memo.js` (new) | `memoizeFor` | 5 |
| `src/render/term/ledger.js` (new) | names, paths, file/memory ledgers, `stamp`, `inherit`, lock options | 6 |
| `src/bus/paths.js` | `transmitDir`, `seqPath` | 6 |
| `src/bus/seq.js` (new) | bus-wide event counter | 7 |
| `src/bus/transaction.js` | assigns `seq`, drops `priorIntent` | 7 |
| `src/render/term/emit.js` | the emission critical section | 8, 9 |
| `src/render/term/ledger-prune.js` (new) | candidate pruning under the session lock | 10 |
| `bin/familiar.js` | hook wiring, reap, CLI verbs | 11, 12 |
| `test/tmux-pty.slow.test.js` (new), `package.json`, `justfile`, `.github/workflows/test.yml` | slow partition and its entry points | 13 |
| `docs/surfaces.md`, `docs/ref/kitty-graphics-protocol.md`, `docs/install.md` | claims | 14 |

---

### Task 1: The tmux probe module

Spec: §3.1.

**Files:**
- Create: `src/render/term/tmux.js`
- Modify: `src/render/term/placeholder.js` (remove `wrapForTmux`, lines 133–137)
- Modify: `src/render/term/emit.js:5` (import `wrapForTmux` from `./tmux.js`)
- Test: `test/tmux.test.js` (new); `test/placeholder.test.js` (move any `wrapForTmux` test)

**Interfaces:**
- Produces:
  - `tmuxFacts(env, { exec = execFileSync } = {})` → `null` | `{ ok: true, passthrough: 'off'|'on'|'all', termname, termtype, client: { tty, pid, created } }` | `{ ok: false, reason: 'no-binary'|'timeout'|'exit'|'no-pane'|'no-client' }` (frozen).
  - `wrapForTmux(escapes: Buffer|string)` → same type.
  - `transportFor(tmux)` → `'direct'` | `` `tmux:${tty}:${pid}:${created}` ``.
  - `describeTmux(tmux)` → `''` or a ` — …` suffix for `theme show`'s stderr line.
  - `TMUX_PROBE_TIMEOUT_MS = 1000`.

- [ ] **Step 1: Write the failing tests**

Create `test/tmux.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tmuxFacts, wrapForTmux, transportFor, describeTmux, TMUX_PROBE_TIMEOUT_MS,
} from '../src/render/term/tmux.js';

const TMUX_ENV = { TMUX: '/tmp/tmux-1000/default,4242,0', TMUX_PANE: '%3' };
const LINE = 'all\txterm-kitty\tkitty(0.48.2)\t/dev/pts/16\t9001\t1758200000\n';

test('no TMUX in the environment: the probe is null and nothing is spawned', () => {
  let spawned = 0;
  assert.equal(tmuxFacts({ TERM: 'xterm-kitty' }, { exec: () => { spawned += 1; return LINE; } }), null);
  assert.equal(spawned, 0);
});

test('the probe refuses an implicit environment', () => {
  assert.throws(() => tmuxFacts(), TypeError);
});

test('the probe asks the socket named by $TMUX about the pane named by $TMUX_PANE', () => {
  const calls = [];
  const facts = tmuxFacts(TMUX_ENV, { exec: (file, args, options) => { calls.push({ file, args, options }); return LINE; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'tmux');
  assert.deepEqual(calls[0].args.slice(0, 5), ['-S', '/tmp/tmux-1000/default', 'display-message', '-p', '-t']);
  assert.equal(calls[0].args[5], '%3');
  assert.equal(calls[0].args[6], '#{allow-passthrough}\t#{client_termname}\t#{client_termtype}\t#{client_tty}\t#{client_pid}\t#{client_created}');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(calls[0].options.timeout, TMUX_PROBE_TIMEOUT_MS);
  assert.deepEqual(facts, {
    ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)',
    client: { tty: '/dev/pts/16', pid: 9001, created: 1758200000 },
  });
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.client));
});

test('each operational failure is a reason, never a throw', () => {
  const enoent = Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
  const timedOut = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const exit = Object.assign(new Error('no server running'), { status: 1 });
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => { throw enoent; } }), { ok: false, reason: 'no-binary' });
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => { throw timedOut; } }), { ok: false, reason: 'timeout' });
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => { throw exit; } }), { ok: false, reason: 'exit' });
  assert.deepEqual(tmuxFacts({ TMUX: TMUX_ENV.TMUX }, { exec: () => LINE }), { ok: false, reason: 'no-pane' });
  // A detached server answers with empty client fields (measured 2026-09-18).
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => 'all\t\t\t\t\t\n' }), { ok: false, reason: 'no-client' });
  // Garbage from the server is an exit failure, not a crash in the hook.
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => 'maybe\txterm-kitty\tkitty\t/dev/pts/1\tx\ty\n' }), { ok: false, reason: 'exit' });
});

test('wrapForTmux frames the escapes in DCS passthrough and doubles every ESC, preserving the type', () => {
  const apc = '\x1b_Ga=T,q=2;AAAA\x1b\\';
  const wrapped = wrapForTmux(apc);
  assert.equal(wrapped, '\x1bPtmux;\x1b\x1b_Ga=T,q=2;AAAA\x1b\x1b\\\x1b\\');
  const asBuffer = wrapForTmux(Buffer.from(apc));
  assert.ok(Buffer.isBuffer(asBuffer));
  assert.equal(asBuffer.toString('latin1'), wrapped);
  // 9 bytes of framing plus one per ESC: the overhead the spec states (§3.3).
  assert.equal(wrapped.length, apc.length + 9 + 2);
});

test('transportFor names an incarnation of the attached client, not a pathname', () => {
  assert.equal(transportFor(null), 'direct');
  assert.equal(transportFor({ ok: false, reason: 'no-client' }), 'direct');
  assert.equal(transportFor(tmuxFacts(TMUX_ENV, { exec: () => LINE })), 'tmux:/dev/pts/16:9001:1758200000');
});

test('describeTmux explains a refusal in the words of the setting', () => {
  assert.equal(describeTmux(null), '');
  assert.equal(describeTmux({ ok: false, reason: 'no-client' }), ' — tmux probe: no-client');
  assert.equal(describeTmux({ ...tmuxFacts(TMUX_ENV, { exec: () => LINE }), passthrough: 'on' }), ' — tmux allow-passthrough=on, needs all');
  assert.equal(describeTmux(tmuxFacts(TMUX_ENV, { exec: () => LINE.replace('xterm-kitty', 'xterm-256color').replace('kitty(0.48.2)', 'foot(1.0)') })), ' — tmux client xterm-256color (foot(1.0)) is not a terminal familiar can draw on');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/tmux.test.js`
Expected: FAIL — `Cannot find module '.../src/render/term/tmux.js'`.

- [ ] **Step 3: Write the module**

Create `src/render/term/tmux.js`:

```js
import { execFileSync } from 'node:child_process';

// NOT NAMED GIT_TIMEOUT_MS OR BRANCH_TIMEOUT_MS. src/bus/identity.js and
// src/render/term/statusfields.js each own a constant for their own deadline; this one
// bounds a local IPC round trip to the tmux server from inside a hook. Measured
// sub-millisecond on a healthy server; a second is the budget for a wedged one.
export const TMUX_PROBE_TIMEOUT_MS = 1000;

// The one place in familiar that talks to tmux. Everything a caller needs to decide
// whether — and to which terminal — graphics can be sent comes back from one
// display-message: the pane's passthrough setting, the ATTACHED client's terminal
// (the inner TERM=tmux-256color hides it), and that client's incarnation. `client_tty`
// alone is a pathname the kernel reuses (two successive ptys both came back as
// /dev/pts/16 under review); `client_pid` + `client_created` make it an identity.
const FORMAT = [
  '#{allow-passthrough}',
  '#{client_termname}',
  '#{client_termtype}',
  '#{client_tty}',
  '#{client_pid}',
  '#{client_created}',
].join('\t');

const PASSTHROUGH = new Set(['off', 'on', 'all']);

const failure = (reason) => Object.freeze({ ok: false, reason });

// No default env, for the reason graphicsCapability() has none: the environment that
// says "inside tmux" belongs to the agent process, not to whoever is asking.
export function tmuxFacts(env, { exec = execFileSync } = {}) {
  if (env === undefined || env === null || typeof env !== 'object') {
    throw new TypeError('tmuxFacts requires an explicit environment');
  }
  if (!env.TMUX) return null;
  // $TMUX is `<socket>,<server pid>,<session index>`.
  const socket = env.TMUX.split(',')[0];
  const pane = env.TMUX_PANE;
  if (!pane) return failure('no-pane');

  let output;
  try {
    output = exec('tmux', ['-S', socket, 'display-message', '-p', '-t', pane, FORMAT], {
      encoding: 'utf8',
      // stderr is discarded so a broken server can never write into the hook's own
      // output, which is the agent's terminal.
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TMUX_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return failure('no-binary');
    if (error?.code === 'ETIMEDOUT') return failure('timeout');
    return failure('exit');
  }

  const [passthrough, termname, termtype, tty, pidText, createdText] = String(output).replace(/\n$/, '').split('\t');
  // A detached server has a pane and a setting but no client: nothing to draw on.
  if (!termname) return failure('no-client');
  const pid = Number.parseInt(pidText, 10);
  const created = Number.parseInt(createdText, 10);
  if (!PASSTHROUGH.has(passthrough) || !tty || !Number.isInteger(pid) || !Number.isInteger(created)) {
    return failure('exit');
  }
  return Object.freeze({
    ok: true,
    passthrough,
    termname,
    termtype: termtype ?? '',
    client: Object.freeze({ tty, pid, created }),
  });
}

// DCS passthrough: `ESC P tmux ; <bytes with every ESC doubled> ESC \`. Moved here from
// placeholder.js because the encoder emits Buffers and the CLI transmitter emits
// strings; both are ASCII (control fields and base64), so latin1 round-trips losslessly.
export function wrapForTmux(escapes) {
  if (Buffer.isBuffer(escapes)) {
    return Buffer.from(wrapForTmux(escapes.toString('latin1')), 'latin1');
  }
  return `\x1bPtmux;${escapes.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

// The identity the transmission ledger keys `held` on (spec §3.5). Outside tmux the
// agent's own pid/starttime already identify its pty, so `direct` needs no more.
export function transportFor(tmux) {
  if (!tmux || !tmux.ok) return 'direct';
  const { tty, pid, created } = tmux.client;
  return `tmux:${tty}:${pid}:${created}`;
}

// For `theme show`: a person with the wrong setting should learn the setting.
export function describeTmux(tmux) {
  if (!tmux) return '';
  if (!tmux.ok) return ` — tmux probe: ${tmux.reason}`;
  if (tmux.passthrough !== 'all') return ` — tmux allow-passthrough=${tmux.passthrough}, needs all`;
  return ` — tmux client ${tmux.termname} (${tmux.termtype}) is not a terminal familiar can draw on`;
}
```

- [ ] **Step 4: Move `wrapForTmux` out of `placeholder.js`**

Delete lines 133–137 of `src/render/term/placeholder.js` (the comment and `export function wrapForTmux`). In `src/render/term/emit.js` change line 5 to:

```js
import { transmitVirtual, imageIdFor } from './placeholder.js';
import { wrapForTmux } from './tmux.js';
```

If `test/placeholder.test.js` imports `wrapForTmux`, change that import to `../src/render/term/tmux.js`; keep its assertions.

- [ ] **Step 5: Run the tests**

Run: `node --test test/tmux.test.js test/placeholder.test.js test/emit.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/term/tmux.js src/render/term/placeholder.js src/render/term/emit.js test/tmux.test.js test/placeholder.test.js
git commit -m "feat(term): probe tmux for passthrough and the attached client"
```

---

### Task 2: The classifier consumes the probe

Spec: §3.2.

**Files:**
- Modify: `src/render/term/capability.js`
- Test: `test/kitty.test.js` (the `graphicsCapability` tests near the top; the `MULTIPLEXER_MARKERS` loop at lines 61–67)

**Interfaces:**
- Consumes: `tmuxFacts` result shape from Task 1.
- Produces: `graphicsCapability(env, tmux)` → `'kitty-animation' | 'static-graphics' | 'none'`. Throws `TypeError` when `env.TMUX` is set and `tmux` is `undefined` or `null`.

- [ ] **Step 1: Write the failing tests**

In the first table test (`classifies terminal graphics capability explicitly`, `test/kitty.test.js:11-22`) delete the row `[{ TERM: 'xterm-kitty', TMUX: '/tmp/tmux' }, 'none']` — under the new contract that input throws, and the throw is pinned by the test below.

Replace the `MULTIPLEXER_MARKERS` test at `test/kitty.test.js:61-67` with:

```js
// KILLS: a marker added to MULTIPLEXER_MARKERS but not routed through the probe. Under
// a multiplexer the classifier must be HANDED the probe result; asking it to classify
// $TMUX from the environment alone is the wrong question, and it says so.
test('a multiplexer marker demands the probe result; without one it throws rather than guessing', () => {
  const everyAccept = Object.fromEntries(GRAPHICS_MARKERS.map(({ name, value }) => [name, value ?? '1']));
  for (const name of MULTIPLEXER_MARKERS) {
    const env = { ...everyAccept, [name]: '/tmp/sock,1,0' };
    assert.throws(() => graphicsCapability(env), TypeError, `${name} set, no probe: must throw`);
    assert.throws(() => graphicsCapability(env, null), TypeError, `${name} set, null probe: must throw`);
  }
});

const KITTY_CLIENT = Object.freeze({
  ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)',
  client: { tty: '/dev/pts/16', pid: 9001, created: 1758200000 },
});
const TMUX_ENV = { TERM: 'tmux-256color', TMUX: '/tmp/sock,1,0', TMUX_PANE: '%0' };

test('inside tmux, only allow-passthrough=all with a graphics-capable client renders', () => {
  assert.equal(graphicsCapability(TMUX_ENV, KITTY_CLIENT), GRAPHICS_CAPABILITY.ANIMATION);
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, termname: 'xterm-ghostty', termtype: 'ghostty 1.3.1' }), GRAPHICS_CAPABILITY.STATIC);
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, termname: 'xterm-256color', termtype: 'foot(1.0)' }), GRAPHICS_CAPABILITY.NONE);
  // `on` drops passthrough while the pane is invisible; a level-triggered cat would go stale.
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, passthrough: 'on' }), GRAPHICS_CAPABILITY.NONE);
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, passthrough: 'off' }), GRAPHICS_CAPABILITY.NONE);
  for (const reason of ['no-binary', 'timeout', 'exit', 'no-pane', 'no-client']) {
    assert.equal(graphicsCapability(TMUX_ENV, { ok: false, reason }), GRAPHICS_CAPABILITY.NONE, reason);
  }
});

test('inside tmux the inherited environment loses to the attached client', () => {
  // A tmux server started from Kitty, now attached from a terminal without graphics:
  // KITTY_WINDOW_ID is inherited by every pane and describes the FIRST client, not this one.
  const inherited = { ...TMUX_ENV, KITTY_WINDOW_ID: '1' };
  assert.equal(graphicsCapability(inherited, { ...KITTY_CLIENT, termname: 'xterm-256color', termtype: '' }), GRAPHICS_CAPABILITY.NONE);
});

test('outside tmux the probe result is ignored and the TERM-prefix refusal still stands', () => {
  assert.equal(graphicsCapability({ TERM: 'xterm-kitty' }, null), GRAPHICS_CAPABILITY.ANIMATION);
  // A remote shell inside someone else's tmux: TERM says tmux, $TMUX is absent, no passthrough story.
  assert.equal(graphicsCapability({ TERM: 'tmux-256color' }, null), GRAPHICS_CAPABILITY.NONE);
  assert.equal(graphicsCapability({ TERM: 'screen-256color', KITTY_WINDOW_ID: '1' }, null), GRAPHICS_CAPABILITY.NONE);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/kitty.test.js`
Expected: FAIL — the throw assertions fail (today `TMUX` returns `'none'`), and the tmux cases return `'none'`.

- [ ] **Step 3: Implement**

Replace the body of `src/render/term/capability.js` from `export const MULTIPLEXER_MARKERS` to the end with:

```js
// Variables that mean "the terminal is behind a multiplexer". They no longer REFUSE:
// they demand the probe result (src/render/term/tmux.js), because the inner
// environment cannot answer the question. Exported so environment-scrubbing tests
// clear the same list the classifier reads.
export const MULTIPLEXER_MARKERS = ['TMUX'];

// The outer terminal, as the tmux client reports it. NOT the inherited environment: a
// tmux server carries the environment of the client that started it, and the client
// attached now may be a different program on a different machine.
function outerCapability({ termname, termtype }) {
  if (termname === 'xterm-kitty' || termtype.startsWith('kitty')) return GRAPHICS_CAPABILITY.ANIMATION;
  if (termname === 'xterm-ghostty' || termtype.startsWith('ghostty')) return GRAPHICS_CAPABILITY.STATIC;
  return GRAPHICS_CAPABILITY.NONE;
}

// `tmux` is the result of tmuxFacts(env). It is REQUIRED whenever env names a
// multiplexer, on the same principle as the missing env default: the caller decides
// which process was probed, and a caller that forgot to probe gets told, not guessed for.
export function graphicsCapability(env, tmux) {
  if (MULTIPLEXER_MARKERS.some((name) => env[name])) {
    if (tmux === undefined || tmux === null) {
      throw new TypeError('graphicsCapability: the environment names a multiplexer but no probe result was given — call tmuxFacts(env) first');
    }
    if (!tmux.ok) return GRAPHICS_CAPABILITY.NONE;
    // `on` forwards passthrough only while the pane is visible. A level-triggered hook
    // firing in a background window would leave the outer terminal holding the previous
    // state's image — a cat saying "working" while the session waits for approval. The
    // rule since virtual placement is that the cat is never stale; a terminal that cannot
    // honour it gets no cat, the same way a plain TERM gets no substitute.
    if (tmux.passthrough !== 'all') return GRAPHICS_CAPABILITY.NONE;
    return outerCapability(tmux);
  }
  // TERM says tmux or screen but $TMUX is absent: a remote shell inside someone else's
  // multiplexer, or GNU screen. Neither has a passthrough story.
  if (/^(screen|tmux)/.test(env.TERM ?? '')) return GRAPHICS_CAPABILITY.NONE;

  // Explicit Ghostty identity wins over stale Kitty markers inherited from an
  // outer process: Ghostty supports static graphics here, not Kitty animation.
  if (env.TERM_PROGRAM === 'ghostty') return GRAPHICS_CAPABILITY.STATIC;

  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID) {
    return GRAPHICS_CAPABILITY.ANIMATION;
  }
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) {
    return GRAPHICS_CAPABILITY.STATIC;
  }
  return GRAPHICS_CAPABILITY.NONE;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/kitty.test.js test/emit.test.js test/bin-familiar.test.js test/theme-catalog.test.js`
Expected: PASS. (`emit.js` still passes only `env`; its tests never set `TMUX`, so no throw. `bin-familiar.test.js` scrubs `MULTIPLEXER_MARKERS` from its fixture env.) Update the comment at `test/theme-catalog.test.js:298` from "for any tmux" to "for a tmux pane whose probe refuses".

- [ ] **Step 5: Commit**

```bash
git add src/render/term/capability.js test/kitty.test.js test/theme-catalog.test.js
git commit -m "feat(term): classify tmux panes from the probe, not the inherited env"
```

---

### Task 3: Per-command framing in both emitters

Spec: §3.3, §3.4 (CLI transmitter paragraph).

**Files:**
- Modify: `src/render/term/kitty-animation.js:159` (`encodeKittyProgram` options) and lines 255–270 (limit check and return)
- Modify: `src/render/term/kitty.js:14` (`transmit` options) and line 68 (return)
- Test: `test/kitty-animation.test.js`, `test/kitty.test.js`

**Interfaces:**
- Produces: `encodeKittyProgram(program, { id, placement, lifecycle, readFrame, frame })` where `frame: (command: Buffer) => Buffer` defaults to identity; `metrics.encodedBytes` is the unwrapped total. `transmit(png, { rows, frame })` where `frame: (command: string) => string` defaults to identity.

- [ ] **Step 1: Write the failing tests**

Append to `test/kitty-animation.test.js` (reuse that file's existing program/readFrame fixtures — read the file first and use the same names it uses for a valid static program and a `readFrame`; the snippet below calls them `staticProgram()` and `readFrame`):

```js
import { wrapForTmux } from '../src/render/term/tmux.js';

const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;

test('frame is applied to every command, and encodedBytes still measures the unwrapped program', () => {
  const plain = encodeKittyProgram(staticProgram(), { id: 7, placement: { kind: 'virtual', cols: 4, rows: 4 }, lifecycle: 'create', readFrame });
  const seen = [];
  const wrapped = encodeKittyProgram(staticProgram(), {
    id: 7, placement: { kind: 'virtual', cols: 4, rows: 4 }, lifecycle: 'create', readFrame,
    frame: (command) => { seen.push(command); return wrapForTmux(command); },
  });
  assert.equal(seen.length, plain.metrics.commands, 'one frame() call per command');
  assert.equal(wrapped.metrics.encodedBytes, plain.metrics.encodedBytes, 'the pack metric does not depend on the transport');
  // Spec §3.3: wrapped = unwrapped + 11 × commands for the current APC encoding.
  assert.equal(wrapped.bytes.length, plain.metrics.encodedBytes + 11 * plain.metrics.commands);
  // No bare APC survives. `ESC _ G` also occurs INSIDE a wrapped `ESC ESC _ G`, so count
  // only APC starts not preceded by an ESC, and count frames by their DCS opener.
  const text = wrapped.bytes.toString('latin1');
  assert.equal(bareApcs(text), 0);
  assert.equal(text.split('\x1bPtmux;').length - 1, plain.metrics.commands);
});

test('frame must be a function', () => {
  assert.throws(() => encodeKittyProgram(staticProgram(), { id: 7, placement: { kind: 'virtual', cols: 4, rows: 4 }, lifecycle: 'create', readFrame, frame: 'wrap' }), /frame must be a function/);
});
```

Append to `test/kitty.test.js` (it already imports `transmit` and has a PNG fixture — reuse its name; below it is `PNG`):

```js
import { wrapForTmux } from '../src/render/term/tmux.js';

const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;

test('transmit frames every APC command and leaves the layout newlines outside the framing', () => {
  const plain = transmit(PNG, { rows: 3 });
  const wrapped = transmit(PNG, { rows: 3, frame: wrapForTmux });
  assert.ok(plain.endsWith('\n\n\n'));
  assert.ok(wrapped.endsWith('\x1b\\\n\n\n'), 'the DCS closes before the newlines, which are tmux layout, not payload');
  assert.equal(bareApcs(wrapped), 0, 'no bare APC');
  const commands = plain.split('\x1b\\').length - 1;
  assert.equal(wrapped.split('\x1bPtmux;').length - 1, commands, 'one DCS per command');
  assert.equal(wrapped.length, plain.length + 11 * commands);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/kitty-animation.test.js test/kitty.test.js`
Expected: FAIL — `frame` ignored, byte lengths equal.

- [ ] **Step 3: Implement the encoder option**

In `src/render/term/kitty-animation.js`, change the signature at line 159 to:

```js
export function encodeKittyProgram(program, { id, placement, lifecycle, readFrame, frame = identity } = {}) {
  assertLifecycle(lifecycle);
  assertUint32(id, 'image id');
  assertPlacement(placement);
  if (typeof readFrame !== 'function') {
    throw new Error('kitty animation: readFrame must be a function');
  }
  if (typeof frame !== 'function') {
    throw new Error('kitty animation: frame must be a function');
  }
```

Add near the top of the file (after the constants):

```js
const identity = (command) => command;
```

Replace the tail of the function (from `const bytes = Buffer.concat(commands);` to the `return`) with:

```js
  // THE LIMIT AND THE METRIC ARE ABOUT THE PACK, NOT THE TRANSPORT. preflightKittyPrograms
  // checks them at install time with no terminal in sight; a limit that moved with the
  // framing would make preflight lie. The framed stream is exactly
  // `encodedBytes + 11 * commands` for this APC encoding (9 bytes of DCS framing and two
  // doubled ESCs per command; base64 payloads contain none), so a caller that needs the
  // wire size can compute it from these metrics.
  const encodedBytes = commands.reduce((total, command) => total + command.length, 0);
  if (encodedBytes > ENCODED_BYTES_MAX) {
    throw new KittyProgramLimitError('encodedBytes', encodedBytes, ENCODED_BYTES_MAX);
  }
  const bytes = frame === identity ? Buffer.concat(commands) : Buffer.concat(commands.map(frame));
  return {
    bytes,
    metrics: {
      encodedBytes,
      decodedBytes: toNumber(decodedBytes, 'decodedBytes'),
      commands: commands.length,
      frames: shape.frames,
    },
  };
```

- [ ] **Step 4: Implement the transmitter option**

In `src/render/term/kitty.js` change line 14 to `export function transmit(png, { rows, frame = (command) => command }) {` and line 68 to:

```js
  // frame() wraps each APC for a transport that needs it (tmux passthrough). The
  // newlines are NOT payload: they are layout for the multiplexer's own grid, and
  // wrapping them would hide the rows we are reserving from the very thing that lays
  // them out.
  return out.map(frame).join('') + '\n'.repeat(rows);
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/kitty-animation.test.js test/kitty.test.js test/emit.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/term/kitty-animation.js src/render/term/kitty.js test/kitty-animation.test.js test/kitty.test.js
git commit -m "feat(term): frame every graphics command for a passthrough transport"
```

---

### Task 4: The terminal target carries the probe result

Spec: §3.4 (hook path).

**Files:**
- Modify: `src/render/term/target.js`
- Test: `test/terminal-target.test.js`

**Interfaces:**
- Produces: `terminalTarget(pid, { platform, record, hookEnv, readEnviron, probe = tmuxFacts })` → `{ path, env, tmux }` where `tmux` is `probe(env)` when `env` is defined and `undefined` when the environ was unreadable.

- [ ] **Step 1: Update and extend the tests**

In `test/terminal-target.test.js`, add `tmux: null` to both `deepEqual` expectations at lines 9–17 and 21–25 (pass `probe: () => null` in each call). Then append:

```js
test('the probe runs against the AGENT environment and rides on the target', () => {
  const probed = [];
  const facts = { ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)', client: { tty: '/dev/pts/1', pid: 1, created: 1 } };
  const target = terminalTarget(42, {
    platform: 'linux',
    readEnviron: () => 'TERM=tmux-256color\0TMUX=/tmp/s,1,0\0TMUX_PANE=%0\0',
    probe: (env) => { probed.push(env); return facts; },
  });
  assert.deepEqual(probed, [{ TERM: 'tmux-256color', TMUX: '/tmp/s,1,0', TMUX_PANE: '%0' }]);
  assert.equal(target.tmux, facts);
});

test('an unreadable environ leaves both env and tmux undefined — tint and bell need neither', () => {
  let probed = 0;
  const target = terminalTarget(42, {
    platform: 'linux',
    readEnviron: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    probe: () => { probed += 1; return null; },
  });
  assert.deepEqual(target, { path: '/proc/42/fd/1', env: undefined, tmux: undefined });
  assert.equal(probed, 0);
});

test('Darwin probes the hook environment, which the agent shares', () => {
  const hookEnv = { TERM: 'tmux-256color', TMUX: '/private/tmp/s,1,0', TMUX_PANE: '%2' };
  const facts = { ok: false, reason: 'no-client' };
  const target = terminalTarget(42, { platform: 'darwin', record: { pid: 42, tty: 'ttys003' }, hookEnv, probe: (env) => (env === hookEnv ? facts : null) });
  assert.deepEqual(target, { path: '/dev/ttys003', env: hookEnv, tmux: facts });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/terminal-target.test.js`
Expected: FAIL — `tmux` missing from the result.

- [ ] **Step 3: Implement**

Replace `src/render/term/target.js` with:

```js
import { readFileSync } from 'node:fs';
import { tmuxFacts } from './tmux.js';

function envOf(pid, read) {
  const raw = read(`/proc/${pid}/environ`, 'utf8');
  return Object.fromEntries(raw.split('\0').filter(Boolean).map((kv) => {
    const eq = kv.indexOf('=');
    return [kv.slice(0, eq), kv.slice(eq + 1)];
  }));
}

// The target is `{ path, env, tmux }`: where to write, the environment that decides
// whether graphics are possible, and — when that environment names a tmux pane — what
// the tmux server says about it. The probe spawns, so it runs HERE, before any lock is
// taken (see emitHookTransition in bin/familiar.js), and never inside the classifier.
export function terminalTarget(pid, {
  platform = process.platform,
  record,
  hookEnv = process.env,
  readEnviron = readFileSync,
  probe = tmuxFacts,
} = {}) {
  if (platform === 'linux') {
    let env;
    try { env = envOf(pid, readEnviron); }
    catch { /* tint and bell do not need graphics capability */ }
    return { path: `/proc/${pid}/fd/1`, env, tmux: env === undefined ? undefined : probe(env) };
  }
  if (platform === 'darwin') {
    if (!record || typeof record.tty !== 'string' || !/^ttys[0-9a-f]+$/i.test(record.tty)) {
      throw new Error(`terminal target: agent pid ${pid} has no validated Darwin tty`);
    }
    return { path: `/dev/${record.tty}`, env: hookEnv, tmux: probe(hookEnv) };
  }
  throw new Error(`terminal target: unsupported platform ${JSON.stringify(platform)}`);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/terminal-target.test.js test/bin-familiar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/term/target.js test/terminal-target.test.js
git commit -m "feat(term): carry the tmux probe result on the terminal target"
```

---

### Task 5: Fresh owner liveness and a time-bounded memo

Spec: §3.5 "One liveness predicate for this section" and the lock paragraph.

**Files:**
- Modify: `src/bus/proc.js` (both platform branches of `createProcessOps`, and the `export const` list at the bottom)
- Create: `src/bus/memo.js`
- Test: `test/proc.test.js`, `test/lock.test.js`, `test/memo.test.js` (new)

**Interfaces:**
- Produces: `processOps.ownerAlive(pid, { starttime })` → boolean, fresh identity on both platforms. `memoizeFor(fn, ttlMs, { now })` → a function with `withLock`'s `isAlive(pid, { starttime })` signature.

- [ ] **Step 1: Write the failing tests**

Create `test/memo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoizeFor } from '../src/bus/memo.js';

test('memoizeFor answers from the cache inside the window and asks again after it', () => {
  let clock = 0;
  const answers = [true, false];
  let calls = 0;
  const alive = memoizeFor((pid, { starttime }) => { calls += 1; return answers.shift(); }, 1000, { now: () => clock });
  for (let i = 0; i < 50; i += 1) assert.equal(alive(7, { starttime: 1 }), true);
  assert.equal(calls, 1, 'fifty attempts inside one second cost one liveness call');
  clock = 1000;
  assert.equal(alive(7, { starttime: 1 }), false);
  assert.equal(calls, 2);
});

test('memoizeFor keys on pid AND starttime', () => {
  let calls = 0;
  const alive = memoizeFor(() => { calls += 1; return true; }, 1000, { now: () => 0 });
  alive(7, { starttime: 1 });
  alive(7, { starttime: 2 });
  assert.equal(calls, 2);
});
```

Append to `test/proc.test.js` (read the file first: it builds Linux ops with `createProcessOps({ platform: 'linux', readStat, ... })` and Darwin ops with `runPs` — reuse its exact helper names for a Linux stat line and a Darwin `ps` row; below they are `statLine(pid, starttime)` and `darwinRow({ pid, starttime })`, adapt to the file):

```js
test('Linux ownerAlive is fresh identity: pid alive but restarted is dead', () => {
  let starttime = 100;
  // `kill` is the constructor's existence probe (createProcessOps builds pidExists from
  // it); a kill that never throws says "pid 7 exists" without consulting the real pid 7.
  const ops = createProcessOps({
    platform: 'linux',
    readStat: (pid) => statLine(pid, starttime),
    kill: () => {},
  });
  assert.equal(ops.ownerAlive(7, { starttime: 100 }), true);
  starttime = 200;                                     // the pid was recycled
  assert.equal(ops.ownerAlive(7, { starttime: 100 }), false);
  assert.equal(ops.ownerAlive(7, { starttime: null }), false);
});

test('Darwin ownerAlive consults ps -p, not the memoized -axo snapshot', () => {
  let fresh = 100;
  const ops = createProcessOps({
    platform: 'darwin',
    kill: () => {},
    runPs: (args) => (args[0] === '-p' ? darwinRow({ pid: 7, starttime: fresh }) : darwinRow({ pid: 7, starttime: 100 })),
  });
  assert.equal(ops.isAlive(7, { starttime: 100 }), true);
  fresh = 200;                                         // the pid was recycled after the snapshot
  assert.equal(ops.isAlive(7, { starttime: 100 }), true, 'the snapshot-backed predicate is stale — this is the defect ownerAlive exists for');
  assert.equal(ops.ownerAlive(7, { starttime: 100 }), false);
});
```

Append to `test/lock.test.js` (read it first; it drives `withLock` with `now`, `isAlive`, `sleep`, and a temp lock path — reuse its helpers):

```js
test('staleMs: Infinity never reclaims a live holder, however long the section runs', async () => {
  const lockPath = join(tmp(), 'transmit.lock');
  let clock = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = withLock(lockPath, () => held, { staleMs: Infinity, now: () => clock, isAlive: () => true, sleep: async () => { clock += 5_000; } });
  await new Promise((resolve) => setImmediate(resolve));
  let entered = false;
  const second = withLock(lockPath, async () => { entered = true; }, { staleMs: Infinity, retries: 5, now: () => clock, isAlive: () => true, sleep: async () => { clock += 5_000; } });
  await assert.rejects(second, /could not acquire lock/);
  assert.equal(entered, false, 'a live holder is never displaced by age');
  release();
  await first;
});

test('a dead holder is reclaimed under staleMs: Infinity', async () => {
  const lockPath = join(tmp(), 'transmit.lock');
  await writeFile(lockPath, '4242:1:dead-token');
  let entered = false;
  await withLock(lockPath, async () => { entered = true; }, { staleMs: Infinity, isAlive: () => false, sleep: async () => {} });
  assert.equal(entered, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/memo.test.js test/proc.test.js test/lock.test.js`
Expected: FAIL — `memo.js` missing; `ops.ownerAlive is not a function`. The two lock tests may already pass (they pin existing options); keep them.

- [ ] **Step 3: Implement**

Create `src/bus/memo.js`:

```js
// A liveness predicate that is fresh WITHIN A BOUND, for withLock's holder check on the
// transmission lock. The bus lock's cached predicate (proc.js cachedLockHolderAlive)
// remembers its first answer for the life of the process: right for a section that
// lasts milliseconds, wrong for one that contains a pty write, where a waiter that saw
// the holder alive once would wait out its whole budget after the holder died. This
// forgets after `ttlMs`, so a dead holder is noticed within a second and a Darwin
// waiter (whose fresh check is a `ps -p` spawn) spawns at most once per second rather
// than once per 20 ms retry.
export function memoizeFor(fn, ttlMs, { now = () => Date.now() } = {}) {
  const cache = new Map();
  return (pid, { starttime = null } = {}) => {
    const key = `${pid}:${starttime}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = fn(pid, { starttime });
    cache.set(key, { at: now(), value });
    return value;
  };
}
```

In `src/bus/proc.js`, add to the Linux ops object (after `isAlive`):

```js
      // FRESH IDENTITY, not fresh existence. `isAlive` above re-reads /proc on Linux
      // already; this exists so both platforms expose one predicate with one meaning for
      // the transmission section (spec §3.5), where a stale identity would let a
      // straggler paint a terminal a dead agent used to own.
      ownerAlive(pid, { starttime = null } = {}) {
        return pidExists(pid)
          && Number.isInteger(starttime)
          && freshStartTimeOf(pid) === starttime;
      },
```

and to the Darwin ops object:

```js
      // The snapshot-backed `isAlive` above compares against the memoized -axo table, so
      // a pid recycled after the snapshot still looks alive. This spawns `ps -p <pid>` —
      // acceptable ONLY where it is used: inside the per-session transmission lock, which
      // already contains a pty write, and never inside the bus lock.
      ownerAlive(pid, { starttime = null } = {}) {
        return pidExists(pid)
          && Number.isInteger(starttime)
          && freshStartTimeOf(pid) === starttime;
      },
```

Add at the bottom: `export const ownerAlive = (...args) => defaultProcessOps.ownerAlive(...args);`

- [ ] **Step 4: Run the tests**

Run: `node --test test/memo.test.js test/proc.test.js test/lock.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bus/memo.js src/bus/proc.js test/memo.test.js test/proc.test.js test/lock.test.js
git commit -m "feat(bus): fresh owner identity and a time-bounded liveness memo"
```

---

### Task 6: The ledger module

Spec: §3.5 "Ledger entry", `stamp`, `inherit`, `ledgerName`, lock options.

**Files:**
- Create: `src/render/term/ledger.js`
- Modify: `src/bus/paths.js` (add `transmitDir`, `seqPath`)
- Test: `test/ledger.test.js` (new), `test/paths.test.js`

**Interfaces:**
- Produces:
  - `ledgerName(sessionId)` → `<sanitised ≤40>-<16 hex>`.
  - `ledgerPaths(transmitDir, sessionId)` → `{ entryPath, lockPath }`.
  - `EMPTY_ENTRY = { seq: 0, held: null }`.
  - `fileLedger(entryPath)` → `{ read(): Promise<entry>, write(entry): Promise<void>, remove(): Promise<void> }`.
  - `memoryLedger(initial?)` → same interface plus `.entry` getter and `.writes` array (for tests).
  - `stamp({ held = null, ended = false }, { seq, owner })` → `{ seq, pid, starttime, held, ended }`.
  - `inherit(entry, owner)` → `entry.held` when identity matches, else `null`.
  - `transmitLockOptions({ ownerAlive, startTimeOf, now })` → `{ staleMs: Infinity, retries: 1500, isAlive, startTimeOf }`.
  - `TRANSMIT_LOCK_RETRIES = 1500`, `LIVENESS_MEMO_MS = 1000`.

- [ ] **Step 1: Write the failing tests**

Create `test/ledger.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  ledgerName, ledgerPaths, fileLedger, memoryLedger, stamp, inherit,
  transmitLockOptions, EMPTY_ENTRY, TRANSMIT_LOCK_RETRIES,
} from '../src/render/term/ledger.js';

const OWNER = { pid: 4242, starttime: 987654 };

test('ledgerName is one path component inside transmit/, whatever the session id says', () => {
  const dir = '/state/transmit';
  for (const id of ['../agents', '/etc/passwd', 'a\0b', '..', 'x'.repeat(300), 'plain-id_1']) {
    const name = ledgerName(id);
    assert.doesNotMatch(name, /[/\\\0]/, `${JSON.stringify(id)} -> ${name}`);
    assert.ok(name.length <= 40 + 1 + 16);
    const { entryPath, lockPath } = ledgerPaths(dir, id);
    assert.equal(dirname(entryPath), dir);
    assert.equal(dirname(lockPath), dir);
    assert.notEqual(resolve(entryPath), '/state/agents.json');
    assert.notEqual(resolve(entryPath), '/state/intent.json');
    assert.ok(resolve(entryPath).startsWith(`${dir}/`));
  }
});

test('ledgerName keeps distinct ids distinct after sanitising and is readable', () => {
  assert.notEqual(ledgerName('a/b'), ledgerName('a_b'));
  assert.match(ledgerName('session-42'), /^session-42-[0-9a-f]{16}$/);
  assert.throws(() => ledgerName(''), TypeError);
  assert.throws(() => ledgerName(undefined), TypeError);
});

test('fileLedger reads EMPTY_ENTRY for a missing file and round-trips a write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const ledger = fileLedger(join(dir, 'transmit', 'x.json'));
  assert.deepEqual(await ledger.read(), EMPTY_ENTRY);
  const entry = stamp({ held: { transport: 'direct' } }, { seq: 3, owner: OWNER });
  await ledger.write(entry);
  assert.deepEqual(await ledger.read(), entry);
  await ledger.remove();
  assert.deepEqual(await ledger.read(), EMPTY_ENTRY);
  await ledger.remove();                               // idempotent
});

test('stamp puts the owner identity and the seq on every entry', () => {
  assert.deepEqual(stamp({}, { seq: 9, owner: OWNER }), { seq: 9, pid: 4242, starttime: 987654, held: null, ended: false });
  assert.deepEqual(stamp({ held: null, ended: true }, { seq: 9, owner: OWNER }), { seq: 9, pid: 4242, starttime: 987654, held: null, ended: true });
});

test('inherit carries held only across the same owner', () => {
  const held = { transport: 'direct', capability: 'kitty-animation', id: 1, intent: { state: 'working' } };
  const entry = stamp({ held }, { seq: 1, owner: OWNER });
  assert.equal(inherit(entry, OWNER), held);
  assert.equal(inherit(entry, { pid: 4242, starttime: 1 }), null, 'same pid, new incarnation');
  assert.equal(inherit(entry, { pid: 5, starttime: 987654 }), null);
  assert.equal(inherit(EMPTY_ENTRY, OWNER), null);
});

test('transmitLockOptions never reclaims by age and memoizes liveness for a second', () => {
  let clock = 0;
  let calls = 0;
  const options = transmitLockOptions({ ownerAlive: () => { calls += 1; return true; }, startTimeOf: () => 1, now: () => clock });
  assert.equal(options.staleMs, Infinity);
  assert.equal(options.retries, TRANSMIT_LOCK_RETRIES);
  for (let i = 0; i < 50; i += 1) options.isAlive(7, { starttime: 1 });
  assert.equal(calls, 1);
  clock = 1000;
  options.isAlive(7, { starttime: 1 });
  assert.equal(calls, 2);
});

test('memoryLedger records every write for tests', async () => {
  const ledger = memoryLedger();
  assert.deepEqual(await ledger.read(), EMPTY_ENTRY);
  await ledger.write({ seq: 1 });
  await ledger.write({ seq: 2 });
  assert.deepEqual(ledger.writes.map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(ledger.entry, { seq: 2 });
});
```

Append to `test/paths.test.js`:

```js
test('the transmission ledger and the event counter live under the state dir', () => {
  const p = paths({ HOME: '/h', FAMILIAR_STATE_DIR: '/s' });
  assert.equal(p.transmitDir, '/s/transmit');
  assert.equal(p.seqPath, '/s/events.seq');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ledger.test.js test/paths.test.js`
Expected: FAIL — module missing; `transmitDir` undefined.

- [ ] **Step 3: Implement**

In `src/bus/paths.js`, add two entries to the returned object after `intentPath`:

```js
    // The transmission ledger (spec §3.5): one entry and one lock per session, named by
    // ledgerName() so a session id can never be a path. And the bus-wide event counter.
    transmitDir: join(stateDir, 'transmit'),
    seqPath: join(stateDir, 'events.seq'),
```

Create `src/render/term/ledger.js`:

```js
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { readJson, writeJsonAtomic } from '../../bus/store.js';
import { memoizeFor } from '../../bus/memo.js';

// What the terminal holds, as opposed to what the bus intended. The bus's intent record
// is written by the transaction whether or not any byte reached a terminal; this file is
// written only by the one section that writes the terminal (emit.js), inside the lock
// that serializes those writes. Spec §3.5.
export const EMPTY_ENTRY = Object.freeze({ seq: 0, held: null });

// Sized to wait 30 s at withLock's default 20 ms delay: inside Claude Code's 60 s hook
// budget, and long enough for the pty write the holder may be in the middle of.
export const TRANSMIT_LOCK_RETRIES = 1500;
export const LIVENESS_MEMO_MS = 1000;

// A session id is whatever the agent put in the payload; parsePayload accepts any
// non-empty string, so `../agents` is a valid id and would name agents.json. The
// sanitised prefix keeps the file readable to a person; the hash keeps distinct ids
// distinct after sanitising. The assertion cannot fire — the character class admits no
// separator — and stays as the statement of the invariant.
export function ledgerName(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('ledgerName requires a non-empty session id');
  }
  const prefix = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  const name = `${prefix}-${hash}`;
  if (name.includes('/') || name.includes(sep) || name.includes('\0')) {
    throw new Error(`ledgerName produced a path, not a name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function ledgerPaths(transmitDir, sessionId) {
  const name = ledgerName(sessionId);
  return { entryPath: join(transmitDir, `${name}.json`), lockPath: join(transmitDir, `${name}.lock`) };
}

export function fileLedger(entryPath) {
  return {
    read: async () => (await readJson(entryPath)) ?? EMPTY_ENTRY,
    write: (entry) => writeJsonAtomic(entryPath, entry),
    remove: async () => {
      try { await unlink(entryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

// For tests: the same interface over a variable, plus the write history.
export function memoryLedger(initial = null) {
  let entry = initial;
  const writes = [];
  return {
    read: async () => entry ?? EMPTY_ENTRY,
    write: async (next) => { entry = next; writes.push(next); },
    remove: async () => { entry = null; },
    writes,
    get entry() { return entry; },
  };
}

// EVERY write goes through here, so every entry carries the identity pruning tests.
export function stamp({ held = null, ended = false } = {}, { seq, owner }) {
  return { seq, pid: owner.pid, starttime: owner.starttime, held, ended };
}

// Evidence never survives a change of owner. A resumed session under a new process
// whose first hook was suppressed would otherwise be restamped with the new identity
// while keeping the old process's `held`, and the next graphical hook would `update` an
// image the new terminal never received.
export function inherit(entry, owner) {
  return entry.pid === owner.pid && entry.starttime === owner.starttime ? entry.held : null;
}

export function transmitLockOptions({ ownerAlive, startTimeOf, now = () => Date.now() }) {
  return {
    staleMs: Infinity,
    retries: TRANSMIT_LOCK_RETRIES,
    isAlive: memoizeFor(ownerAlive, LIVENESS_MEMO_MS, { now }),
    startTimeOf,
    now,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/ledger.test.js test/paths.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/term/ledger.js src/bus/paths.js test/ledger.test.js test/paths.test.js
git commit -m "feat(term): transmission ledger entries, names, and lock options"
```

---

### Task 7: The bus-wide event counter replaces `priorIntent`

Spec: §3.5 "Sequence".

**Files:**
- Create: `src/bus/seq.js`
- Modify: `src/bus/transaction.js:142-185` (inside `withLock`), and the `reap` function does **not** change
- Test: `test/seq.test.js` (new), `test/transaction.test.js` (lines 164–167 assert `priorIntent`)

**Interfaces:**
- Produces: `nextSeq(paths)` → `Promise<number>` (call only under the bus lock). `applyHookEvent` returns `{ prev, next, seq, intent, evicted }`; `next.seq` mirrors `seq` for diagnostics. `priorIntent` is gone.

- [ ] **Step 1: Write the failing tests**

Create `test/seq.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextSeq } from '../src/bus/seq.js';
import { readJson } from '../src/bus/store.js';

const statePaths = () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'seq-'));
  return { stateDir, seqPath: join(stateDir, 'events.seq'), transmitDir: join(stateDir, 'transmit') };
};

test('the counter starts at 1 and increments across sessions', async () => {
  const paths = statePaths();
  assert.equal(await nextSeq(paths), 1);
  assert.equal(await nextSeq(paths), 2);
  assert.deepEqual(await readJson(paths.seqPath), { seq: 2 });
});

test('a missing counter is seeded above every ledger it finds, so no ledger can outrank it', async () => {
  const paths = statePaths();
  mkdirSync(paths.transmitDir);
  writeFileSync(join(paths.transmitDir, 'a-0123456789abcdef.json'), JSON.stringify({ seq: 100, pid: 1, starttime: 1, held: null, ended: false }));
  writeFileSync(join(paths.transmitDir, 'b-0123456789abcdef.json'), JSON.stringify({ seq: 7, pid: 2, starttime: 1, held: null, ended: true }));
  writeFileSync(join(paths.transmitDir, 'not-a-ledger.lock'), 'x');
  assert.equal(await nextSeq(paths), 101);
});

test('a corrupt counter is an error, not a restart', async () => {
  const paths = statePaths();
  writeFileSync(paths.seqPath, '{');
  await assert.rejects(nextSeq(paths), /corrupt JSON/);
});
```

In `test/transaction.test.js`, change lines 164–167 (the test asserting `first.priorIntent`) so it asserts the sequence instead — read the surrounding test to keep its name meaningful, then:

```js
  const first = await applyHookEvent({ event: 'SessionStart', stdin, deps });
  assert.equal(first.seq, 1);
  assert.equal('priorIntent' in first, false, 'lifecycle evidence no longer comes from the intent record');
  const second = await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  assert.equal(second.seq, 2);
  assert.equal(second.next.seq, 2);
```

Add a new test in the same file, using its existing `deps`/`stdin` helpers, and its way of ending a session (grep the file for `SessionEnd`):

```js
test('SessionEnd and a resume keep counting — the sequence survives record removal', async () => {
  const a = await applyHookEvent({ event: 'SessionStart', stdin, deps });
  const end = await applyHookEvent({ event: 'SessionEnd', stdin, deps });
  assert.equal(end.next, null);
  assert.equal(end.seq, a.seq + 1);
  const resumed = await applyHookEvent({ event: 'SessionStart', stdin, deps });
  assert.equal(resumed.seq, end.seq + 1, 'a readmitted session does not restart at 1');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/seq.test.js test/transaction.test.js`
Expected: FAIL — `seq.js` missing; `first.seq` undefined.

- [ ] **Step 3: Implement**

Create `src/bus/seq.js`:

```js
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';

// ONE COUNTER FOR THE WHOLE BUS, deliberately not a per-session field on the agent
// record. The record is removed by eviction (commit() evicts and later readmits live
// sessions) and by SessionEnd, while the transmission ledger for that session survives
// both; a per-session counter would restart at 1 under a ledger holding 100 and
// suppress the next hundred events. This never resets, and because it is monotonic
// across all sessions, "which of two events of one session is newer" is still answered
// by comparing it. Call ONLY under the bus lock: the read-increment-write is not atomic.
export async function nextSeq(paths) {
  const current = (await readJson(paths.seqPath))?.seq ?? await seedFromLedgers(paths.transmitDir);
  const seq = current + 1;
  await writeJsonAtomic(paths.seqPath, { seq });
  return seq;
}

// A missing counter with ledgers present (a wiped state directory that kept transmit/,
// or a first run after this feature lands) must start ABOVE every ledger, or an old
// ledger would outrank every new event.
async function seedFromLedgers(transmitDir) {
  let names;
  try { names = await readdir(transmitDir); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let highest = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const entry = await readJson(join(transmitDir, name));
    if (Number.isInteger(entry?.seq) && entry.seq > highest) highest = entry.seq;
  }
  return highest;
}
```

In `src/bus/transaction.js`:
- Add `import { nextSeq } from './seq.js';`
- Inside `withLock`, replace lines 143–148 (the comment block and the two `priorIntent*` lines) with:

```js
    // The event's place in the bus-wide order (src/bus/seq.js). Lifecycle evidence no
    // longer comes from here: it comes from the transmission ledger, written by the one
    // section that writes the terminal (src/render/term/emit.js, spec §3.5). What this
    // transaction contributes is the ORDER those sections compare.
    const seq = await nextSeq(paths);
```

- In the `next = { ... }` literal add `seq,` after `starttime,`.
- Change the return to `return { prev, next, seq, intent, evicted };`

- [ ] **Step 4: Run the tests**

Run: `node --test test/seq.test.js test/transaction.test.js`
Expected: PASS. (`bin/familiar.js` still destructures `priorIntent` and passes it to `emit`; that is Task 11's change — `npm test` will show `bin-familiar` hook tests still passing because `emit` ignores unknown fields until Task 8.)

- [ ] **Step 5: Commit**

```bash
git add src/bus/seq.js src/bus/transaction.js test/seq.test.js test/transaction.test.js
git commit -m "feat(bus): number every event with a bus-wide counter"
```

---

### Task 8: The emission critical section

Spec: §3.5 protocol steps 1–6, §3.3 wrapping, §3.4 `renderTransition`.

**Files:**
- Modify: `src/render/term/emit.js` (whole file)
- Test: `test/emit.test.js`

**Interfaces:**
- Consumes: `graphicsCapability(env, tmux)` (Task 2); `encodeKittyProgram(..., { frame })` (Task 3); `wrapForTmux`, `transportFor` (Task 1); `stamp`, `inherit`, `EMPTY_ENTRY` (Task 6).
- Produces:
  - `async emit({ prev, next, intent, seq, transmitSprite, terminal: { path, env, tmux }, ledger, lock, ownerAlive, readSprite, loadAnimation, plan, encode, readFrame, open, write, close, checkTty })` → `Promise<{ kind: 'superseded'|'ended'|'suppressed'|'unchanged'|'transmitted', reason?, lifecycle?, bytes? }>`. Throws when `terminal`, `seq`, `ledger`, `lock`, or `ownerAlive` is missing.
  - `renderTransition({ prev, next, intent, readSprite, env, tmux, capability })` (adds `tmux`).
  - `bindingFields(intent)` → `{ state, motionPolicy, animation, sprite: { terminal, rows } }` — what `held.intent` stores and compares.

- [ ] **Step 1: Rewrite the test helpers and existing tests**

In `test/emit.test.js`:

1. Add imports: `import { memoryLedger, stamp, EMPTY_ENTRY } from '../src/render/term/ledger.js';`
2. Add after `KITTY_TERMINAL`:

```js
const TMUX_KITTY = Object.freeze({
  ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)',
  client: Object.freeze({ tty: '/dev/pts/16', pid: 9001, created: 1758200000 }),
});
const TMUX_TERMINAL = {
  path: '/proc/4242/fd/1',
  env: { TERM: 'tmux-256color', TMUX: '/tmp/s,1,0', TMUX_PANE: '%0' },
  tmux: TMUX_KITTY,
};
const OWNER = { pid: 4242, starttime: 987654 };
const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;
const directHeld = (state = 'working') => ({
  transport: 'direct', capability: ANIMATION, id: imageIdFor('s1'),
  intent: { state, motionPolicy: 'full', animation: { kind: 'clips', manifest: '/themes/cats/sprites/ginger/animation.yaml', sha256: 'a'.repeat(64) }, sprite: { terminal: '/c/x.png', rows: 8 } },
});
// The section's required collaborators, with the most permissive fakes. Every test that
// cares about one of them overrides it.
const section = (overrides = {}) => ({
  seq: 1,
  ledger: memoryLedger(),
  lock: (fn) => fn(),
  ownerAlive: () => true,
  ...overrides,
});
```

3. Make `captureEmission` async and use the section defaults; remove `priorIntent: null`:

```js
async function captureEmission(overrides = {}) {
  const writes = [];
  const opens = [];
  const result = await emit({
    prev: null,
    next: agentAt('working'),
    intent: clipsIntent(),
    terminal: KITTY_TERMINAL,
    loadAnimation: () => clipsSet,
    readFrame: () => FAKE_PNG,
    open: (path) => { opens.push(path); return 7; },
    write: (fd, bytes, offset, length) => {
      writes.push({ fd, bytes: Buffer.from(bytes.subarray(offset, offset + length)) });
      return length;
    },
    close: () => {},
    checkTty: () => true,
    ...section(),
    ...overrides,
  });
  return { result, writes, opens, bytes: Buffer.concat(writes.map((entry) => entry.bytes)) };
}
```

4. Migrate every existing caller — the PASS gate below cannot hold otherwise:
   - All 14 `captureEmission(` calls: make the enclosing test `async` and `await` the call (destructuring `const { bytes } = await captureEmission(...)`).
   - Every direct `emit({ ... })` call: make the test `async`, `await` it, spread `...section()` into the options, and delete `priorIntent: …`.
   - Every `assert.throws` whose callee is `emit(` ("emit requires an explicit terminal target" near 475, and the two near 760 and 785 — check each callee before changing it) becomes `await assert.rejects(emit({ ...section(), ... }), /pattern/)` — `emit` is async now, so its argument validation surfaces as a rejection. `assert.throws` whose callee is `renderTransition(` — the "emit takes an Intent, NOT an IntentRecord" test near 280 and the one near 446 — stays synchronous. Where a test relied on `priorIntent` to obtain `update` (the tests at ~633 "later full Kitty transition updates in place", ~650 "reduced Kitty … staged root composition later"), replace it with a ledger holding the prior evidence:

```js
    ...section({ seq: 2, ledger: memoryLedger(stamp({ held: { ...directHeld('idle'), intent: { ...directHeld('idle').intent, motionPolicy: 'full' } } }, { seq: 1, owner: OWNER })) }),
```

(For the `reduced` case set `motionPolicy: 'reduced'` inside `intent`.) Where a test asserted the old return values (`false`, `undefined`, a byte count — tests at ~461–548), assert `.kind` instead: `'unchanged'` for a same-state hook that wrote nothing, `'suppressed'` for open failure and non-tty, `'transmitted'` for a successful write. Where "later Ghostty transitions send a fresh static root" (~677) used `priorIntent`, give it a ledger with `capability: GRAPHICS_CAPABILITY.STATIC` held evidence and assert `create` controls (`a=T`) and no `a=a`/`a=f`.

5. Add the new tests:

```js
// --- the critical section: what the terminal received, not what the bus intended ------

test('the section refuses to run without its evidence, lock, liveness, or order', async () => {
  const base = { prev: null, next: agentAt('working'), intent: clipsIntent(), terminal: KITTY_TERMINAL };
  await assert.rejects(emit({ ...base, ...section({ seq: undefined }) }), /seq/);
  await assert.rejects(emit({ ...base, ...section({ ledger: undefined }) }), /ledger/);
  await assert.rejects(emit({ ...base, ...section({ lock: undefined }) }), /lock/);
  await assert.rejects(emit({ ...base, ...section({ ownerAlive: undefined }) }), /ownerAlive/);
});

test('with no ledger entry a consistent prev/intent is still a CREATE — the bus is not evidence', async () => {
  const { bytes, result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 5 }) });
  assert.equal(result.kind, 'transmitted');
  assert.equal(result.lifecycle, 'create');
  assert.match(bytes.toString('latin1'), /a=T,|a=t,/);
  assert.doesNotMatch(bytes.toString('latin1'), /a=a,i=\d+,s=1/);
});

test('a same-transport, same-owner entry with a changed intent is an UPDATE under Kitty', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER }));
  const { bytes, result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 2, ledger }) });
  assert.equal(result.lifecycle, 'update');
  assert.match(bytes.toString('latin1'), /a=a,i=\d+,s=1,q=2/);
  assert.equal(ledger.entry.held.intent.state, 'working');
  assert.equal(ledger.entry.seq, 2);
});

test('a different transport is a CREATE: another client, the same tty path reused, or direct vs tmux', async () => {
  for (const [held, terminal, label] of [
    [{ ...directHeld('idle'), transport: 'tmux:/dev/pts/5:1:1' }, TMUX_TERMINAL, 'another client tty'],
    [{ ...directHeld('idle'), transport: 'tmux:/dev/pts/16:8000:1758100000' }, TMUX_TERMINAL, 'same tty path, new client incarnation'],
    [directHeld('idle'), TMUX_TERMINAL, 'direct evidence, tmux now'],
    [{ ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' }, KITTY_TERMINAL, 'tmux evidence, direct now'],
  ]) {
    const ledger = memoryLedger(stamp({ held }, { seq: 1, owner: OWNER }));
    const { result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), terminal, ...section({ seq: 2, ledger }) });
    assert.equal(result.lifecycle, 'create', label);
  }
  const same = memoryLedger(stamp({ held: { ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' } }, { seq: 1, owner: OWNER }));
  const { result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), terminal: TMUX_TERMINAL, ...section({ seq: 2, ledger: same }) });
  assert.equal(result.lifecycle, 'update', 'identical incarnation');
});

test('STATIC capability is always a CREATE, even with valid evidence', async () => {
  const ghostty = { path: '/proc/4242/fd/1', env: { TERM_PROGRAM: 'ghostty' }, tmux: null };
  const ledger = memoryLedger(stamp({ held: { ...directHeld('idle'), capability: GRAPHICS_CAPABILITY.STATIC } }, { seq: 1, owner: OWNER }));
  const first = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), terminal: ghostty, ...section({ seq: 2, ledger }) });
  assert.equal(first.result.lifecycle, 'create');
  const second = await captureEmission({ prev: agentAt('working'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'), terminal: ghostty, ...section({ seq: 3, ledger }) });
  assert.equal(second.result.lifecycle, 'create');
  assert.doesNotMatch(second.bytes.toString('latin1'), /a=a,|a=f,/);
});

test('inside tmux every APC is inside DCS passthrough and none is bare', async () => {
  const { bytes } = await captureEmission({ terminal: TMUX_TERMINAL });
  const text = bytes.toString('latin1');
  assert.equal(bareApcs(text), 0, 'no bare APC');
  assert.ok(text.split('\x1bPtmux;').length > 1);
  // The presentation (tint) is NOT wrapped: tmux handles OSC itself.
  assert.ok(text.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`));
});

test('a refused tmux pane sends tint but no graphics, and leaves the evidence alone', async () => {
  const ledger = memoryLedger(stamp({ held: { ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' } }, { seq: 1, owner: OWNER }));
  const { bytes, result } = await captureEmission({
    prev: agentAt('idle'), next: agentAt('working'),
    terminal: { ...TMUX_TERMINAL, tmux: { ok: false, reason: 'no-client' } },
    ...section({ seq: 2, ledger }),
  });
  assert.equal(result.kind, 'unchanged');
  assert.doesNotMatch(bytes.toString('latin1'), /_G/);
  assert.ok(bytes.toString('latin1').includes(`\x1b]11;`));
  assert.deepEqual(ledger.entry.held, { ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' }, 'held preserved: nothing on that client changed');
  assert.equal(ledger.entry.seq, 2);
});

test('three identical hooks after a create send zero graphics bytes and keep held byte-identical', async () => {
  const ledger = memoryLedger();
  await captureEmission({ ...section({ seq: 1, ledger }) });
  const published = JSON.stringify(ledger.entry.held);
  for (const seq of [2, 3, 4]) {
    const { bytes, result } = await captureEmission({ prev: agentAt('working'), next: agentAt('working'), ...section({ seq, ledger }) });
    assert.equal(result.kind, 'unchanged');
    assert.equal(bytes.length, 0);
    assert.equal(JSON.stringify(ledger.entry.held), published);
    assert.equal(ledger.entry.seq, seq);
  }
});

test('an older event arriving after a newer one is SUPERSEDED and writes nothing', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('needs-input') }, { seq: 2, owner: OWNER }));
  const { bytes, result, opens } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 1, ledger }) });
  assert.equal(result.kind, 'superseded');
  assert.equal(bytes.length, 0);
  assert.deepEqual(opens, []);
  assert.deepEqual(ledger.writes, []);
});

test('SessionEnd writes a tombstone with prev\'s identity, then the reset; a straggler meets the tombstone', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld() }, { seq: 2, owner: OWNER }));
  const end = await captureEmission({ prev: agentAt('working'), next: null, intent: { identity: { project: 'api' }, pid: 4242, sessionId: 's1' }, ...section({ seq: 3, ledger }) });
  assert.equal(end.result.kind, 'ended');
  assert.deepEqual(ledger.entry, { seq: 3, pid: 4242, starttime: 987654, held: null, ended: true });
  assert.ok(end.bytes.toString('latin1').includes('\x1b]111'), 'the reset went out');
  const straggler = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 2, ledger }) });
  assert.equal(straggler.result.kind, 'superseded');
  assert.equal(ledger.entry.ended, true);
});

test('the ownership gate withholds EVERY byte from a dead owner: graphics, tint, bell, reset', async () => {
  const dead = { ownerAlive: () => false };
  const shapes = [
    ['graphical', {}],
    ['NONE capability', { terminal: { path: '/proc/4242/fd/1', env: { TERM: 'dumb' }, tmux: null } }],
    ['motion off', { intent: clipsIntent('working', 'off') }],
    ['no sprite', { transmitSprite: false }],
  ];
  for (const [label, overrides] of shapes) {
    const ledger = memoryLedger();
    const { bytes, opens, result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'), ...overrides, ...section({ seq: 2, ledger, ...dead }) });
    assert.equal(result.kind, 'suppressed', label);
    assert.equal(result.reason, 'owner-dead', label);
    assert.equal(bytes.length, 0, label);
    assert.deepEqual(opens, [], label);
    assert.deepEqual(ledger.entry, { seq: 2, pid: 4242, starttime: 987654, held: null, ended: false }, `${label}: identity stamped, nothing held`);
  }
  const ledger = memoryLedger();
  const end = await captureEmission({ prev: agentAt('working'), next: null, intent: { identity: { project: 'api' }, pid: 4242, sessionId: 's1' }, ...section({ seq: 3, ledger, ...dead }) });
  assert.equal(end.result.kind, 'suppressed');
  assert.equal(end.bytes.length, 0);
  assert.equal(ledger.entry.ended, true, 'the tombstone is ordering evidence and is still written');
});

test('the first write under a new owner drops the old owner\'s evidence; the next graphical hook CREATES', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('working') }, { seq: 5, owner: OWNER }));
  const B = { pid: 5150, starttime: 111 };
  const suppressedShapes = [
    ['NONE capability', { terminal: { path: '/proc/5150/fd/1', env: { TERM: 'dumb' }, tmux: null } }],
    ['tty gate', { checkTty: () => false }],
  ];
  for (const [label, overrides] of suppressedShapes) {
    ledger.write(stamp({ held: directHeld('working') }, { seq: 5, owner: OWNER }));
    const first = await captureEmission({ prev: agentAt('working'), next: agentAt('working', B), ...overrides, ...section({ seq: 6, ledger }) });
    assert.notEqual(first.result.kind, 'transmitted', label);
    assert.deepEqual([ledger.entry.pid, ledger.entry.starttime, ledger.entry.held], [5150, 111, null], `${label}: identity B, nothing inherited`);
    const identical = await captureEmission({ prev: agentAt('working', B), next: agentAt('working', B), ...section({ seq: 7, ledger }) });
    assert.equal(identical.result.kind, 'transmitted', `${label}: identical intent is not 'unchanged' under a new owner`);
    assert.equal(identical.result.lifecycle, 'create');
    const changed = await captureEmission({ prev: agentAt('working', B), next: agentAt('needs-input', B), intent: clipsIntent('needs-input'), ...section({ seq: 8, ledger }) });
    assert.equal(changed.result.lifecycle, 'update', `${label}: after B's own create, B's evidence is valid`);
  }
});

test('a first event that is suppressed or fails the tty gate still stamps its identity', async () => {
  for (const overrides of [{ terminal: { path: '/proc/4242/fd/1', env: { TERM: 'dumb' }, tmux: null } }, { checkTty: () => false }, { open: () => { throw new Error('ENOENT'); } }]) {
    const ledger = memoryLedger();
    await captureEmission({ ...overrides, ...section({ seq: 1, ledger }) });
    assert.deepEqual([ledger.entry.pid, ledger.entry.starttime, ledger.entry.seq], [4242, 987654, 1]);
  }
});

test('renderTransition wraps a static pose only when the probe says tmux is ok', () => {
  const plain = renderTransition({ prev: 'idle', next: 'working', intent: intentAt('working'), readSprite, capability: ANIMATION, tmux: null });
  const wrapped = renderTransition({ prev: 'idle', next: 'working', intent: intentAt('working'), readSprite, capability: ANIMATION, tmux: TMUX_KITTY });
  assert.ok(plain.includes(SPRITE));
  assert.equal(bareApcs(wrapped), 0, 'SPRITE still occurs inside the doubled-ESC form; only an unpreceded ESC _ G is bare');
  assert.ok(wrapped.includes('\x1bPtmux;\x1b\x1b_Ga=T'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/emit.test.js`
Expected: FAIL broadly — `emit` is synchronous and ignores `ledger`/`seq`.

- [ ] **Step 3: Rewrite `src/render/term/emit.js`**

Replace the file with the following. Keep the existing long-form comments where the code they explain survives (the `renderTransition` env comment, the "THE CAT IS NO LONGER PRINTED" block, the fd/tty comments); the code below marks where they go.

```js
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { oscBackground, oscCursor, oscReset, BEL } from './osc.js';
import { GRAPHICS_CAPABILITY, graphicsCapability } from './capability.js';
import { transmitVirtual, imageIdFor } from './placeholder.js';
import { wrapForTmux, transportFor } from './tmux.js';
import { boxFor } from './box.js';
import { loadAnimationRefSync } from 'familiar-theme';
import { planAnimation } from '../../animation/program.js';
import { encodeKittyProgram } from './kitty-animation.js';
import { writeAllSync } from './io.js';
import { stamp, inherit } from './ledger.js';

// The three states worth interrupting you for.
const RINGS = new Set(['needs-input', 'needs-approval', 'error']);

// [keep the existing NO DEFAULT FOR `env` comment here]
export function renderTransition({
  prev, next, intent,
  readSprite = (p) => readFileSync(p),
  env,                                         // required, unless `capability` is given outright
  tmux,                                        // the probe result for `env`; decides FRAMING, not sending
  capability = graphicsCapability(env, tmux),  // the ANSWER is derived from them
}) {
  if (!intent?.identity) {
    throw new Error('intent.identity is undefined — did you pass an IntentRecord instead of its .current?');
  }
  if (next === null) return oscReset();
  if (prev === next) return '';
  return [
    capability === GRAPHICS_CAPABILITY.ANIMATION || capability === GRAPHICS_CAPABILITY.STATIC
      ? transmitPose({ intent, readSprite, tmux })
      : '',
    oscBackground(intent.color.backdrop),
    oscCursor(intent.color.base),
    RINGS.has(next) ? BEL : '',
  ].join('');
}

// [keep the existing THE CAT IS NO LONGER PRINTED comment here]
function transmitPose({ intent, readSprite, tmux }) {
  const png = readSprite(intent.sprite.terminal);
  const escapes = transmitVirtual(png, {
    id: imageIdFor(intent.sessionId),
    ...boxFor(png, intent.sprite.rows),
  });
  // Framed when the PROBE says the pane forwards passthrough — $TMUX alone is the inner
  // environment's claim, and the probe is the server's answer.
  return tmux?.ok ? wrapForTmux(escapes) : escapes;
}

// The fields of an intent that decide whether the terminal must be redrawn. This is what
// the ledger stores as `held.intent`; nothing else about an intent changes the pixels.
export function bindingFields(intent) {
  return {
    state: intent.state,
    motionPolicy: intent.motionPolicy,
    animation: intent.animation,
    sprite: { terminal: intent.sprite.terminal, rows: intent.sprite.rows },
  };
}

const sameBinding = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// THE EMISSION CRITICAL SECTION (docs/specs/2026-09-18-tmux-rendering-design.md §3.5).
//
// Everything that decides create-versus-update-versus-nothing, and every byte written to
// the agent's terminal, happens inside `lock`, in this order: read the ledger, gate on
// order and on the owner being alive, decide, null the evidence, write the terminal,
// publish the evidence. The ledger says what the TERMINAL holds; the bus's intent record
// says what familiar meant, and that used to be the evidence — a hook whose emission was
// suppressed still left an intent behind, and the next hook `update`d an image no
// terminal had. Two hooks of one session also used to interleave bytes on the same pty;
// the lock ends that.
//
// `seq` is the event's place in the bus-wide order (src/bus/seq.js). `ledger`, `lock`,
// and `ownerAlive` are REQUIRED, like `terminal`: the section cannot run without its
// evidence, its serialization, and its liveness check, and a caller that forgets one gets
// told rather than getting a section that silently runs unprotected.
export async function emit({
  prev, next, intent, seq,
  readSprite = (p) => readFileSync(p), transmitSprite = true,
  terminal,
  ledger, lock, ownerAlive,
  loadAnimation = loadAnimationRefSync,
  plan = planAnimation,
  encode = encodeKittyProgram,
  readFrame = readSprite,
  open = openSync, write = writeSync, close = closeSync, checkTty = isatty,
}) {
  if (!terminal || typeof terminal.path !== 'string') {
    throw new Error('emit requires terminal { path, env, tmux }');
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error('emit requires seq — the event\'s place in the bus order, from the transaction');
  }
  if (!ledger) throw new Error('emit requires ledger — the transmission ledger for this session');
  if (typeof lock !== 'function') throw new Error('emit requires lock — the per-session transmission lock');
  if (typeof ownerAlive !== 'function') throw new Error('emit requires ownerAlive — the fresh liveness predicate');
  const owner = next ?? prev;
  if (!owner) throw new Error('emit needs a record to own the terminal: prev and next are both null');
  const { env, tmux } = terminal;

  // Writes bytes to the terminal, or reports that it could not. Silent on a missing
  // process or fd: nothing to paint, not an error. [keep the isatty() comment here]
  const writeTerminal = (bytes) => {
    let fd;
    try { fd = open(terminal.path, 'a'); } catch { return { written: false, reason: 'open' }; }
    try {
      if (!checkTty(fd)) return { written: false, reason: 'not-a-tty' };
      writeAllSync(bytes, { fd, write });
      return { written: true };
    } finally {
      close(fd);
    }
  };

  return lock(async () => {
    const entry = await ledger.read();
    const stampWith = (fields) => stamp(fields, { seq, owner });

    // 1. Order. A newer event already owns the terminal — whether it ran before we got
    //    the lock, or we are a straggler arriving after SessionEnd's tombstone.
    if (entry.seq >= seq) return { kind: 'superseded' };

    // 2. Ownership. Every byte below goes to a terminal `owner` is supposed to own; a
    //    straggler of an exited agent must not tint a pty the kernel has since handed to
    //    someone else, and on Darwin the /dev/ttys path can outlive the process.
    const alive = ownerAlive(owner.pid, { starttime: owner.starttime });

    // 3. SessionEnd: the tombstone first (it is ordering evidence, written even for a
    //    dead owner), then the reset, which needs no evidence.
    if (next === null) {
      await ledger.write(stampWith({ held: null, ended: true }));
      if (!alive) return { kind: 'suppressed', reason: 'owner-dead' };
      writeTerminal(Buffer.from(oscReset()));
      return { kind: 'ended' };
    }

    const held = inherit(entry, owner);
    if (!alive) {
      await ledger.write(stampWith({ held }));
      return { kind: 'suppressed', reason: 'owner-dead' };
    }

    // 4. Decide. Evidence is valid only for the same owner (inherit) AND the same
    //    transport; `update` additionally needs a terminal that accepts animation
    //    commands — Ghostty does not, so STATIC is always a fresh create.
    const capability = env === undefined ? GRAPHICS_CAPABILITY.NONE : graphicsCapability(env, tmux);
    const transport = transportFor(tmux);
    const evidence = held !== null && held.transport === transport;
    const lifecycle = evidence && capability === GRAPHICS_CAPABILITY.ANIMATION ? 'update' : 'create';
    const graphical = transmitSprite
      && capability !== GRAPHICS_CAPABILITY.NONE
      && intent.motionPolicy !== 'off'
      && (!evidence || !sameBinding(held.intent, bindingFields(intent)));
    const presentation = renderTransition({
      prev: prev?.state ?? null,
      next: next.state,
      intent,
      readSprite,
      env,
      tmux,
      capability: GRAPHICS_CAPABILITY.NONE,     // graphics come from encode() below, never from here
    });

    // 5. Unchanged (or nothing graphical possible): the evidence stands, the order advances.
    if (!graphical) {
      await ledger.write(stampWith({ held }));
      if (presentation.length > 0) writeTerminal(Buffer.from(presentation));
      return { kind: 'unchanged' };
    }

    // 6. Graphics. The byte plan is complete before the fd is opened, so planning,
    //    encoding and limit checks cannot strand a partial program on the terminal.
    const set = loadAnimation(intent.animation);
    const program = plan({
      set, root: intent.sprite.terminal, state: intent.state, sessionId: intent.sessionId,
      policy: intent.motionPolicy, capability,
    });
    if (program.kind === 'none') {
      throw new Error('terminal animation: graphical capability produced no program');
    }
    const frameCache = new Map();
    const readCachedFrame = (path) => {
      if (!frameCache.has(path)) frameCache.set(path, Buffer.from(readFrame(path)));
      return frameCache.get(path);
    };
    const id = imageIdFor(intent.sessionId);
    const graphics = encode(program, {
      id,
      placement: { kind: 'virtual', ...boxFor(readCachedFrame(intent.sprite.terminal), intent.sprite.rows) },
      lifecycle,
      readFrame: readCachedFrame,
      frame: tmux?.ok ? wrapForTmux : (command) => command,
    }).bytes;
    const bytes = Buffer.concat([graphics, Buffer.from(presentation)]);

    let fd;
    try { fd = open(terminal.path, 'a'); } catch {
      await ledger.write(stampWith({ held }));
      return { kind: 'suppressed', reason: 'open' };
    }
    try {
      if (!checkTty(fd)) {
        await ledger.write(stampWith({ held }));
        return { kind: 'suppressed', reason: 'not-a-tty' };
      }
      // WRITE-AHEAD: from here until publish, the ledger says nothing is held. A partial
      // write, a crash, or a failed publish all leave that state, and the next event
      // creates. A failed write-ahead throws before any terminal byte.
      await ledger.write(stampWith({ held: null }));
      writeAllSync(bytes, { fd, write });
      await ledger.write(stampWith({ held: { transport, capability, id, intent: bindingFields(intent) } }));
      return { kind: 'transmitted', lifecycle, bytes: bytes.length };
    } finally {
      close(fd);
    }
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/emit.test.js`
Expected: PASS. Then `npm test` — expect `bin-familiar.test.js` hook tests to FAIL because `bin/familiar.js` still calls the old signature; that is Task 11. Do not fix them here.

- [ ] **Step 5: Commit**

```bash
git add src/render/term/emit.js test/emit.test.js
git commit -m "feat(term): decide lifecycle from the transmission ledger inside one section"
```

---

### Task 9: Ordering, interleaving, and failure tests for the section

Spec: §5 "the critical section" bullets. Behaviour is implemented in Task 8; this task pins it.

**Files:**
- Test: `test/emit.test.js`, `test/emit-section.test.js` (new, for the real-lock test)

- [ ] **Step 1: Write the ordering and interleaving tests**

Append to `test/emit.test.js`:

```js
// --- ordering inside the section --------------------------------------------------------

test('a graphical event does read → open → isatty → write-ahead → terminal → publish → close', async () => {
  const trace = [];
  const ledger = {
    read: async () => { trace.push('read'); return EMPTY_ENTRY; },
    write: async (entry) => { trace.push(entry.held === null ? 'write-ahead' : 'publish'); },
  };
  await captureEmission({
    ...section({ ledger }),
    open: () => { trace.push('open'); return 7; },
    checkTty: () => { trace.push('isatty'); return true; },
    write: (fd, bytes, offset, length) => { if (!trace.includes('terminal')) trace.push('terminal'); return length; },
    close: () => { trace.push('close'); },
  });
  assert.deepEqual(trace, ['read', 'open', 'isatty', 'write-ahead', 'terminal', 'publish', 'close']);
});

// A lock that hands out the section in the order the TEST dictates, so both interleavings
// of two events can be forced rather than hoped for.
function scriptedLock() {
  const waiting = [];
  let busy = false;
  const release = () => {
    const nextUp = waiting.shift();
    if (nextUp) nextUp(); else busy = false;
  };
  return async (fn) => {
    if (busy) await new Promise((resolve) => waiting.push(resolve));
    busy = true;
    try { return await fn(); } finally { release(); }
  };
}

test('both interleavings of S=1 (working) and S=2 (needs-input) end with needs-input on the terminal and in the ledger', async () => {
  for (const order of [[1, 2], [2, 1]]) {
    const ledger = memoryLedger();
    const lock = scriptedLock();
    const writes = [];
    const run = (seq) => captureEmission({
      prev: agentAt('idle'),
      next: agentAt(seq === 1 ? 'working' : 'needs-input'),
      intent: clipsIntent(seq === 1 ? 'working' : 'needs-input'),
      ...section({ seq, ledger, lock }),
      write: (fd, bytes, offset, length) => { writes.push({ seq, bytes: Buffer.from(bytes.subarray(offset, offset + length)) }); return length; },
    });
    const results = await Promise.all(order.map(run));
    const bySeq = Object.fromEntries(order.map((seq, i) => [seq, results[i].result]));
    assert.equal(ledger.entry.held.intent.state, 'needs-input', `order ${order}`);
    assert.equal(ledger.entry.seq, 2, `order ${order}`);
    const lastGraphics = writes.filter((w) => w.bytes.includes('_G')).at(-1);
    assert.equal(lastGraphics.seq, 2, `order ${order}: the newest event painted last`);
    if (order[0] === 2) {
      assert.equal(bySeq[1].kind, 'superseded', 'the older event, arriving second, wrote nothing');
      assert.equal(writes.filter((w) => w.seq === 1).length, 0);
    } else {
      assert.equal(bySeq[1].kind, 'transmitted');
      assert.equal(bySeq[2].kind, 'transmitted');
    }
  }
});

// --- failures with an existing entry ------------------------------------------------------

test('a terminal write that fails mid-stream leaves held: null, and the next hook CREATES — not unchanged', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('working') }, { seq: 1, owner: OWNER }));
  let calls = 0;
  await assert.rejects(captureEmission({
    prev: agentAt('working'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'),
    ...section({ seq: 2, ledger }),
    write: () => { calls += 1; if (calls === 2) throw new Error('EIO'); return 4096; },
  }), /EIO/);
  assert.deepEqual([ledger.entry.seq, ledger.entry.held], [2, null]);
  const next = await captureEmission({ prev: agentAt('needs-input'), next: agentAt('working'), ...section({ seq: 3, ledger }) });
  assert.equal(next.result.kind, 'transmitted');
  assert.equal(next.result.lifecycle, 'create');
});

test('a publish that fails after a complete terminal write leaves held: null; the next hook CREATES', async () => {
  const backing = memoryLedger(stamp({ held: directHeld('working') }, { seq: 1, owner: OWNER }));
  let writesSeen = 0;
  const ledger = { read: backing.read, write: async (entry) => { writesSeen += 1; if (writesSeen === 2) throw new Error('ENOSPC'); return backing.write(entry); } };
  await assert.rejects(captureEmission({ prev: agentAt('working'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'), ...section({ seq: 2, ledger }) }), /ENOSPC/);
  assert.equal(backing.entry.held, null);
  const next = await captureEmission({ prev: agentAt('needs-input'), next: agentAt('working'), ...section({ seq: 3, ledger: backing }) });
  assert.equal(next.result.lifecycle, 'create');
});

test('a failed write-ahead throws before any terminal byte', async () => {
  const ledger = { read: async () => EMPTY_ENTRY, write: async () => { throw new Error('EROFS'); } };
  const writes = [];
  await assert.rejects(captureEmission({ ...section({ ledger }), write: (fd, bytes, offset, length) => { writes.push(length); return length; } }), /EROFS/);
  assert.deepEqual(writes, []);
});

test('a suppressed event (tty gate) preserves held and advances seq', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER }));
  const { result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 2, ledger }), checkTty: () => false });
  assert.equal(result.kind, 'suppressed');
  assert.deepEqual(ledger.entry.held, directHeld('idle'));
  assert.equal(ledger.entry.seq, 2);
});
```

- [ ] **Step 2: Write the real-lock test**

Create `test/emit-section.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit } from '../src/render/term/emit.js';
import { withLock } from '../src/bus/lock.js';
import { fileLedger, ledgerPaths, transmitLockOptions } from '../src/render/term/ledger.js';
import { identityColors } from '../src/theme/ramp.js';
import { encodeRgba } from 'familiar-theme';

// Two sections for ONE session, started concurrently in one process, against the REAL
// withLock and a real ledger file. The fakes above prove the protocol; this proves the
// lock actually serializes it.
const COLOR = identityColors(6, { mode: 'dark', satScale: 1 });
const PNG = encodeRgba({ w: 200, h: 400, buf: new Uint8Array(200 * 400 * 4) });
const intentAt = (state) => ({
  sessionId: 's1', pid: 4242,
  identity: { projectKey: 'k', project: 'api', slot: 6, member: 'm', label: 'M' },
  state, urgency: 'none', motion: 'pulse', motionPolicy: 'full', animation: { kind: 'static' },
  color: COLOR, sprite: { terminal: '/c/x.png', rows: 8 },
});

test('two concurrent sections for one session serialize under the real lock and agree with the terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'section-'));
  const { entryPath, lockPath } = ledgerPaths(join(dir, 'transmit'), 's1');
  const ledger = fileLedger(entryPath);
  const lock = (fn) => withLock(lockPath, fn, transmitLockOptions({ ownerAlive: () => true, startTimeOf: () => 1 }));
  const terminal = { path: '/dev/null', env: { TERM: 'xterm-kitty' }, tmux: null };
  const painted = [];
  let inside = 0;
  let overlap = 0;
  const run = (seq, state) => emit({
    prev: { sessionId: 's1', state: 'idle', pid: 4242, starttime: 1 },
    next: { sessionId: 's1', state, pid: 4242, starttime: 1 },
    intent: intentAt(state), seq, terminal, ledger, lock, ownerAlive: () => true,
    readSprite: () => PNG, readFrame: () => PNG,
    open: () => { inside += 1; if (inside > 1) overlap += 1; return 7; },
    write: (fd, bytes, offset, length) => { painted.push({ seq, state }); return length; },
    close: () => { inside -= 1; },
    checkTty: () => true,
  });
  const [a, b] = await Promise.all([run(1, 'working'), run(2, 'needs-input')]);
  assert.equal(overlap, 0, 'the fd was never open in two sections at once');
  const entry = await ledger.read();
  assert.equal(entry.seq, 2);
  assert.equal(entry.held.intent.state, 'needs-input');
  assert.equal(painted.at(-1).state, 'needs-input');
  assert.ok([a.kind, b.kind].includes('transmitted'));
});
```

- [ ] **Step 3: Run**

Run: `node --test test/emit.test.js test/emit-section.test.js`
Expected: PASS. If the interleaving test's `[2, 1]` branch fails because `Promise.all` starts both before either acquires, that is the scripted lock doing its job: both call `lock` in array order, so `2` enters first. If it does not, make `run` `await` a `setImmediate` between the two starts.

- [ ] **Step 4: Commit**

```bash
git add test/emit.test.js test/emit-section.test.js
git commit -m "test(term): pin section ordering, interleavings, and failure recovery"
```

---

### Task 10: Ledger pruning

Spec: §3.5 "Pruning".

**Files:**
- Create: `src/render/term/ledger-prune.js`
- Test: `test/ledger-prune.test.js` (new)

**Interfaces:**
- Consumes: `ledgerName`, `fileLedger`, `transmitLockOptions` (Task 6); `withLock` signature.
- Produces: `pruneLedgers({ transmitDir, agents, ownerAlive, startTimeOf, lockWith = withLock, readdir })` → `Promise<{ removed: string[], skipped: string[] }>` (ledger names). Never called under the bus lock.

- [ ] **Step 1: Write the failing tests**

Create `test/ledger-prune.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLedgers } from '../src/render/term/ledger-prune.js';
import { fileLedger, ledgerPaths, ledgerName, stamp } from '../src/render/term/ledger.js';

const setup = async () => {
  const transmitDir = join(mkdtempSync(join(tmpdir(), 'prune-')), 'transmit');
  const write = async (sessionId, owner, extra = {}) => {
    const { entryPath } = ledgerPaths(transmitDir, sessionId);
    await fileLedger(entryPath).write(stamp({ held: null, ...extra }, { seq: 1, owner }));
    return entryPath;
  };
  return { transmitDir, write };
};

test('only sessions absent from the agents snapshot are candidates, and only dead ones are removed', async () => {
  const { transmitDir, write } = await setup();
  const live = await write('live', { pid: 1, starttime: 1 });
  const ended = await write('ended-alive', { pid: 2, starttime: 2 }, { ended: true });
  const dead = await write('ended-dead', { pid: 3, starttime: 3 }, { ended: true });
  const asked = [];
  const result = await pruneLedgers({
    transmitDir,
    agents: { live: { pid: 1, starttime: 1 } },
    ownerAlive: (pid, { starttime }) => { asked.push(pid); return pid !== 3; },
    startTimeOf: () => 1,
  });
  assert.deepEqual(asked.sort(), [2, 3], 'the live session was never asked about');
  assert.deepEqual(result.removed, [ledgerName('ended-dead')]);
  assert.ok(existsSync(live) && existsSync(ended) && !existsSync(dead));
});

test('a candidate whose lock is busy is skipped this pass, not removed', async () => {
  const { transmitDir, write } = await setup();
  const path = await write('busy', { pid: 9, starttime: 9 });
  const result = await pruneLedgers({
    transmitDir, agents: {}, ownerAlive: () => false, startTimeOf: () => 1,
    lockWith: async () => { throw new Error('could not acquire lock'); },
  });
  assert.deepEqual(result, { removed: [], skipped: [ledgerName('busy')] });
  assert.ok(existsSync(path));
});

test('a missing transmit dir is nothing to prune', async () => {
  assert.deepEqual(await pruneLedgers({ transmitDir: '/nonexistent/transmit', agents: {}, ownerAlive: () => false, startTimeOf: () => 1 }), { removed: [], skipped: [] });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ledger-prune.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/render/term/ledger-prune.js`:

```js
import { readdir as readdirDefault } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock } from '../../bus/lock.js';
import { readJson } from '../../bus/store.js';
import { fileLedger, ledgerName, transmitLockOptions } from './ledger.js';

// Pruning has ONE condition: the entry's owner is dead by the fresh predicate. "No agent
// record" is not a condition — after SessionEnd the record is gone while the agent and
// any hook it spawned may still run, and the tombstone exists precisely to supersede
// such a straggler. The agents snapshot only narrows the CANDIDATES, so the usual cost is
// one readdir and no liveness call (which on Darwin is a `ps -p` spawn — the reason this
// never runs inside the bus lock).
//
// Each candidate is handled under its session's transmission lock so a live section can
// never see its entry vanish between read and publish. A busy lock means skip this pass.
export async function pruneLedgers({
  transmitDir, agents, ownerAlive, startTimeOf,
  lockWith = withLock, readdir = readdirDefault, now = () => Date.now(),
}) {
  let names;
  try { names = await readdir(transmitDir); } catch (error) {
    if (error.code === 'ENOENT') return { removed: [], skipped: [] };
    throw error;
  }
  const liveNames = new Set(Object.keys(agents).map(ledgerName));
  const removed = [];
  const skipped = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    if (liveNames.has(name)) continue;
    const entryPath = join(transmitDir, file);
    const lockPath = join(transmitDir, `${name}.lock`);
    const options = { ...transmitLockOptions({ ownerAlive, startTimeOf, now }), retries: 5 };
    try {
      await lockWith(lockPath, async () => {
        const entry = await readJson(entryPath);
        if (entry === null) return;                                  // raced with its own removal
        if (ownerAlive(entry.pid, { starttime: entry.starttime })) return;
        await fileLedger(entryPath).remove();
        removed.push(name);
      }, options);
    } catch (error) {
      if (!/could not acquire lock/.test(error.message)) throw error;
      skipped.push(name);
    }
  }
  return { removed, skipped };
}
```

- [ ] **Step 4: Run**

Run: `node --test test/ledger-prune.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/term/ledger-prune.js test/ledger-prune.test.js
git commit -m "feat(term): prune dead sessions' ledgers under their own locks"
```

---

### Task 11: Hook wiring in `bin/familiar.js`

Spec: §3.4 hook path, §3.5 lock construction and pruning placement, mechanical correction (async propagation).

**Files:**
- Modify: `bin/familiar.js` — imports (lines 22–34), `emitHookTransition` (613–638), the `hook` command body (696–735), the `reap` command body (957+)
- Test: `test/bin-familiar.test.js` (hook tests; grep for `'hook'` to find them)

**Interfaces:**
- Consumes: everything above.
- Produces: `async emitHookTransition({ prev, next, intent, seq, transmitSprite, paths, processOps, platform, hookEnv, probe, lockWith })` → the `emit` result. `familiar hook` awaits it, then prunes. `familiar reap` prunes after its bus work.

- [ ] **Step 1: Write the failing tests**

A spawned `familiar hook` cannot reach emission from a test: `resolveAgentPid` walks `/proc` for a `claude` ancestor that owns a tty, a test process has none, and the hook exits 0 with a diagnostic before the transaction. Under a real Claude session it WOULD find one — the developer's own terminal — which `test/bin-familiar.test.js` already warns about. So the hook's half of the section is tested in-process through `emitHookTransition`'s injected collaborators, with `ownerAlive` reporting the owner dead so the section's own gate keeps every byte off every terminal. No test spawns `familiar hook` expecting emission; the existing missing-scheme test (`test/bin-familiar.test.js:176`) already proves the exit-zero error path deterministically.

First migrate the existing Darwin test at `test/bin-familiar.test.js:190-205` ("a completed hook transition with no Darwin tty is one exit-zero diagnostic"): make it `async`, replace `assert.throws(() => emitHookTransition({...}))` with `await assert.rejects(emitHookTransition({...}), (error) => {...})`, delete `priorIntent: null`, and add `seq: 1, paths: paths(env()), probe: () => null` to the call (import `paths` from `../src/bus/paths.js`). The `recordOf` fake stays; add `ownerAlive: () => true, startTimeOf: () => 1` to the `processOps` fake.

Then add beside it:

```js
import { ledgerPaths } from '../src/render/term/ledger.js';

// The hook's half of the emission section, in-process. `ownerAlive` reports the owner
// dead, so the section's ownership gate (spec §3.5 step 2) writes the ledger and opens
// NOTHING — the guarantee that no terminal is touched rests on the protocol, not on a
// tty path happening to be absent on this machine.
test('emitHookTransition writes a stamped ledger entry under transmit/ and a tombstone on SessionEnd', async () => {
  const e = env();
  const p = paths(e);
  const sessionId = 'ledger/../session';
  const agent = { sessionId, state: 'working', pid: process.pid, starttime: 1, project: 'api' };
  const processOps = {
    recordOf: () => ({ pid: process.pid, tty: 'ttys999' }),
    ownerAlive: () => false,
    startTimeOf: () => 1,
  };
  const intent = { [sessionId]: { current: {
    sessionId, pid: process.pid, identity: { project: 'api' }, state: 'working', motionPolicy: 'full',
    animation: { kind: 'static' }, color: { backdrop: '#000000', base: '#ffffff' }, sprite: { terminal: '/nonexistent.png', rows: 4 },
  } } };
  const first = await emitHookTransition({
    prev: null, next: agent, intent, seq: 1, transmitSprite: true,
    paths: p, processOps, platform: 'darwin', hookEnv: { TERM: 'xterm-256color' }, probe: () => null,
  });
  assert.equal(first.kind, 'suppressed');
  assert.equal(first.reason, 'owner-dead');
  const { entryPath } = ledgerPaths(p.transmitDir, sessionId);
  assert.equal(dirname(entryPath), p.transmitDir, 'the session id is a name, not a path');
  assert.ok(!existsSync(join(p.stateDir, 'session.json')) && !existsSync(join(p.stateDir, 'agents.json')), 'no traversal out of transmit/');
  const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
  assert.deepEqual(entry, { seq: 1, pid: process.pid, starttime: 1, held: null, ended: false });

  const end = await emitHookTransition({
    prev: agent, next: null, intent, seq: 2, transmitSprite: true,
    paths: p, processOps, platform: 'darwin', hookEnv: { TERM: 'xterm-256color' }, probe: () => null,
  });
  assert.equal(end.kind, 'suppressed');
  assert.equal(end.reason, 'owner-dead');
  const tomb = JSON.parse(readFileSync(entryPath, 'utf8'));
  assert.deepEqual([tomb.seq, tomb.ended, tomb.held], [2, true, null], 'the tombstone is ordering evidence and is written for a dead owner too');
});
```

Add `existsSync, readFileSync` to the file's `node:fs` import and `dirname` to its `node:path` import if missing. The test asserts `existsSync(join(p.stateDir, 'agents.json'))` is false: nothing in this in-process path writes the bus, so a file there could only be a traversal.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/bin-familiar.test.js`
Expected: the in-process test FAILS (`emitHookTransition` is synchronous and passes `priorIntent`; `emit` rejects for a missing `seq`); the migrated Darwin test fails until the signature changes.

- [ ] **Step 3: Rewire**

In `bin/familiar.js`:

Imports — add:

```js
import { withLock } from '../src/bus/lock.js';
import { tmuxFacts, wrapForTmux, describeTmux } from '../src/render/term/tmux.js';
import { fileLedger, ledgerPaths, transmitLockOptions } from '../src/render/term/ledger.js';
import { pruneLedgers } from '../src/render/term/ledger-prune.js';
```

Replace `emitHookTransition` (lines 613–638) with:

```js
// The hook's half of the emission critical section (spec §3.5): resolve WHERE to write
// and WHAT tmux says about it — the probe spawns, so it runs here, before any lock —
// then hand emit() its evidence (the session's ledger), its serialization (the
// session's lock, never reclaimed by age, holder checked fresh), and its liveness check.
// Async now, and awaited by main(): a failure inside the section must reach run()'s
// error handler, not become an unhandled rejection after the hook has already exited.
export async function emitHookTransition({
  prev, next, intent, seq, transmitSprite,
  paths,
  processOps = defaultProcessOps,
  platform = process.platform,
  hookEnv = process.env,
  probe = tmuxFacts,
  lockWith = withLock,
}) {
  const record = next ?? prev;
  if (record === null) return { kind: 'noop' };
  const terminal = terminalTarget(record.pid, {
    platform,
    record: processOps.recordOf(record.pid),
    hookEnv,
    probe,
  });
  const { entryPath, lockPath } = ledgerPaths(paths.transmitDir, record.sessionId);
  const ownerAlive = (pid, { starttime }) => processOps.ownerAlive(pid, { starttime });
  const lock = (fn) => lockWith(lockPath, fn, transmitLockOptions({ ownerAlive, startTimeOf: processOps.startTimeOf }));
  return emit({
    prev,
    next,
    seq,
    transmitSprite,
    terminal,
    ledger: fileLedger(entryPath),
    lock,
    ownerAlive,
    // `intent` is keyed to IntentRecord — { current, expiresAt, after }. The emitter
    // wants the Intent, so pass `.current`. On SessionEnd there is no record for the
    // session any more; the reset needs only the identity fields.
    intent: next !== null
      ? intent[next.sessionId].current
      : { identity: { project: prev.project }, pid: prev.pid, sessionId: prev.sessionId },
  });
}
```

In the `hook` command body: change the destructuring at line 696 to `const { prev, next, seq, intent, evicted } = await applyHookEvent({ ... })`, and replace the `emitHookTransition({...})` call (lines 721–728) with:

```js
    await emitHookTransition({
      prev, next, intent, seq,
      transmitSprite: adapter.printsPlaceholderCells,
      paths: ctx.paths,
      processOps: defaultProcessOps,
    });

    // Ledger pruning runs HERE — after the transaction returned its lock, never inside
    // it — because on Darwin the fresh liveness check spawns. Candidates only: sessions
    // absent from the bus. Usually none.
    await pruneLedgers({
      transmitDir: ctx.paths.transmitDir,
      agents: (await readJson(ctx.paths.agentsPath)) ?? {},
      ownerAlive: (pid, { starttime }) => defaultProcessOps.ownerAlive(pid, { starttime }),
      startTimeOf: defaultProcessOps.startTimeOf,
    });
```

In the `reap` command body (line 957 onward), after the existing `await reap({ deps })` call, add the same `pruneLedgers` call reading `agentsPath` and using `ctx.paths.transmitDir`, and print `pruned <n> transmission ledger(s)` to stdout when `removed.length > 0`, matching the verb's "no output means nothing was reaped" contract.

- [ ] **Step 4: Run the full fast suite**

Run: `npm test`
Expected: PASS, including the new ledger test and the previously failing hook tests.

- [ ] **Step 5: Commit**

```bash
git add bin/familiar.js test/bin-familiar.test.js
git commit -m "feat(hook): run the emission section with its ledger, lock, and liveness"
```

---

### Task 12: The CLI verbs probe and wrap

Spec: §3.4 (CLI verbs and CLI transmitter), §5 fake-tmux test.

**Files:**
- Modify: `bin/familiar.js` — `theme preview` (~1027–1046), `theme show` (~1141–1213), `theme sheet` (~1311–1320)
- Test: `test/bin-familiar.test.js`, `test/fixtures/fake-tmux/tmux` (new, executable)

- [ ] **Step 1: Create the fake tmux**

Create `test/fixtures/fake-tmux/tmux` (then `chmod +x`):

```sh
#!/bin/sh
# A tmux that answers display-message with whatever FAKE_TMUX_LINE holds. The CLI probe
# spawns `tmux` by PATH lookup, so putting this directory first on PATH is enough.
printf '%s\n' "${FAKE_TMUX_LINE:?}"
```

- [ ] **Step 2: Write the failing tests**

Append to `test/bin-familiar.test.js` (beside the "preview renders for real" test; reuse its `seed` step so `scheme.json` exists):

```js
const fakeTmuxDir = fileURLToPath(new URL('fixtures/fake-tmux', import.meta.url));
const tmuxEnv = (line, over = {}) => env({
  TERM: 'tmux-256color', TMUX: '/tmp/fake,1,0', TMUX_PANE: '%0',
  PATH: `${fakeTmuxDir}:${process.env.PATH}`, FAKE_TMUX_LINE: line, ...over,
});
const KITTY_LINE = 'all\txterm-kitty\tkitty(0.48.2)\t/dev/pts/16\t9001\t1758200000';
const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;

test('preview inside a passthrough-all tmux pane emits only WRAPPED graphics, never bare APC', () => {
  const e = tmuxEnv(KITTY_LINE);
  assert.equal(spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e }).status, 0);
  const result = runTty(['theme', 'preview', 'pip', '--state', 'idle'], { encoding: 'latin1', env: e });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(bareApcs(result.stdout), 0, 'no bare APC');
  assert.ok(result.stdout.includes('\x1bPtmux;\x1b\x1b_Ga=T'), 'the transmission is framed');
  assert.match(result.stdout, /\x1b\\\n/, 'layout newlines follow the closed DCS');
});

test('theme show inside tmux with allow-passthrough=on prints the setting and no art', () => {
  const e = tmuxEnv(KITTY_LINE.replace(/^all/, 'on'));
  assert.equal(spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e }).status, 0);
  const result = runTty(['theme', 'show'], { encoding: 'latin1', env: e });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /no graphics capability \(none\) — tmux allow-passthrough=on, needs all/);
  assert.doesNotMatch(result.stdout, /_G/);
});
```

(`runTty` runs the CLI under the `tty-familiar.mjs` fixture so `stdout.isTTY` is true; it already exists at line 32. The fixture theme `test/fixtures/theme-pack` is installed by the file's `env()` under the id `cats` with the single member `pip`.)

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/bin-familiar.test.js`
Expected: the two new tests FAIL — the first with a thrown `TypeError` from `graphicsCapability` (no probe), so `status !== 0`.

- [ ] **Step 4: Implement**

At each of the three sites replace `const capability = graphicsCapability(process.env);` with:

```js
    const tmux = tmuxFacts(process.env);
    const capability = graphicsCapability(process.env, tmux);
    const frame = tmux?.ok ? wrapForTmux : (command) => command;
```

and pass `frame` to every `transmit(...)` call at that site: line 1046 `transmit(readFileSync(assets[state].terminal), { rows: assets[state].rows, frame })`, line 1213 `transmit(readFileSync(assets.idle.terminal), { rows: viewRows, frame })`, line 1320 `transmit(encodeRgba(composeStrip(row.frames, { gap: 8 })), { rows: viewRows, frame })`.

In `theme show`, change the stderr line to:

```js
      process.stderr.write(
        `familiar: no graphics capability (${capability})${describeTmux(tmux)} — showing labels only, no art\n`
      );
```

Update the existing comment above it ("or any tmux session — graphicsCapability returns NONE for both") to "or a tmux pane the probe refuses — and for tmux it says which setting".

- [ ] **Step 5: Run**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/familiar.js test/bin-familiar.test.js test/fixtures/fake-tmux/tmux
git commit -m "feat(cli): probe tmux and frame preview, show, and sheet graphics"
```

---

### Task 13: The real-tmux pty test and the slow partition's entry points

Spec: §3.6, §5 pty test.

**Files:**
- Create: `test/tmux-pty.slow.test.js`
- Modify: `package.json` (scripts), `justfile` (lines 14–33), `.github/workflows/test.yml` (the `test` job)

- [ ] **Step 1: Write the slow test**

Create `test/tmux-pty.slow.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, writeSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapForTmux } from '../src/render/term/tmux.js';

// THE TRANSPORT TEST. A real tmux server on a temporary socket, a real client attached
// through a pty (util-linux `script` provides one), a pane copying a fifo to its stdout.
// What the CLIENT's pty receives is what the outer terminal would see. This is the test
// that would have caught the "relaxing the refusal is a one-line change" comment.

const has = (binary) => spawnSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' }).status === 0;
const missing = ['tmux', 'script', 'mkfifo'].filter((b) => !has(b));
// Under CI the machine exists to run this; a skip there is the silent fallback this spec deletes.
if (missing.length > 0 && process.env.CI === 'true') {
  throw new Error(`tmux pty test cannot run in CI: missing ${missing.join(', ')}`);
}
const skip = missing.length > 0 ? `missing ${missing.join(', ')}` : false;

const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const APC = '\x1b_Ga=T,f=100,q=2,r=2,C=1,m=0;AAAA\x1b\\';
const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer({ passthrough, paneCommand, paneEnv = {} }, body) {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-pty-'));
  const sock = join(dir, 'sock');
  const conf = join(dir, 'tmux.conf');
  const log = join(dir, 'client.log');
  writeFileSync(conf, `set -g allow-passthrough ${passthrough}\nset -g status off\n`);
  const envArgs = Object.entries(paneEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const started = spawnSync('tmux', ['-S', sock, '-f', conf, 'new-session', '-d', '-x', '80', '-y', '24', ...envArgs, paneCommand], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  // The client's TERM is what tmux reports as client_termname: make it a Kitty.
  const client = process.platform === 'darwin'
    ? spawn('script', ['-q', log, 'tmux', '-S', sock, 'attach'], { env: { ...process.env, TERM: 'xterm-kitty' }, stdio: 'ignore' })
    : spawn('script', ['-qfc', `tmux -S ${sock} attach`, log], { env: { ...process.env, TERM: 'xterm-kitty' }, stdio: 'ignore' });
  try {
    let attached = false;
    for (let i = 0; i < 50 && !attached; i += 1) {
      const tty = spawnSync('tmux', ['-S', sock, 'display-message', '-p', '#{client_tty}'], { encoding: 'utf8' }).stdout.trim();
      attached = tty !== '';
      if (!attached) await sleep(100);
    }
    assert.ok(attached, 'a client attached through the pty within 5 s');
    return await body({ sock, dir, readClient: () => readFileSync(log, 'latin1') });
  } finally {
    spawnSync('tmux', ['-S', sock, 'kill-server']);
    client.kill();
  }
}

for (const [passthrough, bareForwarded, wrappedForwarded] of [['all', false, true], ['off', false, false]]) {
  test(`allow-passthrough ${passthrough}: bare APC ${bareForwarded ? 'reaches' : 'is dropped by'} the client, wrapped APC ${wrappedForwarded ? 'reaches it unframed' : 'is dropped'}`, { skip }, async () => {
    const fifoDir = mkdtempSync(join(tmpdir(), 'fifo-'));
    const fifo = join(fifoDir, 'in');
    spawnSync('mkfifo', [fifo]);
    await withServer({ passthrough, paneCommand: `cat ${fifo}` }, async ({ readClient }) => {
      const fd = openSync(fifo, 'w');
      writeSync(fd, 'BARE>');
      writeSync(fd, APC);
      writeSync(fd, '<WRAPPED>');
      writeSync(fd, wrapForTmux(APC));
      writeSync(fd, '<END\n');
      closeSync(fd);
      await sleep(500);
      const seen = readClient();
      assert.ok(seen.includes('END'), 'the pane text was redrawn to the client');
      // The client sees UNFRAMED output (tmux strips the DCS and un-doubles the ESC), so a
      // forwarded command is a bare APC here; the same helper counts both cases.
      assert.equal(bareApcs(seen), (bareForwarded ? 1 : 0) + (wrappedForwarded ? 1 : 0), `${passthrough}: forwarded APC count`);
      assert.equal(seen.includes('\x1bPtmux;'), false, 'the client never sees the DCS framing itself');
    });
  });
}

test('familiar theme preview inside a passthrough-all pane paints the client', { skip }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const config = mkdtempSync(join(tmpdir(), 'config-'));
  // FAMILIAR_THEMES_DIR is a ROOT of installed themes; the loader expects `<root>/cats/`
  // (the config default), so the fixture pack is copied under that id, as
  // test/bin-familiar.test.js does. Its one member is `pip`.
  const themes = mkdtempSync(join(tmpdir(), 'themes-'));
  cpSync(fileURLToPath(new URL('fixtures/theme-pack', import.meta.url)), join(themes, 'cats'), { recursive: true });
  const go = join(state, 'go');
  const paneEnv = { FAMILIAR_STATE_DIR: state, FAMILIAR_CONFIG_DIR: config, FAMILIAR_THEMES_DIR: themes };
  assert.equal(spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { env: { ...process.env, ...paneEnv } }).status, 0);
  // The pane waits for a signal file: preview must run only AFTER the client is attached,
  // or tmux has no client to forward to and the test races the attachment.
  const paneCommand = `sh -c 'while [ ! -e ${go} ]; do sleep 0.1; done; ${process.execPath} ${bin} theme preview pip --state idle; sleep 2'`;
  await withServer({ passthrough: 'all', paneEnv, paneCommand }, async ({ readClient }) => {
    writeFileSync(go, '');
    await sleep(2000);
    const seen = readClient();
    assert.ok(bareApcs(seen) > 0, `the sprite reached the client unframed:\n${JSON.stringify(seen.slice(0, 200))}`);
    assert.equal(seen.includes('\x1bPtmux;'), false);
  });
});
```

- [ ] **Step 2: Wire the entry points**

`package.json` scripts:

```json
  "scripts": {
    "test": "node tools/test-runner.mjs fast",
    "test:slow": "node tools/test-runner.mjs slow"
  },
```

`justfile`: replace the comment block at lines 14–20 and `test_cmd` with:

```make
# fast_cmd is the fast partition: everything that is not `*.slow.test.js`. The slow
# partition holds the real-tmux pty test (test/tmux-pty.slow.test.js), which needs
# tmux and util-linux `script` and takes seconds; test_cmd runs both modes in turn.
fast_cmd := "npm test"
test_cmd := "npm test && npm run test:slow"
```

`.github/workflows/test.yml`, in the `test` job after `npm ci`:

```yaml
      - run: sudo apt-get update && sudo apt-get install -y tmux
      - run: python3 tools/tt ci-test -- npm test
      - run: python3 tools/tt ci-test -- npm run test:slow
```

- [ ] **Step 3: Run**

Run: `npm run test:slow` (tmux 3.7c and `script` are present on this host).
Expected: PASS. Then `just test` to confirm both modes run.

- [ ] **Step 4: Commit**

```bash
git add test/tmux-pty.slow.test.js package.json justfile .github/workflows/test.yml
git commit -m "test(tmux): prove passthrough against a real tmux pty and run the slow partition"
```

---

### Task 14: Documentation

Spec: §3.7, §7.

**Files:**
- Modify: `docs/surfaces.md:37-38`, `docs/ref/kitty-graphics-protocol.md:122-123`, `docs/install.md:33-34` and `:186-190`, `docs/specs/2026-09-18-tmux-rendering-design.md` (status header)

- [ ] **Step 1: `docs/surfaces.md`**

Replace lines 37–38 with:

```markdown
Kitty and Ghostty support the same graphics protocol. Inside tmux, familiar asks the
server before drawing: the pane must have `allow-passthrough all` (not `on`, which drops
escapes while the pane is hidden and would leave a stale cat in a background window), and
the attached client must be Kitty or Ghostty. Every graphics command is then wrapped in
DCS passthrough. Known limits: tmux 3.7c redraws placeholders correctly only in
full-width panes (an upstream combining-character bug), Claude Code's status line arrives
at 256 colours under tmux (`FORCE_COLOR=3` is an untested workaround), and attaching a
client shows the cat at the next state change, not on attach.
```

- [ ] **Step 2: `docs/ref/kitty-graphics-protocol.md`**

Replace lines 122–123 with:

```markdown
- tmux: familiar probes the server from the hook (`tmux -S <socket> display-message -p -t
  <pane> '#{allow-passthrough} #{client_termname} #{client_termtype} #{client_tty}
  #{client_pid} #{client_created}'`) and renders only under `allow-passthrough all` with a
  Kitty or Ghostty client. Each APC command is wrapped separately in `ESC P tmux; … ESC \`
  with inner `ESC`s doubled — never the whole program in one DCS, which would exceed
  tmux's 1 MiB input buffer. Wrapped size is `encodedBytes + 11 × commands`.
```

- [ ] **Step 3: `docs/install.md`**

Line 33–34: change "tmux, Intel Macs, macOS 13, and other terminals stay unclaimed." to "tmux is supported inside Kitty and Ghostty with the limits in `docs/surfaces.md` (full-width panes on tmux ≤ 3.7c; status-line colour depth). Intel Macs, macOS 13, and other terminals stay unclaimed."

Lines 186–190: remove "inside tmux," from the unclaimed list and add after the paragraph:

```markdown
Inside tmux: `tmux set -g allow-passthrough all`, use a full-width pane, check the status
line renders 24-bit colour (`FORCE_COLOR=3` in the tmux environment if not), and expect
the cat at the first state change after attaching a client.
```

- [ ] **Step 4: Spec status**

Change the spec's status line to `**Status:** implemented 2026-09-18 (plan: docs/plans/2026-09-18-tmux-rendering.md).` only once every task above is merged; until then leave it as reviewed.

- [ ] **Step 5: Verify and commit**

Run: `just check && just test`
Expected: both green; `tasks check` reports no warnings other than registration-only ones.

```bash
git add docs/surfaces.md docs/ref/kitty-graphics-protocol.md docs/install.md docs/specs/2026-09-18-tmux-rendering-design.md
git commit -m "docs: state the real tmux requirement and its known limits"
```

---

## Self-review

**Spec coverage.** §3.1 → Task 1. §3.2 → Task 2. §3.3 → Task 3. §3.4 hook path → Tasks 4, 11; CLI → Task 12; `renderTransition` → Task 8. §3.5 sequence → Task 7; critical section, lock options, liveness → Tasks 5, 6, 8; `stamp`/`inherit`/`ledgerName` → Task 6; pruning → Tasks 10, 11. §3.6 → Task 13. §3.7 → Task 14. §4 error handling is exercised by Tasks 8–9's failure tests. §5 tests map: probe/wrap → 1; classifier → 2; encoder/transmitter → 3; emit wrapping, lifecycle, section ordering, interleavings, failures, static, transport, owner change, initialization, real lock → 8–9; fresh liveness and long write → 5; Darwin pid reuse → 5; `ledgerName` traversal → 6; transaction seq across removal → 7; prune → 10, 11; fake tmux CLI → 12; pty → 13.

**Type consistency.** `tmux` result shape (`{ ok, passthrough, termname, termtype, client: { tty, pid, created } }`) is used identically in Tasks 1, 2, 4, 8, 12. `stamp(fields, { seq, owner })` and `inherit(entry, owner)` match between Tasks 6 and 8. `emit`'s return `{ kind, reason?, lifecycle?, bytes? }` is what Tasks 8, 9, 11 read. `transmitLockOptions` is used with the same arguments in Tasks 6, 10, 11. `ownerAlive(pid, { starttime })` has the same signature in Tasks 5, 6, 8, 10, 11.

**Known judgement calls left to the executor.** The exact helper names in `test/proc.test.js` and `test/lock.test.js` (Task 5) — the plan names what to assert, the file names how it builds fixtures.

**Plan review 2 (2026-09-18).** The spawned-hook test in Task 11 is removed (nothing enforced its no-ancestor assumption; under a real session it could reach the developer's terminal); the in-process test uses a dead owner so the protocol itself, not an absent tty path, guarantees zero terminal access, and expects `suppressed/owner-dead` for both events; the async-migration list in Task 8 classifies the near-280 test correctly as a synchronous `renderTransition` assertion.

**Plan review 1 (2026-09-18).** Task 11's spawned-hook ledger test replaced by an in-process `emitHookTransition` test (a spawned hook has no `claude` ancestor and, under a real session, would target the developer's terminal); every "no bare APC" assertion now uses `bareApcs()` (an `ESC _ G` also occurs inside `ESC ESC _ G`); Task 8 and 11 migration steps enumerate the `captureEmission` callers, `assert.throws → assert.rejects`, and the Darwin `emitHookTransition` test; Task 2 drops the classifier table row that now throws; Task 5 injects `kill`, the constructor's real existence probe; Task 13 installs the fixture under `<root>/cats/`, uses member `pip`, and releases `theme preview` only after the client is attached.
