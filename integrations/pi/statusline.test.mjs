import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandFrom, installStatusline, modelLabel, runStatusline, sanitizeStatus, singleFlight, statuslinePayload,
} from './statusline.js';
import { readFields } from '../../src/render/term/statusfields.js';

const reasoning = { id: 'glm-5.3', reasoning: true };

test('the model slot reads as pi footer names the model', () => {
  assert.equal(modelLabel(reasoning, 'high'), 'glm-5.3 • high');
  assert.equal(modelLabel(reasoning, 'off'), 'glm-5.3 • thinking off');
  assert.equal(modelLabel(reasoning, undefined), 'glm-5.3 • thinking off');
  assert.equal(modelLabel(reasoning, ''), 'glm-5.3 • thinking off');
  assert.equal(modelLabel({ id: 'plain', reasoning: false }, 'high'), 'plain');
  assert.equal(modelLabel(undefined, 'high'), null);
});

test('FAMILIAR_BIN names the launcher; unset or empty means PATH', () => {
  assert.equal(commandFrom({ FAMILIAR_BIN: '/x/bin/familiar' }), '/x/bin/familiar');
  assert.equal(commandFrom({ FAMILIAR_BIN: '' }), 'familiar');
  assert.equal(commandFrom({}), 'familiar');
});

test('other extensions status text is one line, as pi footer shows it', () => {
  assert.equal(sanitizeStatus(' a\nb\t  c\r '), 'a b c');
});

test('readFields reads the payload pi builds', () => {
  const payload = statuslinePayload({
    sessionId: 'abc',
    cwd: '/work/tasks',
    model: reasoning,
    thinkingLevel: 'high',
    contextUsage: { tokens: 105_000, contextWindow: 1_000_000, percent: 10.5 },
  });
  // The bus keys a session by its bare id; only a claim names it with its harness.
  assert.equal(payload.session_id, 'abc');
  const claimed = [];
  const fields = readFields(payload, {
    git: (cwd) => (cwd === '/work/tasks' ? 'main' : null),
    claim: (session) => { claimed.push(session); return null; },
  });
  assert.deepEqual(claimed, ['pi:abc']);
  assert.equal(fields.project, 'tasks');
  assert.equal(fields.branch, 'main');
  assert.equal(fields.model, 'glm-5.3 • high');
  assert.equal(fields.usedPercent, 10.5);
});

test('unknown context usage and no model stay absent, never zero', () => {
  for (const contextUsage of [undefined, { tokens: null, contextWindow: 1, percent: null }]) {
    const fields = readFields(
      statuslinePayload({ sessionId: 'abc', cwd: '/w', model: undefined, thinkingLevel: 'off', contextUsage }),
      { git: () => null, claim: () => null },
    );
    assert.equal(fields.usedPercent, null);
    assert.equal(fields.model, null);
  }
});

function fakeFamiliar(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'familiar');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, env: { PATH: process.env.PATH, HOME: dir } };
}

test('a clean run gives the printed lines, with stdin as the payload', async (t) => {
  const { bin, env } = fakeFamiliar(t, 'test "$1" = statusline || exit 9\ncat >/dev/null\nprintf "one\\ntwo\\n"; echo warn >&2');
  assert.deepEqual(await runStatusline({ command: bin, payload: {}, env }), { lines: ['one', 'two'] });

  const echo = fakeFamiliar(t, 'cat');
  assert.deepEqual(await runStatusline({ command: echo.bin, payload: { a: 1 }, env: echo.env }), { lines: ['{"a":1}'] });
});

test('a failed run is a fault naming the cause', async (t) => {
  const failing = fakeFamiliar(t, 'echo first >&2; echo "bad theme" >&2; exit 3');
  assert.deepEqual(await runStatusline({ command: failing.bin, payload: {}, env: failing.env }),
    { fault: 'exited 3: bad theme' });

  // familiar reports its own errors under `statusline` with exit 0 and nothing on stdout.
  const cosmetic = fakeFamiliar(t, 'cat >/dev/null; echo "familiar: no scheme at x" >&2; exit 0');
  assert.deepEqual(await runStatusline({ command: cosmetic.bin, payload: {}, env: cosmetic.env }),
    { fault: 'familiar: no scheme at x' });
  const silent = fakeFamiliar(t, 'cat >/dev/null');
  assert.deepEqual(await runStatusline({ command: silent.bin, payload: {}, env: silent.env }),
    { fault: 'no output' });

  const slow = fakeFamiliar(t, 'exec sleep 5');
  assert.deepEqual(await runStatusline({ command: slow.bin, payload: {}, env: slow.env, timeoutMs: 100 }),
    { fault: 'timed out after 100ms' });

  const missing = join(tmpdir(), 'familiar-pi-no-such-binary');
  assert.deepEqual(await runStatusline({ command: missing, payload: {}, env: failing.env }),
    { fault: `${missing}: not found on PATH` });
});

test('an aborted run ends its child at once', async (t) => {
  const slow = fakeFamiliar(t, 'exec sleep 5');
  const controller = new AbortController();
  const started = Date.now();
  const pending = runStatusline({ command: slow.bin, payload: {}, env: slow.env, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  assert.deepEqual(await pending, { fault: 'aborted' });
  assert.ok(Date.now() - started < 2_000);
});

test('a burst of refreshes runs once more, not once per request', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const refresh = singleFlight(async () => {
    runs += 1;
    if (runs === 1) await gate;
  });
  const first = refresh();
  refresh();
  refresh();
  const last = refresh();
  assert.equal(first, last);
  release();
  await first;
  assert.equal(runs, 2);
  await refresh();
  assert.equal(runs, 3);
});

test('a refresh that throws does not stop later refreshes', async () => {
  let runs = 0;
  const refresh = singleFlight(async () => {
    runs += 1;
    if (runs === 1) throw new Error('stale context');
  });
  await assert.rejects(refresh(), /stale context/);
  await refresh();
  assert.equal(runs, 2);
});

// A fake pi: the extension API, one session context per start, and a footer host that disposes
// the old footer before building the new one, as pi 1.1.0's setExtensionFooter does.
function fakePi({ mode = 'tui', results = [] } = {}) {
  const handlers = new Map();
  const runs = [];
  const schedules = [];
  const host = { footer: undefined, renders: 0, statuses: new Map(), branchListeners: new Set() };
  const pi = {
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    getThinkingLevel: () => 'high',
  };
  const context = () => ({
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    cwd: '/work/tasks',
    model: reasoning,
    sessionManager: { getSessionId: () => 's1' },
    getContextUsage: () => ({ tokens: 1, contextWindow: 10, percent: 10 }),
    ui: {
      setFooter(factory) {
        host.footer?.dispose?.();
        host.footer = factory?.(
          { requestRender: () => { host.renders += 1; } },
          { fg: (color, text) => `<${color}>${text}` },
          {
            getExtensionStatuses: () => host.statuses,
            onBranchChange: (listener) => {
              host.branchListeners.add(listener);
              return () => host.branchListeners.delete(listener);
            },
          },
        );
      },
    },
  });
  const run = async (options) => {
    runs.push(options);
    const next = results.shift() ?? { lines: ['hud'] };
    return typeof next === 'function' ? next(options) : next;
  };
  const schedule = (fn, ms) => {
    const entry = { fn, ms, active: true };
    schedules.push(entry);
    return () => { entry.active = false; };
  };
  const emit = async (event, payload = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, context());
  };
  const truncateToWidth = (text, width, ellipsis = '') => (text.length > width ? text.slice(0, width - ellipsis.length) + ellipsis : text);
  installStatusline(pi, { truncateToWidth, command: 'familiar', env: {}, run, schedule });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { pi, host, runs, schedules, emit, settle };
}

test('RPC and print sessions get no footer and never run familiar', async () => {
  for (const mode of ['rpc', 'print', 'json']) {
    const { host, runs, schedules, emit, settle } = fakePi({ mode });
    await emit('session_start');
    await emit('agent_end');
    await settle();
    assert.equal(host.footer, undefined, mode);
    assert.equal(runs.length, 0, mode);
    assert.equal(schedules.length, 0, mode);
  }
});

test('the footer shows familiar lines, then a fault under the last good lines', async () => {
  const { host, runs, emit, settle } = fakePi({ results: [{ lines: ['row one', 'row two'] }, { fault: 'familiar: no scheme' }] });
  await emit('session_start');
  await settle();
  assert.deepEqual(host.footer.render(80), ['row one', 'row two']);
  assert.equal(runs[0].payload.session_id, 's1');
  assert.equal(runs[0].command, 'familiar');
  await emit('agent_end');
  await settle();
  assert.deepEqual(host.footer.render(80), ['row one', 'row two', '<error>familiar statusline: familiar: no scheme']);
  assert.ok(host.renders >= 2);
});

test('a throwing refresh shows its fault and the next event still refreshes', async () => {
  const { host, runs, emit, settle } = fakePi({ results: [() => { throw new Error('boom'); }, { lines: ['back'] }] });
  await emit('session_start');
  await settle();
  assert.deepEqual(host.footer.render(80), ['<error>familiar statusline: boom']);
  await emit('turn_end');
  await settle();
  assert.equal(runs.length, 2);
  assert.deepEqual(host.footer.render(80), ['back']);
});

test('other extensions status texts follow on one sanitised line', async () => {
  const { host, emit, settle } = fakePi();
  host.statuses.set('b', 'second');
  host.statuses.set('a', 'first\nline');
  await emit('session_start');
  await settle();
  assert.deepEqual(host.footer.render(80), ['hud', 'first line second']);
});

test('session tree moves and branch changes refresh the line', async () => {
  const { host, runs, emit, settle } = fakePi();
  await emit('session_start');
  await settle();
  await emit('session_tree');
  await settle();
  for (const listener of host.branchListeners) listener();
  await settle();
  assert.equal(runs.length, 3);
});

test('a footer replaced by another extension stops the poll and the refreshes', async () => {
  const { host, runs, schedules, emit, settle } = fakePi();
  await emit('session_start');
  await settle();
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].active, true);
  host.footer.dispose();
  assert.equal(schedules[0].active, false);
  await emit('agent_end');
  await settle();
  assert.equal(runs.length, 1);
});

test('a new session keeps its own poll when the old footer is disposed', async () => {
  const { schedules, emit, settle, runs } = fakePi();
  await emit('session_start');
  await settle();
  await emit('session_shutdown');
  await emit('session_start');
  await settle();
  assert.deepEqual(schedules.map((s) => s.active), [false, true]);
  await emit('agent_end');
  await settle();
  assert.equal(runs.length, 3);
});

test('shutdown aborts an in-flight run and discards its result', async () => {
  let release;
  const { host, runs, emit, settle } = fakePi({
    results: [(options) => new Promise((resolve) => {
      release = () => resolve({ lines: ['late'] });
      options.signal.addEventListener('abort', () => resolve({ fault: 'aborted' }));
    })],
  });
  await emit('session_start');
  await settle();
  const footer = host.footer;
  await emit('session_shutdown');
  assert.equal(runs[0].signal.aborted, true);
  release();
  await settle();
  assert.deepEqual(footer.render(80), []);
});
