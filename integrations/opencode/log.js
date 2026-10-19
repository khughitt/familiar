import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync } from 'node:fs';

const stateDir = process.env.FAMILIAR_STATE_DIR ?? join(homedir(), '.local', 'state', 'familiar');
const errorLog = join(stateDir, 'opencode-plugin.log');

// Stderr belongs to the TUI, so errors go to the existing log file.
export function logError(message) {
  try {
    appendFileSync(errorLog, `${new Date().toISOString()} ${message}\n`);
  } catch { /* No other error channel can safely write into the TUI. */ }
}
