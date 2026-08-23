import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDarwinRow, runDarwinPs } from './proc.js';

const AGENTS = new Set(['claude-code', 'codex', 'opencode']);
const COMM_FIELDS = 'pid=,ppid=,tty=,lstart=,comm=';
const COMMAND_FIELDS = 'pid=,ppid=,tty=,lstart=,command=';
// MIRRORS THE CLASSIFIER, NOT A GUESS AT IT. src/render/term/capability.js decides capability from
// GRAPHICS_MARKERS plus MULTIPLEXER_MARKERS, and for two of them it compares VALUES:
// `TERM === 'xterm-kitty'`, `TERM_PROGRAM === 'ghostty'`, and `/^(screen|tmux)/.test(TERM)`. A
// presence boolean cannot answer any of those, so the first capture could confirm Kitty only by
// luck -- KITTY_WINDOW_ID alone is enough for Kitty, and nothing else was decidable. Ghostty and
// tmux sessions need the values.
//
// The two value markers are terminal identity, never user data, and they are still bounded: a
// value outside a conservative terminal-name shape is recorded as 'other' rather than copied, so
// an oddly-set TERM cannot smuggle a path or a secret into evidence meant to be shareable.
// Everything else is presence only, because GHOSTTY_* are filesystem paths and TMUX is a socket
// path carrying the uid.
const ENVIRONMENT_VALUE_MARKERS = ['TERM', 'TERM_PROGRAM'];
const ENVIRONMENT_PRESENCE_MARKERS = [
  'KITTY_WINDOW_ID', 'KITTY_PID', 'GHOSTTY_RESOURCES_DIR', 'GHOSTTY_BIN_DIR', 'TMUX',
];
const TERMINAL_NAME = /^[A-Za-z0-9._+-]{1,32}$/;

const environmentEvidence = (env) => Object.fromEntries([
  ...ENVIRONMENT_VALUE_MARKERS.map((name) => {
    const value = env[name];
    if (value === undefined) return [name, false];
    return [name, TERMINAL_NAME.test(value) ? value : 'other'];
  }),
  ...ENVIRONMENT_PRESENCE_MARKERS.map((name) => [name, env[name] !== undefined]),
]);

export const MACOS_WITNESS_PATH = fileURLToPath(
  new URL('../../.familiar-macos-executed.jsonl', import.meta.url),
);
export const MACOS_WITNESS_ENABLE_PATH = fileURLToPath(
  new URL('../../.familiar-macos-witness-enabled', import.meta.url),
);

function row(raw, field, expectedPid) {
  const value = raw.trimEnd();
  if (value.includes('\n')) {
    throw new Error(`macOS process probe: malformed ${field} row for pid ${expectedPid}`);
  }
  let identity;
  try {
    identity = parseDarwinRow(value);
  } catch (cause) {
    throw new Error(`macOS process probe: malformed ${field} row for pid ${expectedPid}`, { cause });
  }
  if (identity.pid !== expectedPid) {
    throw new Error(`macOS process probe: identity changed while capturing pid ${expectedPid}`);
  }
  return { ...identity, raw: value };
}

export function captureProcessEvidence({
  agent,
  event,
  hookPid = process.pid,
  platform = process.platform,
  outDir = join(tmpdir(), 'familiar-macos-process-spike'),
  capturedAt = new Date().toISOString(),
  env = process.env,
  runPs = runDarwinPs,
} = {}) {
  if (!AGENTS.has(agent)) {
    throw new Error(`macOS process probe: unsupported agent label ${JSON.stringify(agent)}`);
  }
  if (platform !== 'darwin') throw new Error('macOS process probe: requires Darwin');

  const chain = [];
  const seen = new Set();
  let pid = hookPid;
  while (pid > 0) {
    if (seen.has(pid)) throw new Error(`macOS process probe: ancestor cycle at pid ${pid}`);
    seen.add(pid);
    const comm = row(runPs(['-p', String(pid), '-o', COMM_FIELDS]), 'comm', pid);
    const command = row(runPs(['-p', String(pid), '-o', COMMAND_FIELDS]), 'command', pid);
    if (comm.ppid !== command.ppid || comm.starttime !== command.starttime
        || comm.tty !== command.tty) {
      throw new Error(`macOS process probe: identity changed while capturing pid ${pid}`);
    }
    chain.push({ pid, ppid: comm.ppid, comm: comm.raw, command: command.raw });
    pid = comm.ppid;
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const path = join(outDir, `${agent}.jsonl`);
  appendFileSync(path, `${JSON.stringify({
    version: 1,
    agent,
    event,
    capturedAt,
    hookPid,
    environment: environmentEvidence(env),
    chain,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export function writeExecutionWitness({
  path = MACOS_WITNESS_PATH,
  agent,
  event,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!AGENTS.has(agent)) {
    throw new Error(`macOS process witness: unsupported agent label ${JSON.stringify(agent)}`);
  }
  appendFileSync(path, `${JSON.stringify({ capturedAt, agent, event })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}
