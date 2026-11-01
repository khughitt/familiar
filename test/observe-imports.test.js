// A SessionEnd observer runs under relay's tightest teardown budget (codex: 267 ms at the
// default outer timeout), and most of a cold `familiar observe` was module loading. A
// teardown drops presentation state and resets the terminal: it never resolves a theme,
// reads config or draws, so it must not load the theme contract, the YAML parser, or the
// CLI's other commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const hook = fileURLToPath(new URL('fixtures/trace-imports.mjs', import.meta.url));

function tracedObserve(t, envelope) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, 'trace.txt');
  writeFileSync(trace, '');
  const result = spawnSync(process.execPath, ['--import', hook, bin, 'observe'], {
    input: JSON.stringify(envelope),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FAMILIAR_CONFIG_DIR: join(dir, 'config'),
      FAMILIAR_STATE_DIR: join(dir, 'state'),
      RELAY_STATE_DIR: join(dir, 'state', 'relay'),
      FAMILIAR_TRACE_IMPORTS: trace,
    },
  });
  return { result, loaded: readFileSync(trace, 'utf8').split('\n').filter(Boolean) };
}

const event = (kind) => ({
  schema: 1, type: 'event', subscriber: 'familiar',
  event: {
    schema: 1, kind, harness: 'codex',
    nativeEvent: { 'session-end': 'SessionEnd', prompt: 'UserPromptSubmit' }[kind],
    sessionId: 'imports-session', agentId: 'codex:imports-session', cwd: '/repo', tool: null,
  },
  registry: { generation: null, revision: null }, changed: true, reaped: [],
});

test('a SessionEnd observe loads neither the theme contract, YAML, nor the other commands', (t) => {
  const { result, loaded } = tracedObserve(t, event('session-end'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(loaded.some((url) => url.endsWith('/src/observe/run.js')), 'the trace saw the observe module');
  const forbidden = loaded.filter((url) => /\/node_modules\/(familiar-theme|yaml)\//.test(url)
    || url.endsWith('/bin/familiar-commands.js'));
  assert.deepEqual(forbidden, []);
});
