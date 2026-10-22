// Publish and observe a real event with a test-owned process and no terminal output.
import { applyEvent, readSnapshot, paths as relayPaths, createProcessOps } from 'relay';
import { observe } from '../../src/observe/run.js';
import { paths } from '../../src/bus/paths.js';

const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const { session_id: sessionId, cwd } = JSON.parse(Buffer.concat(input).toString());
const event = { schema: 1, kind: 'prompt', harness: 'claude-code', nativeEvent: 'UserPromptSubmit',
  sessionId, agentId: `claude-code:${sessionId}`, cwd, tool: null };
const registry = relayPaths();
const relayProcess = createProcessOps();
const { snapshot } = await applyEvent(event, { paths: registry, processOps: relayProcess, resolveSessionPid: () => process.pid });
const result = await observe({ text: JSON.stringify({ schema: 1, type: 'event', subscriber: 'familiar', event,
  registry: { generation: snapshot.generation, revision: snapshot.revision }, changed: true, reaped: [],
}), deps: {
  paths: paths(), relay: { readSnapshot: () => readSnapshot({ paths: registry }) }, relayProcess,
  adapterFor: () => ({ resolveSessionPid: () => process.pid, resolveTerminalPid: () => process.pid }),
  emitTransition: async () => ({ kind: 'unchanged' }),
} });
for (const line of result.lines) process.stderr.write(`${line}\n`);
process.exitCode = result.exitCode;
