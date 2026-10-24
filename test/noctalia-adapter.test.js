// Noctalia's native IPC as familiar uses it: the live Do Not Disturb status and the
// generic toast. Both are argument vectors through an injected execFile; nothing here
// starts the real noctalia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDnd, sendToast } from '../integrations/noctalia/adapter.js';

const fakeExec = (outcome) => {
  const calls = [];
  const execFile = async (file, args, options) => {
    calls.push({ file, args, options });
    if (outcome instanceof Error) throw outcome;
    return { stdout: outcome, stderr: '' };
  };
  return { calls, execFile };
};

test('the DND query is an argument vector with a bounded timeout', async () => {
  const { calls, execFile } = fakeExec('on\n');
  assert.equal(await readDnd({ execFile }), 'on');
  assert.deepEqual(calls, [{ file: 'noctalia', args: ['msg', 'notification-dnd-status'], options: { timeout: 2000, maxBuffer: 4096 } }]);
  assert.equal(await readDnd({ execFile: fakeExec('off').execFile }), 'off');
});

test('every other DND answer is unknown, never silently off', async () => {
  const failures = [
    '', 'ON', 'Off', 'on\nextra', 'maybe', '{"dnd":false}', ' off',
    Object.assign(new Error('exit 1'), { code: 1, stderr: 'no such command' }),
    Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('spawn noctalia ENOENT'), { code: 'ENOENT' }),
  ];
  for (const outcome of failures) {
    await assert.rejects(readDnd({ execFile: fakeExec(outcome).execFile }), /noctalia: do not disturb status unavailable/, JSON.stringify(String(outcome)));
  }
});

test('a toast is one generic notification-show argument vector', async () => {
  const { calls, execFile } = fakeExec('');
  const payload = { app_name: 'familiar', summary: 'Agent needs approval', body: 'repo · workspace 2', urgency: 'normal' };
  await sendToast({ payload, execFile });
  const notifyArgv = calls[0].args;
  assert.equal(calls[0].file, 'noctalia');
  assert.deepEqual(notifyArgv.slice(0, 2), ['msg', 'notification-show']);
  assert.equal(JSON.parse(notifyArgv[2]).app_name, 'familiar');
  assert.deepEqual(JSON.parse(notifyArgv[2]), payload);
  assert.equal(notifyArgv.length, 3);
  assert.equal(calls[0].options.timeout, 2000);
});

test('a toast refuses critical urgency, foreign app names and unknown fields', async () => {
  const base = { app_name: 'familiar', summary: 's', body: 'b', urgency: 'low' };
  for (const payload of [{ ...base, urgency: 'critical' }, { ...base, app_name: 'other' }, { ...base, actions: ['approve'] }, { ...base, summary: '' }]) {
    await assert.rejects(sendToast({ payload, execFile: fakeExec('').execFile }), /toast/);
  }
});

test('a failed or timed-out send rejects', async () => {
  const payload = { app_name: 'familiar', summary: 's', body: 'b', urgency: 'low' };
  await assert.rejects(sendToast({ payload, execFile: fakeExec(Object.assign(new Error('timed out'), { killed: true })).execFile }), /noctalia: notification-show failed/);
});
