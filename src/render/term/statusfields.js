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
// line does not merely lag, it can be killed repeatedly and never paint. The git call and the
// claim lookup below are the only subprocesses on this path, each is BOUNDED, and they stay
// that way.
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

// The claim lookup's own deadline, beside BRANCH_TIMEOUT_MS rather than borrowing it: the two
// commands differ, and so may their deadlines. `tasks claims` measured 4-6ms on a warm host, so
// this is a hang guard, not a budget. Worst case with both git attempts: 750ms of a 2s interval.
export const CLAIMS_TIMEOUT_MS = 250;

// THE TASK THIS SESSION HAS CLAIMED, as { id, others } or null. A Claude Code claim's `session`
// IS the session_id on stdin, so a live claim with that session is this session's task. One
// session may hold several: the latest started is shown and the rest are counted.
//
// `--json` EXPLICITLY: TASKS_FORMAT=pretty overrides the JSON default, and a pretty table is
// unparseable JSON here.
//
// NO `tasks` ON PATH IS A FACT ABOUT THE HOST, answered with no segment, like no claim. Anything
// else that leaves the segment off -- a timeout, a non-zero exit, JSON that does not parse or
// is not the shape below -- is a FAULT, and is said once through `warn` rather than painted.
export function claimedTask(sessionId, { env, warn = statuslineWarn } = {}) {
  if (!sessionId) return null;
  let stdout;
  try {
    stdout = execFileSync('tasks', ['claims', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: CLAIMS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      ...(env ? { env } : {}),
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    warn(error.code === 'ETIMEDOUT'
      ? `tasks claims: timed out after ${CLAIMS_TIMEOUT_MS}ms`
      : `tasks claims: exited ${error.status ?? error.signal ?? error.code}`);
    return null;
  }

  let claims;
  try {
    ({ claims } = JSON.parse(stdout));
  } catch (error) {
    warn(`tasks claims: unparseable JSON: ${error.message}`);
    return null;
  }
  if (!Array.isArray(claims) || !claims.every((c) => c !== null && typeof c === 'object')) {
    warn('tasks claims: unexpected JSON shape: want {claims: [{...}]}');
    return null;
  }

  // ONLY THIS SESSION'S ROWS ARE HELD TO THE SHAPE. The list spans every project's claim
  // store on the host; a malformed row some other session holds is that store's fault, and
  // failing on it would take every status line's segment down with it.
  const mine = claims
    .filter((c) => c.live === true && c.session === sessionId)
    .map((c) => ({ id: c.id, at: typeof c.started === 'string' ? Date.parse(c.started) : NaN }));
  if (!mine.every((c) => typeof c.id === 'string' && Number.isFinite(c.at))) {
    warn('tasks claims: unexpected JSON shape: want a string id and an RFC 3339 started');
    return null;
  }
  // By time, not by string: `.` sorts before `Z`, so fractional seconds would invert it.
  mine.sort((a, b) => b.at - a.at);
  return mine.length ? { id: mine[0].id, others: mine.length - 1 } : null;
}

// The same shape bin/familiar.js gives a visual fault: one line, prefixed, newlines flattened.
function statuslineWarn(message) {
  process.stderr.write(`familiar: statusline: ${message.replace(/[\r\n]+/g, ' ')}\n`);
}

export function readFields(payload, { git = gitBranch, claim = claimedTask } = {}) {
  const data = payload ?? {};
  const cwd = data.workspace?.current_dir ?? data.cwd ?? process.cwd();
  const pct = data.context_window?.used_percentage;

  return {
    project: basename(cwd),
    branch: git(cwd),
    claim: claim(data.session_id),
    model: data.model?.display_name ?? null,
    // ABSENT AND null ARE ONE CASE, and this is the line that makes them one. The docs state
    // used_percentage "may be null early in the session"; an existence check alone lets null
    // through, and null formatted naively is the fabricated 0% the spec forbids.
    usedPercent: typeof pct === 'number' && Number.isFinite(pct) ? pct : null,
  };
}
