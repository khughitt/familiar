// `familiar niri focus ID` end to end: the typed CLI parses one canonical ID and the
// integration speaks Niri's socket. A test-owned fake server stands in for Niri, in its
// own process; every subprocess environment is built key by key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const SERVER = fileURLToPath(new URL('fixtures/fake-niri-socket.mjs', import.meta.url));

async function fakeNiri(t) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-niri-focus-'));
  const socketPath = join(dir, 'niri.sock');
  const logPath = join(dir, 'requests.log');
  await writeFile(logPath, '');
  const server = spawn(process.execPath, [SERVER, socketPath, logPath], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  await once(server.stdout, 'data');
  t.after(async () => {
    server.kill('SIGTERM');
    await once(server, 'exit');
    await rm(dir, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, HOME: dir, FAMILIAR_STATE_DIR: join(dir, 'state'), FAMILIAR_CONFIG_DIR: join(dir, 'config'), NIRI_SOCKET: socketPath };
  const run = (args, extra = {}) => new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...env, ...extra } }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
  const requests = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { dir, run, requests };
}

test('a click on output B focuses its ID and prints nothing, in any mode', async (t) => {
  const niri = await fakeNiri(t);
  for (const flags of [[], ['--json'], ['--pretty']]) {
    const result = await niri.run([...flags, 'niri', 'focus', '21']);
    assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  }
  const requests = await niri.requests();
  assert.deepEqual(requests.filter((r) => r !== 'Workspaces'), Array(3).fill({ Action: { FocusWorkspace: { reference: { Id: 21 } } } }));
});

test('the focused workspace needs no action and a missing one is an error object under --json', async (t) => {
  const niri = await fakeNiri(t);
  assert.equal((await niri.run(['niri', 'focus', '10'])).status, 0);
  const missing = await niri.run(['--json', 'niri', 'focus', '99']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(JSON.parse(missing.stderr).error.detail, /no workspace 99/);
  assert.deepEqual(await niri.requests(), ['Workspaces', 'Workspaces']);
});

test('a non-canonical ID is a usage error and nothing connects', async (t) => {
  const niri = await fakeNiri(t);
  for (const id of ['01', '-1', '2.0', '$(touch pwned)', '9007199254740992']) {
    const result = await niri.run(['niri', 'focus', id]);
    assert.equal(result.status, 2, id);
    assert.equal(result.stdout, '');
    // `-1` never reaches the ID check: the parser already refuses it as an option.
    assert.match(result.stderr, id.startsWith('-') ? /Unknown option '-1'/ : /workspace id/);
  }
  assert.equal((await niri.run(['niri', 'focus'])).status, 2);
  assert.deepEqual(await niri.requests(), []);
});

test('without NIRI_SOCKET the action fails explicitly', async (t) => {
  const niri = await fakeNiri(t);
  const result = await niri.run(['niri', 'focus', '21'], { NIRI_SOCKET: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NIRI_SOCKET is not set/);
});
