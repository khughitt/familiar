// `familiar niri focus ID` speaks Niri's socket protocol directly: a Workspaces
// preflight, then one FocusWorkspace action by stable ID. Every case runs against a
// fake server in a test-owned directory; nothing connects to the host's socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { focusWorkspace } from '../integrations/niri/ipc.js';

const ws = (id, idx, output, focused = false) => ({
  id, idx, name: null, output, is_urgent: false, is_active: focused, is_focused: focused, active_window_id: null,
});
// Output A's workspace 2 is focused; output B also has a workspace at index 2.
const outputAWorkspaceId = 10;
const outputBWorkspaceId = 21;
const WORKSPACES = [ws(outputAWorkspaceId, 2, 'DP-1', true), ws(outputBWorkspaceId, 2, 'HDMI-A-1')];

// A scripted server: `reply(request, index)` returns the text to write (or null to stay
// silent). Records every request line and every connection's close.
async function fakeNiri(t, reply) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-niri-ipc-'));
  const socketPath = join(dir, 'niri.sock');
  const requests = [];
  const connections = { opened: 0, closed: 0 };
  const server = createServer((socket) => {
    connections.opened += 1;
    socket.on('close', () => { connections.closed += 1; });
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        requests.push(JSON.parse(line));
        const text = reply(JSON.parse(line), requests.length - 1, socket);
        if (text !== null) socket.write(text);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const settled = async () => {
    for (let i = 0; i < 100 && connections.closed < connections.opened; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { socketPath, requests, connections, settled };
}

const standard = (actionReply = '{"Ok":"Handled"}\n') => (request) => (request === 'Workspaces'
  ? `${JSON.stringify({ Ok: { Workspaces: WORKSPACES } })}\n` : actionReply);

test('a click on output B focuses its stable ID even though both outputs have a workspace 2', async (t) => {
  const niri = await fakeNiri(t, standard());
  await focusWorkspace(String(outputBWorkspaceId), { socketPath: niri.socketPath });
  const [preflight, socketRequest] = niri.requests;
  assert.equal(preflight, 'Workspaces');
  assert.deepEqual(socketRequest, { Action: { FocusWorkspace: { reference: { Id: outputBWorkspaceId } } } });
  assert.equal(niri.requests.length, 2);
  await niri.settled();
  assert.deepEqual(niri.connections, { opened: 1, closed: 1 });
});

test('the action is written exactly, newline-framed', async (t) => {
  let raw = '';
  const niri = await fakeNiri(t, (request, index, socket) => {
    if (index === 0) {
      socket.once('data', (chunk) => { raw += chunk; });
      return `${JSON.stringify({ Ok: { Workspaces: WORKSPACES } })}\n`;
    }
    return '{"Ok":"Handled"}\n';
  });
  await focusWorkspace('21', { socketPath: niri.socketPath });
  assert.equal(raw, '{"Action":{"FocusWorkspace":{"reference":{"Id":21}}}}\n');
});

test('an already focused or missing target sends no action', async (t) => {
  const niri = await fakeNiri(t, standard());
  await focusWorkspace(String(outputAWorkspaceId), { socketPath: niri.socketPath });
  await assert.rejects(focusWorkspace('99', { socketPath: niri.socketPath }), /no workspace 99/);
  assert.deepEqual(niri.requests, ['Workspaces', 'Workspaces']);
  await niri.settled();
  assert.equal(niri.connections.closed, niri.connections.opened);
});

test('replies split across reads are reassembled', async (t) => {
  const niri = await fakeNiri(t, (request, index, socket) => {
    const text = index === 0 ? `${JSON.stringify({ Ok: { Workspaces: WORKSPACES } })}\n` : '{"Ok":"Handled"}\n';
    const half = Math.floor(text.length / 2);
    socket.write(text.slice(0, half));
    setTimeout(() => socket.write(text.slice(half)), 10);
    return null;
  });
  await focusWorkspace('21', { socketPath: niri.socketPath });
  assert.equal(niri.requests.length, 2);
});

for (const [name, reply, pattern] of [
  ['a native error', '{"Err":"workspace vanished"}\n', /niri refused: workspace vanished/],
  ['a malformed reply', '{"Ok":\n', /malformed reply/],
  ['an unexpected reply', '{"Ok":{"Workspaces":[]}}\n', /unexpected reply/],
]) test(`${name} to the action fails explicitly with no retry`, async (t) => {
  const niri = await fakeNiri(t, standard(reply));
  await assert.rejects(focusWorkspace('21', { socketPath: niri.socketPath }), pattern);
  assert.equal(niri.requests.length, 2);
  await niri.settled();
  assert.equal(niri.connections.closed, niri.connections.opened);
});

test('EOF before a reply fails', async (t) => {
  const niri = await fakeNiri(t, (request, index, socket) => { socket.end(); return null; });
  await assert.rejects(focusWorkspace('21', { socketPath: niri.socketPath }), /closed before replying/);
});

test('an oversized reply fails without buffering forever', async (t) => {
  const niri = await fakeNiri(t, () => 'x'.repeat(70_000));
  await assert.rejects(focusWorkspace('21', { socketPath: niri.socketPath }), /exceeds 65536 bytes/);
  await niri.settled();
  assert.equal(niri.connections.closed, niri.connections.opened);
});

test('a silent compositor times out and the socket is closed', async (t) => {
  const niri = await fakeNiri(t, () => null);
  const started = Date.now();
  await assert.rejects(focusWorkspace('21', { socketPath: niri.socketPath, timeoutMs: 100 }), /timed out after 100 ms/);
  assert.ok(Date.now() - started < 2000);
  await niri.settled();
  assert.equal(niri.connections.closed, niri.connections.opened);
});

test('a non-canonical or unsafe ID is refused before connecting', async (t) => {
  const niri = await fakeNiri(t, standard());
  for (const id of ['', '01', '-1', '1.5', ' 21', '21 ', '9007199254740992', 'abc']) {
    await assert.rejects(focusWorkspace(id, { socketPath: niri.socketPath }), /workspace id/);
  }
  assert.equal(niri.connections.opened, 0);
});

test('a missing socket path or a refused connection fails explicitly', async (t) => {
  await assert.rejects(focusWorkspace('21', { socketPath: '' }), /NIRI_SOCKET/);
  await assert.rejects(focusWorkspace('21', { socketPath: undefined }), /NIRI_SOCKET/);
  const dir = await mkdtemp(join(tmpdir(), 'familiar-niri-ipc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(focusWorkspace('21', { socketPath: join(dir, 'absent.sock') }), /cannot connect/);
});
