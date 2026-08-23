export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const commandHook = (command, matcher) => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks: [{ type: 'command', command }],
});

const claudeCode = (bin) => {
  const command = (event) => `${shellQuote(bin)} hook ${event}`;
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

export function setupDocument(agent, binPath) {
  if (agent === 'claude-code') return claudeCode(binPath);
  throw new Error(`unknown setup target ${JSON.stringify(agent)}`);
}
