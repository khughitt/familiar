import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../src/install/setup.js';
import { ledgerPaths } from '../src/render/term/ledger.js';
import { oscReset } from '../src/render/term/osc.js';

const has = (binary) => spawnSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' }).status === 0;
const missing = ['script', 'mkfifo'].filter((binary) => !has(binary));
const skip = process.platform !== 'linux' ? 'requires Linux /proc and util-linux script'
  : missing.length ? `missing ${missing.join(', ')}` : false;
const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const fixture = fileURLToPath(new URL('fixtures/fake-harness.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('real relay hooks project lifecycle states and reset the controlling terminal on exit', { skip, timeout: 30_000 }, async () => {
  assert.ok(existsSync(fixture), 'fake Claude harness fixture exists');
  const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-'));
  const state = join(dir, 'familiar');
  const relayState = join(dir, 'relay');
  const config = join(dir, 'config');
  const themes = join(dir, 'themes');
  const subscribers = join(dir, 'subscribers.json');
  const fifo = join(dir, 'payloads');
  const log = join(dir, 'terminal.log');
  const sessionId = 'relay-e2e-session';
  const env = { ...process.env, RELAY_STATE_DIR: relayState, FAMILIAR_STATE_DIR: state,
    FAMILIAR_CONFIG_DIR: config, FAMILIAR_THEMES_DIR: themes, TERM: 'xterm-kitty' };
  delete env.TMUX;
  let client, closed, fd, harnessPid;
  let cleaning;
  const cleanup = () => cleaning ??= (async () => {
    if (fd !== undefined) { closeSync(fd); fd = undefined; }
    if (harnessPid) {
      try { process.kill(harnessPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    } else if (client) client.kill('SIGTERM');
    if (closed) await closed;
    rmSync(dir, { recursive: true, force: true });
  })();
  const signals = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal,
    () => { void cleanup().finally(() => process.exit(1)); }]));
  for (const [signal, handler] of signals) process.once(signal, handler);
  try {
    mkdirSync(relayState, { mode: 0o700 });
    mkdirSync(config);
    cpSync(fileURLToPath(new URL('fixtures/theme-pack', import.meta.url)), join(themes, 'cats'), { recursive: true });
    const setup = spawnSync(process.execPath, [bin, 'setup', 'relay'], { env, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    writeFileSync(subscribers, setup.stdout, { mode: 0o600 });
    assert.equal(statSync(relayState).mode & 0o777, 0o700);
    assert.equal(statSync(subscribers).mode & 0o777, 0o600);
    const scheme = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { env, encoding: 'utf8' });
    assert.equal(scheme.status, 0, scheme.stderr);
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const command = [process.execPath, fixture, fifo, subscribers].map(shellQuote).join(' ');
    client = spawn('script', ['-qfc', command, log], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    closed = once(client, 'close');
    closed.catch(() => {});
    const terminal = () => existsSync(log) ? readFileSync(log, 'latin1') : '';
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        assert.equal(client.exitCode, null, `${label}: script exited; terminal:\n${terminal()}`);
        await sleep(25);
      }
      assert.fail(`${label} within 10 s; terminal:\n${terminal()}`);
    };
    await waitFor(() => {
      harnessPid = Number(terminal().match(/ready (\d+)/)?.[1]) || undefined;
      return harnessPid;
    }, 'fake Claude harness ready');
    assert.equal(readFileSync(`/proc/${harnessPid}/comm`, 'utf8').trim(), 'claude', 'setup: real Claude process name');
    const fields = readFileSync(`/proc/${harnessPid}/stat`, 'utf8').split(') ')[1].split(' ');
    assert.notEqual(Number(fields[4]), 0, 'setup: harness has a controlling pty');
    fd = openSync(fifo, 'w');
    const intent = () => JSON.parse(readFileSync(join(state, 'intent.json'), 'utf8'));
    for (const [event, expected] of [
      ['SessionStart', 'idle'], ['UserPromptSubmit', 'working'],
      ['Notification:permission_prompt', 'needs-approval'], ['Stop', 'done'], ['SessionEnd', undefined],
    ]) {
      writeSync(fd, `${JSON.stringify({ event, payload: { session_id: sessionId, cwd: dir,
        hook_event_name: event.split(':')[0], ...(event.startsWith('Notification:') ? { notification_type: 'permission_prompt' } : {}) } })}\n`);
      await waitFor(() => terminal().includes(`complete ${event} `), `${event} completed`);
      assert.ok(terminal().includes(`complete ${event} 0`), terminal());
      assert.equal(intent()[sessionId]?.current.state, expected, event);
    }
    assert.equal(JSON.parse(readFileSync(ledgerPaths(join(state, 'transmit'), sessionId).entryPath, 'utf8')).ended, true);
    const captured = terminal();
    assert.ok(captured.includes(oscReset()), 'terminal received the reset');
    assert.ok(captured.lastIndexOf(oscReset()) > captured.indexOf('complete Stop 0'), 'final reset follows Stop');
  } finally {
    await cleanup();
    for (const [signal, handler] of signals) process.off(signal, handler);
  }
});
