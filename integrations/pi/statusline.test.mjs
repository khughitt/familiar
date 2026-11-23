import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelLabel, runStatusline, singleFlight, statuslinePayload } from './statusline.js';
import { readFields } from '../../src/render/term/statusfields.js';

const reasoning = { id: 'glm-5.3', reasoning: true };

test('the model slot reads as pi footer names the model', () => {
  assert.equal(modelLabel(reasoning, 'high'), 'glm-5.3 • high');
  assert.equal(modelLabel(reasoning, 'off'), 'glm-5.3 • thinking off');
  assert.equal(modelLabel({ id: 'plain', reasoning: false }, 'high'), 'plain');
  assert.equal(modelLabel(undefined, 'high'), null);
});

test('readFields reads the payload pi builds', () => {
  const payload = statuslinePayload({
    sessionId: 'abc',
    cwd: '/work/tasks',
    model: reasoning,
    thinkingLevel: 'high',
    contextUsage: { tokens: 105_000, contextWindow: 1_000_000, percent: 10.5 },
  });
  assert.equal(payload.session_id, 'pi:abc');
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

  const slow = fakeFamiliar(t, 'exec sleep 5');
  assert.deepEqual(await runStatusline({ command: slow.bin, payload: {}, env: slow.env, timeoutMs: 100 }),
    { fault: 'timed out after 100ms' });

  const missing = join(tmpdir(), 'familiar-pi-no-such-binary');
  assert.deepEqual(await runStatusline({ command: missing, payload: {}, env: failing.env }),
    { fault: `${missing}: not found on PATH` });
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
