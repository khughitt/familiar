import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupProjectColor, NO_PROJECT } from '../src/bus/project-color.js';

const row = (fields, warnings = []) =>
  JSON.stringify({ results: [{ input: '/r', kind: 'path', ...fields }], warnings });

function fakeExec(calls, answer) {
  return async (...args) => {
    calls.push(args);
    if (Object.keys(answer).length === 1 && Object.hasOwn(answer, 'stdout')) return answer;
    throw Object.assign(new Error('exec failed'), answer);
  };
}

const lookup = (stdout) => lookupProjectColor('/r', { exec: fakeExec([], { stdout }) });

test('spawns tasks resolve --json with the checkout as one argument', async () => {
  const calls = [];
  await lookupProjectColor('/home/k/my repo', {
    exec: fakeExec(calls, { stdout: row({ status: 'unregistered' }) }),
  });
  assert.deepEqual(calls, [['tasks', ['resolve', '--json', '/home/k/my repo'],
    { timeout: 2000, killSignal: 'SIGKILL' }]]);
});

test('outside a repository nothing is spawned', async () => {
  const calls = [];
  assert.deepEqual(await lookupProjectColor(null, { exec: fakeExec(calls, {}) }), NO_PROJECT);
  assert.deepEqual(calls, []);
});

test('a resolved colour comes back and its warnings are dropped', async () => {
  assert.deepEqual(await lookup(row({ status: 'resolved', prefix: 'fam', color: '#bc8369' }, ['other: x'])),
    { prefix: 'fam', color: '#bc8369', warnings: [] });
});

test('a resolved project without a colour forwards the warnings', async () => {
  assert.deepEqual(await lookup(row({ status: 'resolved', prefix: 'mind3' }, ['w'])),
    { prefix: 'mind3', color: null, warnings: ['w'] });
});

test('a linked checkout whose project config fails forwards its warning', async () => {
  const warning = 'nexc: its checkout is not matched and its color is not reported (invalid color)';
  assert.deepEqual(await lookup(row({ status: 'unregistered' }, [warning])),
    { prefix: null, color: null, warnings: [warning] });
});

test('tasks absent is no project', async () => {
  assert.deepEqual(await lookupProjectColor('/r', { exec: fakeExec([], { code: 'ENOENT' }) }), NO_PROJECT);
  assert.ok(Object.isFrozen(NO_PROJECT));
  assert.ok(Object.isFrozen(NO_PROJECT.warnings));
});

test('every other answer is an error naming the directory', async () => {
  const cases = [
    [{ code: 1, stdout: '{"error":{"kind":"io"}}', stderr: '' }, /exited 1: \{"error"/],
    [{ code: 2, stdout: '', stderr: "  error: unrecognized subcommand 'resolve'\n" },
      /exited 2: error: unrecognized subcommand 'resolve'$/],
    [{ code: 'EACCES', stdout: '', stderr: '' }, /EACCES/],
    [{ stdout: 'not json' }, /not JSON/],
    [{ stdout: '{"results":[],"warnings":[]}' }, /expected one result, got 0/],
    [{ stdout: row({ status: 'ambiguous' }) }, /status "ambiguous"/],
    [{ stdout: row({ status: 'invalid' }) }, /status "invalid"/],
    [{ stdout: row({ status: 'resolved', prefix: 'fam', color: '#BC8369' }) }, /not a #rrggbb colour/],
    [{ stdout: '{"results":[{"status":"unregistered"}],"warnings":"x"}' }, /warnings/],
  ];
  for (const [answer, message] of cases) {
    await assert.rejects(lookupProjectColor('/r', { exec: fakeExec([], answer) }), (error) => {
      assert.match(error.message, /^tasks resolve \/r: /);
      assert.match(error.message, message);
      return true;
    });
  }
});

test('malformed JSON shapes are rejected at the boundary', async () => {
  const cases = [
    'null', '[]', '{}',
    '{"results":{},"warnings":[]}',
    '{"results":[null],"warnings":[]}',
    '{"results":[[]],"warnings":[]}',
    '{"results":[{}],"warnings":[]}',
    row({ status: 'unregistered' }, [1]),
    row({ status: 'resolved' }),
    row({ status: 'resolved', prefix: '' }),
    row({ status: 'resolved', prefix: 1 }),
    row({ status: 'resolved', prefix: 'fam', color: null }),
    row({ status: 'resolved', prefix: 'fam', color: 123 }),
  ];
  for (const stdout of cases) await assert.rejects(lookup(stdout), /^Error: tasks resolve \/r: /);
});

test('a timeout is its own error and honors the requested deadline', async () => {
  for (const answer of [{ killed: true }, { signal: 'SIGKILL' }]) {
    const calls = [];
    await assert.rejects(lookupProjectColor('/r', { exec: fakeExec(calls, answer), timeoutMs: 17 }),
      { code: 'FAMILIAR_TASKS_TIMEOUT', message: 'tasks resolve /r: timed out after 17ms' });
    assert.equal(calls[0][2].timeout, 17);
  }
  await assert.rejects(lookupProjectColor('/r', { exec: fakeExec([], { killed: true, signal: 'SIGKILL' }) }),
    { code: 'FAMILIAR_TASKS_TIMEOUT', message: 'tasks resolve /r: timed out after 2000ms' });
});

test('the suite runs against the fake tasks, never the host one', () => {
  const out = JSON.parse(execFileSync('tasks', ['resolve', '--json', '/x'], { encoding: 'utf8' }));
  assert.equal(out.fake, true);
  assert.deepEqual(out.results, [{ input: '/x', kind: 'path', status: 'unregistered' }]);
});

test('the fake tasks supports controlled stdout, stderr, status and call logging', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fake-tasks-'));
  try {
    const log = join(scratch, 'calls');
    assert.throws(() => execFileSync('tasks', ['resolve', '--json', '/my repo'], {
      encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, FAKE_TASKS_LOG: log, FAKE_TASKS_OUTPUT: 'answer',
        FAKE_TASKS_STDERR: 'problem', FAKE_TASKS_EXIT: '2' },
    }), (error) => {
      assert.equal(error.status, 2);
      assert.equal(error.stdout.trim(), 'answer');
      assert.equal(error.stderr.trim(), 'problem');
      return true;
    });
    assert.equal(readFileSync(log, 'utf8'), 'resolve --json /my repo\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
