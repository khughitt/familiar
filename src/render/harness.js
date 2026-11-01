export function printsPlaceholderCells(harness) {
  // agy 1.4.12's status line passes the placeholder rows to the terminal verbatim (fam-93c939),
  // so `familiar statusline` can own the cells there as it does in Claude Code.
  if (harness === 'claude-code' || harness === 'agy') return true;
  if (harness === 'codex' || harness === 'opencode') return false;
  throw new Error(`unknown harness: ${harness}`);
}

export function noTerminalMessage(harness, chain) {
  const ancestry = chain.map((p) => `${p.pid}(${p.comm})`).join(' -> ');
  const headless = chain.find((p, i) => i > 0 && p.comm === 'codex' && p.tty === null);
  if (harness === 'codex' && headless) {
    return `the codex process ${headless.pid} owns no terminal: Codex 0.160+ runs hooks under its ` +
      'shared app-server daemon, where no session can be tied to its terminal -- launch it ' +
      'with `codex --no-daemon`. Chain: ' + ancestry;
  }
  return `could not find the ${harness} process with a terminal among the ancestors: ${ancestry}`;
}
