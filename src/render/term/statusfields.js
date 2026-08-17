// THE ONE IMPURE PART OF THE HUD, kept in its own file so hud.js can stay a pure function of
// two plain objects and be swept across every state, tone and theme height with no filesystem
// and no git.
//
// IT TAKES A PARSED PAYLOAD, NOT A STRING. bin/familiar:238 already JSON.parses this same
// stdin to get the session id, and throws on malformed input long before any HUD code runs.
// A second forgiving parse in here would be dead code wearing the costume of error handling.
// Malformed stdin stays what it already is: a throw, caught by bin/familiar's boundary.
//
// IT IS ALSO THE FILE TO WATCH FOR LATENCY. With refreshInterval set, the docs say an update
// arriving while the script is still running CANCELS the in-flight script -- so a slow status
// line does not merely lag, it can be killed repeatedly and never paint. The git call below
// is the only subprocess on this path, it is BOUNDED, and it stays that way.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

// NOT NAMED GIT_TIMEOUT_MS. src/bus/identity.js already owns a constant by that name, at
// 2000ms, for the HOOK path -- and two same-named constants with different values in two
// files is the mirror-with-nothing-enforcing-it defect this codebase keeps deleting. The
// names differ because the DEADLINES differ: identity.js is bounded by claude-code's 60s hook
// timeout, while this is bounded by a 2s refresh interval that CANCELS an in-flight script.
// Two of these (symbolic-ref, then rev-parse) must still leave most of that interval unspent.
export const BRANCH_TIMEOUT_MS = 250;

const run = (cwd, args, env) => execFileSync(
  'git',
  ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: BRANCH_TIMEOUT_MS,
    // SIGKILL, not SIGTERM -- the same reasoning identity.js:23 records: the process we are
    // giving up on is by construction stuck or unresponsive, and a TERM it may never handle
    // would leave us waiting on the very thing we timed out for.
    killSignal: 'SIGKILL',
    ...(env ? { env } : {}),
  },
).trim();

// NOT A REPOSITORY IS NOT A FAILURE, it is a fact about the directory -- and a detached HEAD
// is another, and a git that hung past its timeout is a third. All three are answered with
// what is true (a branch, a sha, or nothing) rather than with an error the status line has no
// way to show.
export function gitBranch(cwd, { env } = {}) {
  try {
    return run(cwd, ['symbolic-ref', '--short', 'HEAD'], env) || null;
  } catch {
    try {
      return run(cwd, ['rev-parse', '--short', 'HEAD'], env) || null;
    } catch {
      return null;
    }
  }
}

export function readFields(payload, { git = gitBranch } = {}) {
  const data = payload ?? {};
  const cwd = data.workspace?.current_dir ?? data.cwd ?? process.cwd();
  const pct = data.context_window?.used_percentage;

  return {
    project: basename(cwd),
    branch: git(cwd),
    model: data.model?.display_name ?? null,
    // ABSENT AND null ARE ONE CASE, and this is the line that makes them one. The docs state
    // used_percentage "may be null early in the session"; an existence check alone lets null
    // through, and null formatted naively is the fabricated 0% the spec forbids.
    usedPercent: typeof pct === 'number' && Number.isFinite(pct) ? pct : null,
  };
}
