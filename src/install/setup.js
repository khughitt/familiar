export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// agy is opt-in and `familiar setup relay` leaves it out: relay before 0.3.0 refuses a
// subscribers file that names agy, and that refusal fails every guarded event for every
// harness. The CLI includes it once the host's pinned relay accepts agy.
export function setupDocument(target, binPath, { agy = false } = {}) {
  if (target === 'claude-code') return { statusLine: {
    type: 'command', command: `${shellQuote(binPath)} statusline`, refreshInterval: 2,
  } };
  if (target === 'relay') {
    const subscribers = [
      { name: 'familiar', harnesses: ['claude-code', 'codex'],
        kinds: ['session-start', 'prompt', 'before-tool', 'activity', 'idle', 'needs-input', 'needs-approval', 'turn-end', 'turn-error', 'reconcile'],
        privateFields: [{ nativeEvent: 'Stop', fields: ['backgroundTasks'] }], timeoutMs: 2000 },
      { name: 'familiar-codex-workers', harnesses: ['codex'],
        kinds: ['child-start', 'child-stop'], timeoutMs: 2000 },
      // Relay's installer uses 60 s for Claude SessionEnd. Codex's 3 s cap cannot
      // admit a subscriber, and OpenCode's 5 s window leaves only 84 ms to run one.
      { name: 'familiar-teardown', harnesses: ['claude-code'],
        kinds: ['session-end'], timeoutMs: 400 },
      // agy maps only these three events and has no session end. At agy's 30 s default
      // relay leaves subscribers 11 s; a shorter --outer-ms, or a slow before-tool guard
      // beside this entry, overruns that budget and refuses every agy tool call.
      ...(agy ? [{ name: 'familiar-agy', harnesses: ['agy'],
        kinds: ['session-start', 'before-tool', 'turn-end'], timeoutMs: 2000 }] : []),
    ];
    return { schema: 2, subscribers: subscribers.map((observer) => ({
      ...observer, role: 'observer', registry: 'snapshot', argv: ['familiar', 'observe'],
    })) };
  }
  throw new Error(`unknown setup target ${JSON.stringify(target)}`);
}
