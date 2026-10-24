// Noctalia 5.3's native IPC, as familiar uses it: the live Do Not Disturb status and
// one generic toast. Argument vectors only; no shell, no notify-send path.
const TIMEOUT_MS = 2000;
const URGENCIES = ['normal', 'low'];

// Only an exact `on` or `off` counts. Anything else (a failed or slow command, a
// renamed output) is unknown, and unknown must never be read as off.
export async function readDnd({ execFile, timeoutMs = TIMEOUT_MS }) {
  let stdout;
  try {
    ({ stdout } = await execFile('noctalia', ['msg', 'notification-dnd-status'], { timeout: timeoutMs, maxBuffer: 4096 }));
  } catch (error) {
    throw new Error(`noctalia: do not disturb status unavailable: ${error.code ?? error.signal ?? error.message}`);
  }
  const answer = String(stdout).replace(/\n$/, '');
  if (answer !== 'on' && answer !== 'off') throw new Error('noctalia: do not disturb status unavailable: unexpected answer');
  return answer;
}

// Generic text only: the caller builds summary and body from counts and labels, never
// from prompts, commands or approval contents. No action that answers anything.
export async function sendToast({ payload, execFile, timeoutMs = TIMEOUT_MS }) {
  const keys = ['app_name', 'summary', 'body', 'urgency'];
  const valid = payload !== null && typeof payload === 'object' && Object.keys(payload).length === keys.length
    && keys.every((key) => Object.hasOwn(payload, key)) && payload.app_name === 'familiar'
    && typeof payload.summary === 'string' && payload.summary !== '' && typeof payload.body === 'string'
    && URGENCIES.includes(payload.urgency);
  if (!valid) throw new Error('noctalia: invalid toast payload');
  try {
    await execFile('noctalia', ['msg', 'notification-show', JSON.stringify(payload)], { timeout: timeoutMs, maxBuffer: 4096 });
  } catch (error) {
    throw new Error(`noctalia: notification-show failed: ${error.code ?? error.signal ?? error.message}`);
  }
}
