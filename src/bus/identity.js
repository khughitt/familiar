import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fnv1a32 } from '../protocol/hash.js';
import { SLOT_COUNT } from 'familiar-theme';

const defaultExec = promisify(execFile);

// THE ONLY UNBOUNDED OPERATION IN THE HOOK PATH, AND IT MUST NOT BE.
//
// The error boundary in bin/familiar bounds EXCEPTIONS. It does not bound TIME.
// `git` is spawned on every single tool call, and `git rev-parse --show-toplevel`
// blocks indefinitely on a wedged network/sync mount, a hung credential helper,
// or an fsmonitor daemon that never answers. Reproduced with a `git` that sleeps
// 600s: the hook never returned. claude-code then kills it at its own 60s hook
// timeout, so EVERY tool call stalls a minute — the cosmetic layer degrading the
// tool it decorates, which is the one thing it may never do.
//
// 2s is ~100x the p99 of a warm `git rev-parse` (~5-20ms) and far below any
// timeout that could plausibly annoy a user, so it can only fire on a filesystem
// that is genuinely not answering.
//
// SIGKILL, not SIGTERM: the process we are giving up on is, by construction, one
// that is stuck in an uninterruptible or unresponsive state. A TERM it may never
// handle would leave us waiting on the very thing we timed out for.
const GIT_TIMEOUT_MS = 2_000;

// Reduce every URL form of one repo to one key: host/owner/name, lowercased,
// with scheme, credentials, port, and .git stripped. The remote is preferred
// over the path because it survives moving or re-cloning the repo.
export function normalizeRemote(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let rest = url.trim();

  const hadScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rest);
  rest = rest.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');   // scheme://
  rest = rest.replace(/^[^/@]+@/, '');                        // user[:token]@
  // A `:<digits>/` segment is only ever a port in URL form (scheme://host:port/...).
  // In scp-style shorthand (user@host:path) there is no port syntax at all — the
  // text after the colon is a path, so a numeric owner/org (host:1234/repo) must
  // NOT be mistaken for host:port.
  if (hadScheme) rest = rest.replace(/:(\d+)\//, '/');        // host:22/
  rest = rest.replace(/:/, '/');                              // scp-style host:owner/name
  rest = rest.replace(/\.git$/, '').replace(/\/+$/, '');

  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2 || !parts[0].includes('.')) return null;   // not a host
  return parts.join('/').toLowerCase();
}

// `git -C cwd rev-parse --show-toplevel` reports the PHYSICAL repo root (symlinks
// resolved), not whatever path — symlinked or not — the caller passed as cwd.
// This function passes that straight through. It never compares repoRoot to cwd,
// and never re-lexicalizes it: canonicalizing a *pin's* path to match against a
// physical repoRoot is a different module's job (identities.yaml matching).
export async function gitContext(cwd, { exec = defaultExec, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const run = async (args) => {
    const { stdout } = await exec('git', ['-C', cwd, ...args], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    const value = String(stdout).trim();
    return value === '' ? null : value;
  };

  // A TIMEOUT IS NOT AN ANSWER, and it must not be mistaken for one. Both catches
  // below exist to swallow a git that says "no" — not a git that says nothing. If
  // a timeout fell through to `repoRoot: null`, a wedged mount would silently
  // re-key the project to its cwd, hash it to a DIFFERENT slot, and hand the user
  // a different cat in a different colour for the same repo — a cosmetic layer
  // lying about identity because a disk was slow. Let it out: the boundary in
  // bin/familiar turns it into one stderr line and exit 0, which is the honest
  // outcome and a bounded one.
  const timedOut = (error) => error?.killed === true || error?.signal === 'SIGKILL';
  const rethrowIfTimeout = (error) => {
    if (!timedOut(error)) return;
    throw new Error(
      `git timed out after ${timeoutMs}ms in ${cwd} — the filesystem or a git helper is not responding`
    );
  };

  let repoRoot = null;
  try {
    repoRoot = await run(['rev-parse', '--show-toplevel']);
  } catch (error) {
    rethrowIfTimeout(error);
    // Not a repo (or git is absent). The cwd is then the identity; say so by
    // reporting absence rather than fabricating a root.
    return { remote: null, repoRoot: null };
  }

  let remote = null;
  try {
    remote = normalizeRemote(await run(['config', '--get', 'remote.origin.url']));
  } catch (error) {
    rethrowIfTimeout(error);
    remote = null;   // a repo with no origin is normal, not an error
  }

  return { remote, repoRoot };
}

// THE canonical identity. This — and only this — is what gets hashed.
// A repo with no remote changes identity if you move it: acceptable,
// documented, and fixed by adding a remote.
export function projectKeyFor({ remote, repoRoot, cwd }) {
  return remote ?? repoRoot ?? cwd;
}

// A LABEL, not an identifier. Basenames collide; never key on this.
export function displayProject({ repoRoot, cwd }) {
  return basename(repoRoot ?? cwd);
}

export function autoSlot(projectKey) {
  return fnv1a32(projectKey) % SLOT_COUNT;
}
