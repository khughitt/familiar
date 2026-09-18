import { execFileSync } from 'node:child_process';

// NOT NAMED GIT_TIMEOUT_MS OR BRANCH_TIMEOUT_MS. src/bus/identity.js and
// src/render/term/statusfields.js each own a constant for their own deadline; this one
// bounds a local IPC round trip to the tmux server from inside a hook. Measured
// sub-millisecond on a healthy server; a second is the budget for a wedged one.
export const TMUX_PROBE_TIMEOUT_MS = 1000;

// The one place in familiar that talks to tmux. Everything a caller needs to decide
// whether — and to which terminal — graphics can be sent comes back from one
// display-message: the pane's passthrough setting, the ATTACHED client's terminal
// (the inner TERM=tmux-256color hides it), and that client's incarnation. `client_tty`
// alone is a pathname the kernel reuses (two successive ptys both came back as
// /dev/pts/16 under review); `client_pid` + `client_created` make it an identity.
const FORMAT = [
  '#{allow-passthrough}',
  '#{client_termname}',
  '#{client_termtype}',
  '#{client_tty}',
  '#{client_pid}',
  '#{client_created}',
].join('\t');

const PASSTHROUGH = new Set(['off', 'on', 'all']);
const failure = (reason) => Object.freeze({ ok: false, reason });

// No default env, for the reason graphicsCapability() has none: the environment that
// says "inside tmux" belongs to the agent process, not to whoever is asking.
export function tmuxFacts(env, { exec = execFileSync } = {}) {
  if (env === undefined || env === null || typeof env !== 'object') {
    throw new TypeError('tmuxFacts requires an explicit environment');
  }
  if (!env.TMUX) return null;
  // $TMUX is `<socket>,<server pid>,<session index>`.
  const socket = env.TMUX.split(',')[0];
  const pane = env.TMUX_PANE;
  if (!pane) return failure('no-pane');

  let output;
  try {
    output = exec('tmux', ['-S', socket, 'display-message', '-p', '-t', pane, FORMAT], {
      encoding: 'utf8',
      // stderr is discarded so a broken server can never write into the hook's own
      // output, which is the agent's terminal.
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TMUX_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return failure('no-binary');
    if (error?.code === 'ETIMEDOUT') return failure('timeout');
    return failure('exit');
  }

  const [passthrough, termname, termtype, tty, pidText, createdText] = String(output).replace(/\n$/, '').split('\t');
  // A detached server has a pane and a setting but no client: nothing to draw on.
  if (!termname) return failure('no-client');
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : NaN;
  const created = /^\d+$/.test(createdText) ? Number(createdText) : NaN;
  if (!PASSTHROUGH.has(passthrough) || !tty || !Number.isSafeInteger(pid) || !Number.isSafeInteger(created)) {
    return failure('exit');
  }
  return Object.freeze({
    ok: true,
    passthrough,
    termname,
    termtype: termtype ?? '',
    client: Object.freeze({ tty, pid, created }),
  });
}

// DCS passthrough: `ESC P tmux ; <bytes with every ESC doubled> ESC \`. Moved here from
// placeholder.js because the encoder emits Buffers and the CLI transmitter emits
// strings; both are ASCII (control fields and base64), so latin1 round-trips losslessly.
export function wrapForTmux(escapes) {
  if (Buffer.isBuffer(escapes)) {
    return Buffer.from(wrapForTmux(escapes.toString('latin1')), 'latin1');
  }
  return `\x1bPtmux;${escapes.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

// The identity the transmission ledger keys `held` on (spec §3.5). Outside tmux the
// agent's own pid/starttime already identify its pty, so `direct` needs no more.
export function transportFor(tmux) {
  if (!tmux || !tmux.ok) return 'direct';
  const { tty, pid, created } = tmux.client;
  return `tmux:${tty}:${pid}:${created}`;
}

// For `theme show`: a person with the wrong setting should learn the setting.
export function describeTmux(tmux) {
  if (!tmux) return '';
  if (!tmux.ok) return ` — tmux probe: ${tmux.reason}`;
  if (tmux.passthrough !== 'all') return ` — tmux allow-passthrough=${tmux.passthrough}, needs all`;
  return ` — tmux client ${tmux.termname} (${tmux.termtype}) is not a terminal familiar can draw on`;
}
