process.title = 'claude';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [fifo, subscribers] = process.argv.slice(2);
const relay = fileURLToPath(new URL('../../node_modules/relay/bin/relay.js', import.meta.url));
const input = createReadStream(fifo);
const lines = createInterface({ input });
let active;
let stopping = false;
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => {
  stopping = true;
  lines.close();
  input.destroy();
  // Relay bounds its observers; let the current hook reap them before this parent exits.
  void (active ?? Promise.resolve()).finally(() => process.exit(0));
}]));
for (const [signal, handler] of handlers) process.once(signal, handler);

try {
  process.stderr.write(`ready ${process.pid}\n`);
  for await (const line of lines) {
    if (stopping) break;
    const { event, payload } = JSON.parse(line);
    const child = spawn(process.execPath, [relay, 'hook', '--harness', 'claude-code',
      '--subscribers', subscribers, event], { stdio: ['pipe', 'inherit', 'inherit'] });
    active = once(child, 'close');
    child.stdin.end(JSON.stringify(payload));
    const [code, signal] = await active;
    active = undefined;
    process.stderr.write(`complete ${event} ${signal ?? code}\n`);
    if (code !== 0) { process.exitCode = 1; break; }
  }
} finally {
  if (active) await active;
  lines.close();
  input.destroy();
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
