import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// RESOLVED FROM OUR OWN LOCATION, never from $PATH. The plugin runs inside opencode, whose $PATH
// is whatever the user's launcher happened to export -- and a plugin that silently stops working
// because a shell profile changed is exactly the failure mode this project spends its time
// avoiding. `integrations/opencode/hook.js` -> `bin/familiar` is two levels up, always.
export const FAMILIAR_BIN = fileURLToPath(new URL('../../bin/familiar', import.meta.url));

// The one piece of I/O in the plugin, and it is its own module so that it can be TESTED: point it
// at /bin/false and a nonzero exit had better become a rejection, because queue.js's whole failure
// contract is built on `run` rejecting.
//
// `shell: false` -- there is nothing to expand, and a shell is only an opportunity for the cwd to
// be interpreted.
//
// stderr is PIPED, NOT INHERITED. Our stderr is opencode's stderr, which is the tty opentui is
// rendering into; familiar's hook writes eviction diagnostics there, and inheriting them would
// spray them across the user's screen mid-frame. We capture them instead and hand them to the
// rejection, so queue.js can put them in a toast where they belong.
//
// stdout is IGNORED. The hook writes its escape codes to /proc/<agent pid>/fd/1 directly (see
// src/render/term/emit.js); anything on its stdout would be a diagnostic we have no use for.
export function spawnHook(event, payload, { bin = FAMILIAR_BIN, args, spawnFn = spawn } = {}) {
  const argv = args ?? ['hook', event, '--agent', 'opencode'];

  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, argv, { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    // ENOENT, EAGAIN: the spawn never happened. There is no exit code to wait for.
    child.once('error', reject);

    child.once('close', (code) => {
      if (code === 0) return resolve();
      const said = stderr.trim();
      reject(new Error(`familiar hook exited ${code}${said ? `: ${said}` : ''}`));
    });

    // The child can exit before we finish writing -- a hook that throws on an unknown event is
    // gone in milliseconds. That is an EPIPE on our end, and it is not the error worth reporting:
    // the exit code is. Swallow it and let `close` above say what actually went wrong.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
