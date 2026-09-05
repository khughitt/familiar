import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gitContext, projectKeyFor, displayProject } from '../bus/identity.js';
import { resolveIdentity } from '../bus/resolve.js';
import { writeAtomicSync } from './atomic.js';

const MANAGED_HEADER = '# Managed by Familiar. Run `familiar install pets --sync-projects` to update.';
const MANAGED_CONFIG = new RegExp(
  `^${MANAGED_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n` +
  '\\[tui\\]\\npet = "custom:familiar-[a-z0-9-]+"\\n$',
);
export const EXCLUDE = '.codex/config.toml';

const codexHome = () => resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));

const pinPath = (path) => path.startsWith('~/')
  ? resolve(homedir(), path.slice(2))
  : resolve(path);

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  return result;
}

function tracked(root, path = EXCLUDE) {
  const result = git(root, ['ls-files', '--error-unmatch', '--', path]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git ls-files failed in ${root}: ${result.stderr.trim()}`);
}

function excludePath(root) {
  const result = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (result.status !== 0) {
    throw new Error(`git rev-parse failed in ${root}: ${result.stderr.trim()}`);
  }
  return resolve(root, result.stdout.trim());
}

const readIfPresent = (path) => existsSync(path) ? readFileSync(path, 'utf8') : null;

export const lstatIfPresent = (path) => {
  try { return lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

function assertConfigTarget(root, target, allowEmptyMarker = false) {
  const configDir = join(root, '.codex');
  const dir = lstatIfPresent(configDir);
  if (dir?.isSymbolicLink()) throw new Error(`refusing symlinked Codex config directory ${configDir}`);
  const emptyMarker = Boolean(dir?.isFile() && dir.size === 0);
  if (dir && !dir.isDirectory() && !(allowEmptyMarker && emptyMarker)) {
    throw new Error(`Codex config path is not a directory: ${configDir}`);
  }

  if (!emptyMarker) {
    const file = lstatIfPresent(target);
    if (file?.isSymbolicLink()) throw new Error(`refusing symlinked project config ${target}`);
    if (file && !file.isFile()) throw new Error(`Codex project config is not a regular file: ${target}`);
  }
  return emptyMarker;
}

function assertExcludeTarget(path) {
  const file = lstatIfPresent(path);
  if (file?.isSymbolicLink()) throw new Error(`refusing symlinked Git exclude file ${path}`);
  if (file && !file.isFile()) throw new Error(`Git exclude path is not a regular file: ${path}`);
}

const selectionText = (member) => `[tui]\npet = "custom:familiar-${member}"\n`;
export const configText = (member) => `${MANAGED_HEADER}\n${selectionText(member)}`;

// ONE TARGET, ONE BLAST RADIUS. The hook calls this directly, so a refusal here
// must describe THIS repository and nothing else. `planCodexProjectSync` keeps
// its machine-wide behaviour by calling this in a loop -- an explicit,
// user-invoked, foreground command is the right place for that; a hook is not.
//
// THE CATALOG IS NOT NARROWED. `resolveIdentity` matches pins by remote, then
// path, then project name, over the WHOLE catalog. Passing only the pin that
// matched this path would silently change which pin wins.
//
// A CONFLICT IS RETURNED, NOT THROWN, and `target` comes back on every outcome
// that got as far as a repository root. Both exist for the caller's benefit: the
// machine-wide command aggregates conflicts and must deduplicate targets across
// ALL outcomes -- a repository that is both pinned and `cwd` was reported once
// before this split, and must stay reported once.
export async function planCodexProjectForPath({
  path, pinned, catalog, pack, member: givenMember = null,
}) {
  if (!existsSync(path)) return { missing: path };
  if (!statSync(path).isDirectory()) throw new Error(`identity path is not a directory: ${path}`);

  const { remote, repoRoot } = await gitContext(path);
  // A repository is what makes the current directory a PROJECT. Without this, running the
  // command from a home directory would aim at `~/.codex/config.toml` -- the user-wide Codex
  // config -- and rewrite it as a Familiar-managed file. A pinned path stays exempt: pinning
  // is an explicit choice about a specific directory.
  if (!pinned && !repoRoot) return { skip: { path, reason: 'not a Git repository' } };

  const root = repoRoot ?? path;
  if (!pinned && join(root, EXCLUDE) === join(codexHome(), 'config.toml')) {
    return { skip: { path: root, reason: 'its Codex config is the user-wide one' } };
  }

  const target = join(root, EXCLUDE);
  const isTracked = repoRoot ? tracked(root) : false;
  const replaceEmptyMarker = !isTracked && assertConfigTarget(
    root, target, !repoRoot || !tracked(root, '.codex'),
  );

  // A SUPPLIED MEMBER IS THE ANSWER, NOT A HINT. The hook has already resolved
  // identity for this session and has already checked THAT member's assets. If
  // this function resolved its own, the gate and the write could name different
  // members -- verifying one pet's art and selecting another, which is the exact
  // broken selection the gate exists to prevent.
  const member = givenMember ?? resolveIdentity({
    projectKey: projectKeyFor({ remote, repoRoot, cwd: path }),
    project: displayProject({ repoRoot, cwd: path }),
    remote, repoRoot, catalog, pack,
  }).member;

  if (isTracked) {
    return { target, member, manual: { path: target, setting: selectionText(member) } };
  }

  const current = readIfPresent(target);
  if (current !== null && !MANAGED_CONFIG.test(current)) {
    return { target, member, conflict: target };
  }

  let exclude = null;
  if (repoRoot) {
    const excludeTarget = excludePath(root);
    assertExcludeTarget(excludeTarget);
    exclude = { path: excludeTarget };
  }

  return {
    target,
    member,
    config: {
      root,
      path: target,
      before: current,
      text: configText(member),
      replaceEmptyMarker,
      gitBacked: Boolean(repoRoot),
    },
    exclude,
  };
}

// The identity pins are the CONFIGURED targets; `cwd` is the one the user is standing in.
// Syncing pins alone makes `--sync-projects` a no-op on a fresh machine -- `identities.yaml`
// does not exist until someone pins a path, so the documented way to select a pet does
// nothing on exactly the machines that have never selected one. The current project is
// therefore a target too, and takes the same route as a pin: same refusals, same conflict
// rules, same exclusion. Pins are processed first, so an explicit pin still wins.
export async function planCodexProjectSync({ catalog, pack, cwd = null }) {
  const configs = [];
  const excludes = [];
  const manual = [];
  const missing = [];
  const seen = new Set();
  const seenExcludes = new Set();
  const conflicts = [];
  const targets = [];
  for (const pin of catalog.identities) {
    if (pin.path) targets.push({ path: pinPath(pin.path), pinned: true });
  }
  if (cwd !== null) targets.push({ path: resolve(cwd), pinned: false });
  let unpinnedSkip = null;

  for (const { path, pinned } of targets) {
    const planned = await planCodexProjectForPath({ path, pinned, catalog, pack });

    if (planned.missing) { missing.push(planned.missing); continue; }
    if (planned.skip) { if (!pinned) unpinnedSkip = planned.skip; continue; }

    // DEDUPE BEFORE DISPATCH, not after. A repository that is both pinned and
    // the current directory arrives twice, and every outcome -- managed,
    // tracked, conflicting -- must be reported exactly once.
    if (seen.has(planned.target)) continue;
    seen.add(planned.target);

    if (planned.conflict) { conflicts.push(planned.conflict); continue; }
    if (planned.manual) { manual.push(planned.manual); continue; }

    configs.push(planned.config);
    if (planned.exclude && !seenExcludes.has(planned.exclude.path)) {
      seenExcludes.add(planned.exclude.path);
      excludes.push(planned.exclude);
    }
  }

  if (conflicts.length) {
    throw new Error(`refusing unmanaged project config ${conflicts.join(', ')}`);
  }
  return { configs, excludes, manual, missing, unpinnedSkip };
}

export function applyCodexProjectSync(plan) {
  const assertUnchanged = ({ root, path, before, replaceEmptyMarker, gitBacked }) => {
    if (gitBacked && (tracked(root) || (replaceEmptyMarker && tracked(root, '.codex')))) {
      throw new Error(`project config changed after preflight: ${path}`);
    }
    const currentEmptyMarker = assertConfigTarget(root, path, true);
    if (currentEmptyMarker !== replaceEmptyMarker) {
      throw new Error(`project config changed after preflight: ${path}`);
    }
    if (readIfPresent(path) !== before) {
      throw new Error(`project config changed after preflight: ${path}`);
    }
  };
  for (const config of plan.configs) assertUnchanged(config);

  for (const { path } of plan.excludes) {
    assertExcludeTarget(path);
    mkdirSync(dirname(path), { recursive: true });
    const current = readIfPresent(path) ?? '';
    if (!current.split(/\r?\n/).includes(EXCLUDE)) {
      appendFileSync(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}${EXCLUDE}\n`);
    }
  }

  for (const config of plan.configs) {
    assertUnchanged(config);
    const { path, text } = config;
    if (config.replaceEmptyMarker) unlinkSync(dirname(path));
    mkdirSync(dirname(path), { recursive: true });
    writeAtomicSync(path, text);
  }
}
