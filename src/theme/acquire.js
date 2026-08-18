import { spawn } from 'node:child_process';
import { constants, createWriteStream, statSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { stripVTControlCharacters } from 'node:util';
import { LIMITS } from 'familiar-theme';

export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_GROWTH_LIMIT_BYTES = 4 * LIMITS.MAX_TOTAL_BYTES;

// Transport rule (spec §1): HTTPS URLs and local directories, nothing else.
// Credentialed URLs are refused because the given URL is persisted in the
// receipt and printed by `theme list` — accepting one stores and displays a
// secret. Private repos use a local clone plus `theme add ./dir`.
export function classifySource(raw, { stat = statSync } = {}) {
  if (raw.startsWith('https://')) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(
        `theme add: sources are HTTPS URLs or local directories — got ${JSON.stringify(raw)}`
      );
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error(
        'theme add: credentials in the URL would be stored in the receipt and shown by `theme list` — use a credential-free HTTPS URL, or clone privately and add the local directory'
      );
    }
    return { kind: 'https', url: raw };
  }
  if ((/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw))
    || /^[^/\s:@]+@[^/\s:]+:/.test(raw)) {
    throw new Error(
      `theme add: sources are HTTPS URLs or local directories — got ${JSON.stringify(raw)}`
    );
  }
  const path = resolve(raw);
  let st;
  try {
    st = stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`theme add: no directory at ${path}`);
    throw error;
  }
  if (!st.isDirectory()) throw new Error(`theme add: ${path} is not a directory`);
  return { kind: 'local', path };
}

// Remote git diagnostics are untrusted terminal input. ANSI stripping alone
// leaves bare \r (git progress uses it), backspace and BEL live, any of
// which can rewrite the visible line — so after stripping ANSI, CR/LF both
// split lines and every remaining C0/C1 control is replaced (spec §4).
export function collapseStderr(text) {
  return stripVTControlCharacters(String(text))
    .split(/\r\n|\r|\n/)
    .map((line) => line.replaceAll(/\p{Cc}/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .join('; ');
}

// The defensive copy (spec §3). Validation runs only AFTER acquisition, so
// the copy itself must refuse what it cannot safely materialize. Directories
// are opened no-follow and traversed through their /proc fd identity, so a
// pathname swap cannot redirect a queued walk. A symlink, FIFO, socket or
// device is rejected by path, never opened, never recreated in staging.
// `.git` at any depth is excluded; git is never invoked on the source.
// Regular files are copied by abortable streaming because fs.copyFile/fs.cp
// accept no AbortSignal, and the wall clock must stop a stalled file.
export async function copySource(sourceDir, dest, { signal } = {}) {
  const sourceReal = await realpath(sourceDir);
  const destReal = await realpath(dest);
  if (destReal === sourceReal || destReal.startsWith(sourceReal + sep)) {
    throw new Error(
      `theme add: staging at ${destReal} lies inside the source ${sourceReal} — a self-copy would never terminate`
    );
  }
  await copyDirectory(sourceReal, sourceReal, destReal, signal);
}

async function copyDirectory(openPath, displayPath, to, signal) {
  let handle;
  try {
    try {
      handle = await openDirectory(openPath);
    } catch (error) {
      if (error.code === 'ELOOP' || error.code === 'ENOTDIR') {
        throw unsupportedEntry(displayPath);
      }
      throw error;
    }
    signal?.throwIfAborted();
    const bound = `/proc/self/fd/${handle.fd}`;
    const entries = (await readdir(bound, { withFileTypes: true }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name === '.git') continue;
      const src = join(bound, entry.name);
      const display = join(displayPath, entry.name);
      const out = join(to, entry.name);
      const st = await lstat(src);
      signal?.throwIfAborted();
      if (st.isDirectory()) {
        await mkdir(out);
        await copyDirectory(src, display, out, signal);
      } else if (st.isFile()) {
        await copyRegularFile(src, display, out, signal);
      } else {
        throw unsupportedEntry(display);
      }
    }
  } finally {
    await handle?.close();
  }
}

function unsupportedEntry(path) {
  return new Error(
    `theme add: ${path} is not a regular file or directory — the source must contain only files and directories`
  );
}

async function openDirectory(path) {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function copyRegularFile(src, display, out, signal) {
  let handle;
  try {
    try {
      handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ELOOP') throw unsupportedEntry(display);
      throw error;
    }
    if (!(await handle.stat()).isFile()) throw unsupportedEntry(display);
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(out, { flags: 'wx' }),
      { signal }
    );
  } catch (error) {
    throw signal?.aborted ? signal.reason : error;
  } finally {
    await handle?.close();
  }
}

// Git isolation (spec §3). The machine's own configuration must not shape
// what an untrusted clone does. Isolation is applied after caller input; the
// sole TLS seam is caFile -> GIT_SSL_CAINFO.
export function buildCloneEnv({ caFile } = {}, base = process.env) {
  const env = Object.fromEntries(
    Object.entries(base).filter(([key]) => !/^GIT_/i.test(key))
  );
  if (caFile !== undefined) env.GIT_SSL_CAINFO = caFile;
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_SYSTEM = devNull;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  env.GIT_ALLOW_PROTOCOL = 'https';
  return env;
}

const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024;

function boundedOutput() {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    add(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const keep = buffer.subarray(0, GIT_OUTPUT_LIMIT_BYTES - bytes);
      if (keep.length > 0) {
        chunks.push(keep);
        bytes += keep.length;
      }
      if (keep.length < buffer.length) truncated = true;
    },
    text() {
      const output = Buffer.concat(chunks, bytes).toString('utf8');
      return truncated
        ? `${output}\n[output truncated after ${GIT_OUTPUT_LIMIT_BYTES} bytes]`
        : output;
    },
  };
}

function runGit(args, { env, signal, what }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('git', args, {
      env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const stdout = boundedOutput();
    const stderr = boundedOutput();
    child.stdout.on('data', (chunk) => stdout.add(chunk));
    child.stderr.on('data', (chunk) => stderr.add(chunk));
    const onAbort = () => {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return rejectRun(signal.reason);
      if (code !== 0) {
        return rejectRun(new Error(`${what} failed: ${collapseStderr(stderr.text())}`));
      }
      resolveRun(stdout.text());
    });
    if (signal?.aborted) onAbort();
  });
}

export async function cloneSource(url, dest, { caFile, signal } = {}) {
  const env = buildCloneEnv({ caFile });
  await runGit(
    ['clone', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
      '--', url, dest],
    { env, signal, what: 'clone' }
  );
  // Read provenance before the orchestrator removes .git.
  const commit = (await runGit(
    ['-C', dest, 'rev-parse', 'HEAD'], { env, signal, what: 'rev-parse' }
  )).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`rev-parse failed: expected a 40-hex commit, got ${JSON.stringify(commit)}`);
  }
  return { commit };
}

export async function acquireSource(source, dest, {
  caFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  growthLimitBytes = DEFAULT_GROWTH_LIMIT_BYTES,
  pollMs = 1000,
} = {}) {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const timeoutReason = new Error(
    `theme add: acquisition exceeded the ${timeoutMs} ms wall clock`
  );
  const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
  let growthCheck = null;
  const checkGrowth = () => {
    if (growthCheck !== null) return growthCheck;
    growthCheck = (async () => {
      try {
        const bytes = await stagedBytes(dest, controller.signal);
        if (bytes > growthLimitBytes) {
          controller.abort(new Error(
            `theme add: staging grew past the ${growthLimitBytes}-byte bound (${bytes} bytes fetched)`
          ));
        }
      } catch (error) {
        controller.abort(error);
      } finally {
        growthCheck = null;
      }
    })();
    return growthCheck;
  };
  const poller = setInterval(() => { void checkGrowth(); }, pollMs);
  try {
    let provenance;
    if (source.kind === 'https') {
      const { commit } = await cloneSource(
        source.url, dest, { caFile, signal: controller.signal }
      );
      provenance = { kind: 'https', url: source.url, commit };
    } else {
      const path = await realpath(source.path);
      await copySource(path, dest, { signal: controller.signal });
      provenance = { kind: 'local', path };
    }
    await checkGrowth();
    if (performance.now() >= deadline) controller.abort(timeoutReason);
    controller.signal.throwIfAborted();
    return provenance;
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : error;
    if (!controller.signal.aborted) controller.abort(failure);
    throw failure;
  } finally {
    clearTimeout(timer);
    clearInterval(poller);
    await growthCheck;
  }
}

async function stagedBytes(root, signal) {
  let total = 0;
  const measureDirectory = async (openPath, displayPath) => {
    let handle;
    try {
      try {
        handle = await openDirectory(openPath);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      const bound = `/proc/self/fd/${handle.fd}`;
      const entries = await readdir(bound, { withFileTypes: true });
      for (const entry of entries) {
        signal?.throwIfAborted();
        const path = join(bound, entry.name);
        const display = join(displayPath, entry.name);
        let st;
        try {
          st = await lstat(path);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw new Error(
            `theme add: could not measure staging growth at ${display}: ${error.message}`,
            { cause: error }
          );
        }
        total += st.size;
        if (st.isDirectory()) await measureDirectory(path, display);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.message.startsWith('theme add: could not measure staging growth')) throw error;
      throw new Error(
        `theme add: could not measure staging growth at ${displayPath}: ${error.message}`,
        { cause: error }
      );
    } finally {
      await handle?.close();
    }
  };

  await measureDirectory(root, root);
  return total;
}
