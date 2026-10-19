import { realpathSync } from 'node:fs';

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function setupDocument(target, binPath) {
  if (target === 'claude-code') return { statusLine: {
    type: 'command', command: `${shellQuote(binPath)} statusline`, refreshInterval: 2,
  } };
  if (target === 'relay') {
    const argv = [realpathSync(binPath), 'observe'];
    return { schema: 1, subscribers: [
      { name: 'familiar', role: 'observer', harnesses: ['claude-code', 'codex'],
        kinds: ['session-start', 'prompt', 'before-tool', 'activity', 'idle', 'needs-input', 'needs-approval', 'turn-end', 'turn-error', 'reconcile'],
        argv, timeoutMs: 2000 },
      { name: 'familiar-opencode', role: 'observer', harnesses: ['opencode'],
        kinds: ['session-start', 'activity', 'idle', 'needs-approval', 'turn-error', 'session-end'],
        argv, timeoutMs: 1000 },
      { name: 'familiar-teardown', role: 'observer', harnesses: ['claude-code', 'codex'],
        kinds: ['session-end'], argv, timeoutMs: 200 },
    ] };
  }
  throw new Error(`unknown setup target ${JSON.stringify(target)}`);
}
