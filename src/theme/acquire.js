import { spawn } from 'node:child_process';
import {
  createReadStream, createWriteStream, lstatSync, mkdirSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
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
// the copy itself must refuse what it cannot safely materialize: it walks
// with lstat and never dereferences — a symlink, FIFO, socket or device is
// rejected by path, never opened, never recreated in staging. `.git` at any
// depth is excluded; git is never invoked on the source. Regular files are
// copied by abortable streaming because fs.copyFile/fs.cp accept no
// AbortSignal, and the wall clock must be able to stop a stalled file.
export async function copySource(sourceDir, dest, { signal } = {}) {
  const sourceReal = realpathSync(sourceDir);
  const destReal = realpathSync(dest);
  if (destReal === sourceReal || destReal.startsWith(sourceReal + sep)) {
    throw new Error(
      `theme add: staging at ${destReal} lies inside the source ${sourceReal} — a self-copy would never terminate`
    );
  }
  await copyTree(sourceReal, destReal, signal);
}

async function copyTree(from, to, signal) {
  const entries = readdirSync(from, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const src = join(from, entry.name);
    const out = join(to, entry.name);
    const st = lstatSync(src);
    if (st.isDirectory()) {
      mkdirSync(out);
      await copyTree(src, out, signal);
    } else if (st.isFile()) {
      try {
        await pipeline(createReadStream(src), createWriteStream(out, { flags: 'wx' }), { signal });
      } catch (error) {
        throw signal?.aborted ? signal.reason : error;
      }
    } else {
      throw new Error(
        `theme add: ${src} is not a regular file or directory — the source must contain only files and directories`
      );
    }
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

function runGit(args, { env, signal, what }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return rejectRun(signal.reason);
      if (code !== 0) {
        return rejectRun(new Error(`${what} failed: ${collapseStderr(stderr)}`));
      }
      resolveRun(stdout);
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
  const checkGrowth = () => {
    try {
      const bytes = stagedBytes(dest);
      if (bytes > growthLimitBytes) {
        controller.abort(new Error(
          `theme add: staging grew past the ${growthLimitBytes}-byte bound (${bytes} bytes fetched)`
        ));
      }
    } catch (error) {
      controller.abort(error);
    }
  };
  const poller = setInterval(checkGrowth, pollMs);
  try {
    let provenance;
    if (source.kind === 'https') {
      const { commit } = await cloneSource(
        source.url, dest, { caFile, signal: controller.signal }
      );
      provenance = { kind: 'https', url: source.url, commit };
    } else {
      const path = realpathSync(source.path);
      await copySource(path, dest, { signal: controller.signal });
      provenance = { kind: 'local', path };
    }
    checkGrowth();
    if (performance.now() >= deadline) controller.abort(timeoutReason);
    controller.signal.throwIfAborted();
    return provenance;
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    clearInterval(poller);
  }
}

function stagedBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return total;
    throw new Error(
      `theme add: could not measure staging growth at ${dir}: ${error.message}`,
      { cause: error }
    );
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let st;
    try {
      st = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(
        `theme add: could not measure staging growth at ${path}: ${error.message}`,
        { cause: error }
      );
    }
    total += st.size;
    if (st.isDirectory()) total += stagedBytes(path);
  }
  return total;
}
