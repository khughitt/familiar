// A fake Niri IPC socket for CLI tests: answers the Workspaces preflight with two
// outputs that both have a workspace at index 2 (10 focused on DP-1, 21 on HDMI-A-1),
// acknowledges any FocusWorkspace action, and appends every request line to a log.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';

const [socketPath, logPath] = process.argv.slice(2);
const workspace = (id, output, focused) => ({ id, idx: 2, name: null, output, is_urgent: false,
  is_active: focused, is_focused: focused, active_window_id: null });
const server = createServer((socket) => {
  let buffer = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      appendFileSync(logPath, `${line}\n`);
      socket.write(JSON.parse(line) === 'Workspaces'
        ? `${JSON.stringify({ Ok: { Workspaces: [workspace(10, 'DP-1', true), workspace(21, 'HDMI-A-1', false)] } })}\n`
        : '{"Ok":"Handled"}\n');
    }
  });
});
server.listen(socketPath, () => process.stdout.write('ready\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
