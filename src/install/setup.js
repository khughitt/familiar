export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const commandHook = (command, matcher) => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks: [{ type: 'command', command }],
});

// `--agent` trails the event because that is the shape `familiar hook` already accepts, and both
// executors that reach these strings -- Claude Code's `/bin/sh -c` and Codex's `/bin/zsh -c`,
// both measured -- leave a single-quoted path alone.
const commandFor = (bin, event, agent) =>
  `${shellQuote(bin)} hook ${event}${agent === undefined ? '' : ` --agent ${agent}`}`;

const claudeCode = (bin) => {
  const command = (event) => commandFor(bin, event);
  return {
    hooks: {
      SessionStart: [commandHook(command('SessionStart'), 'startup|resume')],
      UserPromptSubmit: [commandHook(command('UserPromptSubmit'))],
      PreToolUse: [commandHook(command('PreToolUse'), '*')],
      Notification: [
        commandHook(command('Notification:idle_prompt'), 'idle_prompt'),
        commandHook(command('Notification:permission_prompt'), 'permission_prompt'),
      ],
      Stop: [commandHook(command('Stop'))],
      StopFailure: [commandHook(command('StopFailure'))],
      SessionEnd: [commandHook(command('SessionEnd'))],
    },
    statusLine: {
      type: 'command',
      command: `${shellQuote(bin)} statusline`,
      refreshInterval: 2,
    },
  };
};

// No statusLine: Codex's status line is a closed enum of built-ins and it draws its own pet
// natively, so there are no cells for Familiar to print into (src/adapters/codex.js). These
// hooks exist to put the session on the bus, and the events are exactly the ones that adapter
// maps -- Codex has no idle-prompt notification and no error event to configure.
const codex = (bin) => {
  const hook = (event, matcher) => commandHook(commandFor(bin, event, 'codex'), matcher);
  return {
    hooks: {
      SessionStart: [hook('SessionStart')],
      UserPromptSubmit: [hook('UserPromptSubmit')],
      PreToolUse: [hook('PreToolUse', '*')],
      PermissionRequest: [hook('PermissionRequest')],
      Stop: [hook('Stop')],
      SessionEnd: [hook('SessionEnd')],
    },
  };
};

export function setupDocument(agent, binPath) {
  if (agent === 'claude-code') return claudeCode(binPath);
  if (agent === 'codex') return codex(binPath);
  throw new Error(`unknown setup target ${JSON.stringify(agent)}`);
}
