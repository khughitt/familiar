import { basename, dirname, isAbsolute } from 'node:path';
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

// Git discovery for one hook: where this checkout is (`repoRoot`), which repository it belongs
// to (`repositoryRoot`), and its effective origin. Both roots are PHYSICAL (symlinks resolved)
// exactly as Git reports them; nothing here re-lexicalizes or compares them to cwd.
// Canonicalizing a *pin's* path to match against them is pins.js's job.
//
// THE ANCHOR comes from Git's own relationship, never from the filesystem around the checkout:
// a worktree stored outside its main checkout, or reached through a symlink, still belongs to
// it, and a nested unrelated repository never does. A main checkout (Git and common
// directories equal, separated metadata included) is its own anchor. A linked worktree's
// candidate is its common directory's parent when that directory is named `.git`, else the
// common directory itself, verified by ONE probe: `false` then the primary's root, or -- for a
// bare repository, which has no checkout -- `true` then Git's exit 128 from --show-toplevel.
// Nothing lists sibling worktrees: an unreachable sibling must not widen what a hook touches.
//
// Separated metadata named `.git` outside its checkout is indistinguishable from a repository
// at its parent unless `core.worktree` declares the real primary; that declaration is a setup
// prerequisite, not something discovered here.
//
// ONE DEADLINE for every spawn: each gets what remains of it, floored, never enlarged. A main
// checkout takes two spawns and a linked one three; output that cannot be framed as three
// lines (a path containing a newline) asks for each path on its own, three more.
export async function gitContext(cwd, {
  exec = defaultExec,
  timeoutMs = GIT_TIMEOUT_MS,
  now = () => performance.now(),
} = {}) {
  const deadline = now() + timeoutMs;
  const timeout = () => Object.assign(
    new Error(`git timed out after ${timeoutMs}ms in ${cwd} — the filesystem or a git helper is not responding`),
    { code: 'FAMILIAR_GIT_TIMEOUT' },
  );

  // A TIMEOUT IS NOT AN ANSWER, and it must not be mistaken for one. If a timeout fell
  // through to `repoRoot: null`, a wedged mount would silently re-key the project to its cwd,
  // hash it to a DIFFERENT slot, and hand the user a different cat in a different colour for
  // the same repo — a cosmetic layer lying about identity because a disk was slow. Every
  // timeout leaves as this one error; the boundary in bin/familiar turns it into one stderr
  // line and exit 0, which is the honest outcome and a bounded one.
  const timedOut = (error) => error?.code === 'FAMILIAR_GIT_TIMEOUT'
    || error?.killed === true || error?.signal === 'SIGKILL';
  const run = async (at, args) => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) throw timeout();
    try {
      return await exec('git', ['-C', at, ...args], { timeout: remaining, killSignal: 'SIGKILL' });
    } catch (error) {
      if (timedOut(error)) throw timeout();
      throw error;
    }
  };

  // A path may end in a newline or a space: remove the final LF and nothing else.
  const withoutFinalLF = (text) => {
    const s = String(text);
    if (!s.endsWith('\n')) throw new Error(`git returned malformed path output in ${cwd}`);
    return s.slice(0, -1);
  };
  const absolutePath = (value) => {
    if (value === '' || !isAbsolute(value)) {
      throw new Error(`git returned a non-absolute path in ${cwd}: ${JSON.stringify(value)}`);
    }
    return value;
  };

  let batch;
  try {
    batch = await run(cwd, ['rev-parse', '--path-format=absolute',
      '--show-toplevel', '--git-dir', '--git-common-dir']);
  } catch (error) {
    if (timedOut(error)) throw error;
    // Not a worktree (or git is absent). The cwd is then the identity; say so by reporting
    // absence rather than fabricating a root.
    return { remote: null, repoRoot: null, repositoryRoot: null };
  }

  let paths = withoutFinalLF(batch.stdout).split('\n');
  if (paths.length !== 3) {
    // Never guess where one path ends: ask for each on its own.
    const one = async (option) => withoutFinalLF(
      (await run(cwd, ['rev-parse', '--path-format=absolute', option])).stdout);
    paths = [await one('--show-toplevel'), await one('--git-dir'), await one('--git-common-dir')];
  }
  const [repoRoot, gitDir, commonDir] = paths.map(absolutePath);

  let repositoryRoot = repoRoot;
  if (gitDir !== commonDir) {
    const candidate = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
    try {
      const { stdout } = await run(candidate, ['rev-parse', '--is-bare-repository', '--show-toplevel']);
      const text = String(stdout);
      if (!text.startsWith('false\n')) throw new Error(`unexpected probe output ${JSON.stringify(text)}`);
      repositoryRoot = absolutePath(withoutFinalLF(text.slice('false\n'.length)));
    } catch (error) {
      if (timedOut(error)) throw error;
      const bare = error.code === 128 && !error.killed && error.signal == null
        && error.stdout === 'true\n';
      if (!bare) {
        throw new Error(
          `cannot establish the primary checkout of ${repoRoot} from ${candidate} (${error.message.trim()}); `
          + 'if its Git metadata is stored separately, declare the real main checkout with core.worktree',
        );
      }
      repositoryRoot = commonDir;
    }
  }

  let remote = null;
  try {
    const { stdout } = await run(cwd, ['config', '--get', 'remote.origin.url']);
    remote = normalizeRemote(String(stdout).trim());
  } catch (error) {
    // Exit 1 is "no origin": a repo with no origin is normal, not an error.
    if (error.code !== 1 || error.signal != null) throw error;
  }

  return { remote, repoRoot, repositoryRoot };
}

// THE canonical identity. This — and only this — is what gets hashed.
// A repo with no remote changes identity if you move it: acceptable,
// documented, and fixed by adding a remote.
//
// The repository anchor, not the checkout: a remote-less repository and all of its worktrees
// share one key, and so one automatic familiar, while each keeps its own label.
export function projectKeyFor({ remote, repositoryRoot, cwd }) {
  return remote ?? repositoryRoot ?? cwd;
}

// A LABEL, not an identifier. Basenames collide; never key on this.
export function displayProject({ repoRoot, cwd }) {
  return basename(repoRoot ?? cwd);
}

export function autoSlot(projectKey) {
  return fnv1a32(projectKey) % SLOT_COUNT;
}
