// One user click: focus a Niri workspace by its stable ID over Niri's own socket.
// A Workspaces preflight first, so a vanished target fails before any action and an
// already focused one is left alone (no back-and-forth toggle); then exactly one
// FocusWorkspace action by ID. Never an index, never a retry on another workspace.
import { createConnection } from 'node:net';

const MAX_REPLY_BYTES = 65_536;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export function parseWorkspaceId(text) {
  if (typeof text !== 'string' || !DECIMAL.test(text) || Number(text) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`niri: workspace id must be one canonical decimal integer up to ${Number.MAX_SAFE_INTEGER}`);
  }
  return Number(text);
}

// Niri may acknowledge an action for a workspace that disappeared after the
// preflight; `Handled` is an acknowledgement, not confirmed focus.
export async function focusWorkspace(id, { socketPath, connect = createConnection, timeoutMs = 2000 } = {}) {
  const target = parseWorkspaceId(id);
  if (typeof socketPath !== 'string' || socketPath === '') throw new Error('niri: NIRI_SOCKET is not set');
  const socket = connect(socketPath);
  let buffer = '';
  let waiting = null;
  let failure = null;
  const settle = (error, line) => {
    if (waiting === null) return;
    const { resolve, reject } = waiting;
    waiting = null;
    if (error) reject(error); else resolve(line);
  };
  const fail = (error) => {
    failure ??= error;
    settle(error);
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      settle(null, line);
    } else if (Buffer.byteLength(buffer) > MAX_REPLY_BYTES) {
      fail(new Error(`niri: reply exceeds ${MAX_REPLY_BYTES} bytes`));
    }
  });
  socket.on('error', (error) => fail(new Error(`niri: cannot connect to NIRI_SOCKET: ${error.code ?? error.message}`)));
  socket.on('close', () => fail(new Error('niri: socket closed before replying')));
  const timer = setTimeout(() => fail(new Error(`niri: timed out after ${timeoutMs} ms`)), timeoutMs);
  const request = (value) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    waiting = { resolve, reject };
    socket.write(`${JSON.stringify(value)}\n`);
  }).then((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('niri: malformed reply');
    }
  });
  const refused = (reply) => (reply !== null && typeof reply === 'object' && typeof reply.Err === 'string'
    ? new Error(`niri refused: ${reply.Err}`) : null);
  try {
    const listed = await request('Workspaces');
    const workspaces = listed?.Ok?.Workspaces;
    if (refused(listed)) throw refused(listed);
    if (!Array.isArray(workspaces)) throw new Error('niri: unexpected reply to Workspaces');
    const found = workspaces.find((workspace) => workspace?.id === target);
    if (!found) throw new Error(`niri: no workspace ${id}`);
    if (found.is_focused === true) return;
    const acted = await request({ Action: { FocusWorkspace: { reference: { Id: target } } } });
    if (refused(acted)) throw refused(acted);
    if (acted?.Ok !== 'Handled') throw new Error('niri: unexpected reply to FocusWorkspace');
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
