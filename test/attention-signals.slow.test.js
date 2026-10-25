// How the real `familiar-niri watch` ends when it is stopped as a unit is: a signal to
// its whole process group reaches the `niri msg -j event-stream` child too, possibly
// first, and that is still a clean stop; a signal to the child alone is a stream
// failure. Fake `niri` and `noctalia` executables stand in for the desktop, and every
// subprocess environment is built key by key. Only the process groups this test creates
// and the pid its fake `niri` records are ever signalled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths as familiarPaths } from '../src/bus/paths.js';

const skip = process.platform !== 'linux' ? 'requires Linux process groups' : false;
const NIRI_BIN = fileURLToPath(new URL('../bin/familiar-niri', import.meta.url));
const THEME = fileURLToPath(new URL('fixtures/theme-pack', import.meta.url));
const SOCKET = '/run/user/1000/niri-signals.sock';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORKSPACES = [{
  id: 10, idx: 1, name: null, output: 'DP-1', is_urgent: false, is_active: true, is_focused: true, active_window_id: null,
}];

// The event stream prints one snapshot, records its pid and parent, and then blocks. It
// installs no signal handler, as `niri msg` installs none.
const FAKE_NIRI = `#!${process.execPath}
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
const fake = JSON.parse(readFileSync(process.env.FAKE_DESKTOP, 'utf8'));
const args = process.argv.slice(2).join(' ');
if (args === 'msg -j windows') process.stdout.write(JSON.stringify(fake.windows));
else if (args === 'msg -j workspaces') process.stdout.write(JSON.stringify(fake.workspaces));
else if (args === 'msg -j event-stream') {
  process.stdout.write(JSON.stringify({ WorkspacesChanged: { workspaces: fake.workspaces } }) + '\\n');
  writeFileSync(process.env.FAKE_STREAM_PID + '.tmp', JSON.stringify({ pid: process.pid, ppid: process.ppid }));
  renameSync(process.env.FAKE_STREAM_PID + '.tmp', process.env.FAKE_STREAM_PID);
  const parent = process.ppid;
  // An orphaned stream exits instead of outliving its coordinator.
  setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 100);
} else process.exit(0);
`;
const FAKE_NOCTALIA = `#!${process.execPath}
import { readFileSync } from 'node:fs';
const fake = JSON.parse(readFileSync(process.env.FAKE_DESKTOP, 'utf8'));
const [, command] = process.argv.slice(2);
if (command === 'notification-dnd-status') process.stdout.write(fake.dnd + '\\n');
else process.exit(0);
`;

// A running coordinator, leading its own process group, with its event stream up.
async function coordinator(t) {
  const root = mkdtempSync(join(tmpdir(), 'familiar-attention-signals-'));
  const fakeBin = join(root, 'bin');
  const themes = join(root, 'themes');
  const config = join(root, 'config');
  for (const dir of [fakeBin, themes, config]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  cpSync(THEME, join(themes, 'cats'), { recursive: true });
  writeFileSync(join(config, 'config.yaml'), 'theme: cats\nmotion: full\n');
  writeFileSync(join(config, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(fakeBin, 'niri'), FAKE_NIRI, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'noctalia'), FAKE_NOCTALIA, { mode: 0o755 });
  const fakePath = join(root, 'desktop.json');
  writeFileSync(fakePath, JSON.stringify({ workspaces: WORKSPACES, windows: [], dnd: 'off' }));
  const streamPidPath = join(root, 'event-stream.pid');
  const env = {
    PATH: fakeBin, HOME: root, FAMILIAR_STATE_DIR: join(root, 'state'), FAMILIAR_CONFIG_DIR: config,
    FAMILIAR_THEMES_DIR: themes, NIRI_SOCKET: SOCKET, FAKE_DESKTOP: fakePath, FAKE_STREAM_PID: streamPidPath,
  };
  const paths = familiarPaths(env);
  const child = spawn(process.execPath, [NIRI_BIN, 'watch'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk) => { log += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    // The whole group: the coordinator and whatever it still has running.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15_000;
  while (!(existsSync(paths.attentionHealthPath) && existsSync(streamPidPath))) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) assert.fail(`no running coordinator; log: ${log}`);
    await sleep(50);
  }
  const stream = JSON.parse(readFileSync(streamPidPath, 'utf8'));
  // The recorded pid is this coordinator's own child, never anything else on the host.
  assert.equal(stream.ppid, child.pid);
  return {
    pid: child.pid, streamPid: stream.pid, log: () => log,
    health: () => JSON.parse(readFileSync(paths.attentionHealthPath, 'utf8')),
    async exit() {
      const [code, signal] = await exited;
      return { code, signal };
    },
  };
}

test('SIGTERM to the process group exits 0 with stopped: true', { skip, timeout: 30_000 }, async (t) => {
  const c = await coordinator(t);
  process.kill(-c.pid, 'SIGTERM');
  assert.deepEqual(await c.exit(), { code: 0, signal: null }, c.log());
  assert.equal(c.health().stopped, true, c.log());
});

test('SIGINT to the process group exits 0 with stopped: true', { skip, timeout: 30_000 }, async (t) => {
  const c = await coordinator(t);
  process.kill(-c.pid, 'SIGINT');
  assert.deepEqual(await c.exit(), { code: 0, signal: null }, c.log());
  assert.equal(c.health().stopped, true, c.log());
});

test('SIGTERM to the event-stream child alone exits 1 with stopped: false', { skip, timeout: 30_000 }, async (t) => {
  const c = await coordinator(t);
  const signalledAt = Date.now();
  process.kill(c.streamPid, 'SIGTERM');
  assert.deepEqual(await c.exit(), { code: 1, signal: null }, c.log());
  assert.ok(Date.now() - signalledAt >= 900, 'it waited about a second for a stop signal of its own');
  assert.equal(c.health().stopped, false, c.log());
  assert.match(c.log(), /event stream killed by SIGTERM/);
});
