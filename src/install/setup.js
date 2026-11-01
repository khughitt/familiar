import { realpathSync } from 'node:fs';

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// agy is opt-in and `familiar setup relay` leaves it out: relay before 0.3.0 refuses a
// subscribers file that names agy, and that refusal fails every guarded event for every
// harness. The CLI includes it once the host's pinned relay accepts agy.
export function setupDocument(target, binPath, { agy = false } = {}) {
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
      // A cold `familiar observe` takes about 200 ms, so each harness's teardown takes all
      // relay admits for SessionEnd at that harness's default outer timeout.
      { name: 'familiar-teardown', role: 'observer', harnesses: ['claude-code'],
        kinds: ['session-end'], argv, timeoutMs: 400 },
      { name: 'familiar-teardown-codex', role: 'observer', harnesses: ['codex'],
        kinds: ['session-end'], argv, timeoutMs: 267 },
      // agy maps only these three events and has no session end. At agy's 30 s default
      // relay leaves subscribers 11 s; a shorter --outer-ms, or a slow before-tool guard
      // beside this entry, overruns that budget and refuses every agy tool call.
      ...(agy ? [{ name: 'familiar-agy', role: 'observer', harnesses: ['agy'],
        kinds: ['session-start', 'before-tool', 'turn-end'], argv, timeoutMs: 2000 }] : []),
    ] };
  }
  throw new Error(`unknown setup target ${JSON.stringify(target)}`);
}
