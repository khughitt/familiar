import { spawn } from 'node:child_process';
import { constants, statSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { LIMITS, packEntryRole, parseThemePack } from 'familiar-theme';
import { changedEntry, copyRegularFile, unsupportedEntry } from './copy-regular-file.js';

export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_GROWTH_LIMIT_BYTES = 4 * LIMITS.MAX_TOTAL_BYTES;

// A run directory holds the acquired pack at <run>/pack. A clone first lands
// at <run>/clone and is copied from there, so both transports promote exactly
// the pack content the gate validated (spec 2026-10-14 §3).
export const PACK_DIR_NAME = 'pack';
export const CLONE_DIR_NAME = 'clone';

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
// the copy itself must refuse what it cannot safely materialize. On Linux,
// directories are opened no-follow and traversed through their /proc fd
// identity, so a pathname swap cannot redirect a queued walk. On Darwin,
// traversal uses the verified pathname with parent identity checks; a hostile
// writer can still swap a directory away and back between those checks, the
// accepted Darwin race ceiling (spec §§5, 12). Static symlinks, FIFOs, sockets
// and devices are rejected by lstat before open; a raced file replacement is
// opened no-follow/nonblocking and rejected through the handle.
// Only pack content is copied (spec 2026-10-14 §3): `theme.yaml` is staged first
// and parsed from the staged bytes, then each entry's `packEntryRole` decides.
// `outside` entries are skipped by name and never `lstat`ed. `.git` at any depth
// is excluded, and git is never invoked on the source.
// Regular files are copied by abortable streaming because fs.copyFile/fs.cp
// accept no AbortSignal, and the wall clock must stop a stalled file.
function notADirectory(path) {
  return new Error(`theme add: ${path} lies on a member's asset-root but is not a directory`);
}

function descriptorTooLarge(path, size) {
  return new Error(
    `theme add: ${path} is ${size} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`
  );
}

// The selection comes from the STAGED descriptor (spec §3): the bytes that
// choose what is copied are the bytes the gate validates. The walk never
// touches the root theme.yaml again, so this copy is the only one.
// Bounds are checked on the STAGED file before it is read: the source check
// alone cannot bound it, because a source can grow while it streams. Staging is
// written only by this installer under the lock (spec §3), so a stat of the
// completed copy is sufficient.
async function stageDescriptor(traversal, task, signal, copyFile) {
  const src = join(traversal, 'theme.yaml');
  const display = join(task.displayPath, 'theme.yaml');
  const out = join(task.to, 'theme.yaml');
  let st;
  try {
    st = await lstat(src);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`theme add: ${task.displayPath} has no theme.yaml`);
    throw error;
  }
  if (!st.isFile()) throw unsupportedEntry(display);
  if (st.size > LIMITS.MAX_DESCRIPTOR_BYTES) throw descriptorTooLarge(display, st.size);
  await copyFile(src, display, out, signal, { dev: st.dev, ino: st.ino });
  const staged = await lstat(out);
  if (staged.size > LIMITS.MAX_DESCRIPTOR_BYTES) throw descriptorTooLarge(display, staged.size);
  const bytes = await readFile(out);
  return parseThemePack(bytes.toString('utf8'), task.to, { descriptorLabel: 'theme.yaml' });
}

export async function copySource(sourceDir, dest, {
  signal,
  platform = process.platform,
  afterDirectoryRead = () => {},
  copyFile = copyRegularFile,
} = {}) {
  const sourceReal = await realpath(sourceDir);
  const destReal = await realpath(dest);
  if (destReal === sourceReal || destReal.startsWith(sourceReal + sep)) {
    throw new Error(
      `theme add: staging at ${destReal} lies inside the source ${sourceReal} — a self-copy would never terminate`
    );
  }
  const root = await lstat(sourceReal);
  const pending = [{
    openPath: sourceReal, displayPath: sourceReal, to: destReal,
    rel: '', dev: root.dev, ino: root.ino,
  }];
  let pack;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const task = pending[cursor];
    let handle;
    try {
      handle = await openVerifiedDirectory(task);
      signal?.throwIfAborted();
      const traversal = traversalRoot(task, handle, platform);
      if (platform === 'darwin') await verifyPathIdentity(task);
      if (task.rel === '') pack = await stageDescriptor(traversal, task, signal, copyFile);
      const entries = (await readdir(traversal, { withFileTypes: true }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (entry.name === '.git') continue;
        if (task.rel === '' && entry.name === 'theme.yaml') continue;
        const rel = task.rel === '' ? entry.name : `${task.rel}/${entry.name}`;
        const role = packEntryRole(pack, rel);
        if (role === 'outside') continue;
        const src = join(traversal, entry.name);
        const openPath = join(task.openPath, entry.name);
        const display = join(task.displayPath, entry.name);
        const out = join(task.to, entry.name);
        const st = await lstat(src);
        signal?.throwIfAborted();
        if (st.isDirectory()) {
          await mkdir(out);
          pending.push({
            openPath, displayPath: display, to: out, rel, dev: st.dev, ino: st.ino,
          });
        } else if (role === 'ancestor' && st.isFile()) {
          throw notADirectory(display);
        } else if (st.isFile()) {
          await copyFile(src, display, out, signal, { dev: st.dev, ino: st.ino });
        } else {
          throw unsupportedEntry(display);
        }
      }
      afterDirectoryRead(task);
      if (platform === 'darwin') await verifyPathIdentity(task);
    } finally {
      await handle?.close();
    }
  }
}

function traversalRoot(task, handle, platform) {
  if (platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  if (platform === 'darwin') return task.openPath;
  throw new Error(`theme add: unsupported platform ${JSON.stringify(platform)}`);
}

async function verifyPathIdentity(task) {
  let st;
  try {
    st = await lstat(task.openPath);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) {
      throw changedEntry(task.displayPath);
    }
    throw error;
  }
  if (!st.isDirectory() || st.dev !== task.dev || st.ino !== task.ino) {
    throw changedEntry(task.displayPath);
  }
}

async function openVerifiedDirectory(task) {
  let handle;
  try {
    try {
      handle = await openDirectory(task.openPath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR') {
        throw changedEntry(task.displayPath);
      }
      throw error;
    }
    const st = await handle.stat();
    if (st.dev !== task.dev || st.ino !== task.ino) throw changedEntry(task.displayPath);
    return handle;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function openDirectory(path) {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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
  platform = process.platform,
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
        const bytes = await stagedBytes(dest, controller.signal, { platform });
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
    const packDir = join(dest, PACK_DIR_NAME);
    let provenance;
    if (source.kind === 'https') {
      const cloneDir = join(dest, CLONE_DIR_NAME);
      const { commit } = await cloneSource(
        source.url, cloneDir, { caFile, signal: controller.signal }
      );
      await mkdir(packDir);
      await copySource(cloneDir, packDir, { signal: controller.signal, platform });
      provenance = { kind: 'https', url: source.url, commit };
    } else {
      const path = await realpath(source.path);
      await mkdir(packDir);
      await copySource(path, packDir, { signal: controller.signal, platform });
      provenance = { kind: 'local', path };
    }
    await checkGrowth();
    if (performance.now() >= deadline) controller.abort(timeoutReason);
    controller.signal.throwIfAborted();
    return { provenance, packDir };
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

async function stagedBytes(root, signal, { platform = process.platform } = {}) {
  let total = 0;
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error.code === 'ENOENT') return total;
    throw new Error(
      `theme add: could not measure staging growth at ${root}: ${error.message}`,
      { cause: error }
    );
  }
  const pending = [{
    openPath: root, displayPath: root, dev: rootStat.dev, ino: rootStat.ino,
  }];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    signal?.throwIfAborted();
    const task = pending[cursor];
    let handle;
    try {
      handle = await openVerifiedDirectory(task);
      const traversal = traversalRoot(task, handle, platform);
      if (platform === 'darwin') await verifyPathIdentity(task);
      const entries = await readdir(traversal, { withFileTypes: true });
      for (const entry of entries) {
        signal?.throwIfAborted();
        const path = join(traversal, entry.name);
        const openPath = join(task.openPath, entry.name);
        const display = join(task.displayPath, entry.name);
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
        if (st.isDirectory()) {
          pending.push({ openPath, displayPath: display, dev: st.dev, ino: st.ino });
        }
      }
      if (platform === 'darwin') await verifyPathIdentity(task);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.message.startsWith('theme add: could not measure staging growth')) throw error;
      throw new Error(
        `theme add: could not measure staging growth at ${task.displayPath}: ${error.message}`,
        { cause: error }
      );
    } finally {
      await handle?.close();
    }
  }
  return total;
}
