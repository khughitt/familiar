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
const EXCLUDE = '.codex/config.toml';

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

const lstatIfPresent = (path) => {
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
const configText = (member) => `${MANAGED_HEADER}\n${selectionText(member)}`;

export async function planCodexProjectSync({ catalog, pack }) {
  const configs = [];
  const excludes = [];
  const manual = [];
  const missing = [];
  const seen = new Set();
  const seenExcludes = new Set();
  const conflicts = [];

  for (const pin of catalog.identities) {
    if (!pin.path) continue;
    const path = pinPath(pin.path);
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    if (!statSync(path).isDirectory()) throw new Error(`identity path is not a directory: ${path}`);

    const { remote, repoRoot } = await gitContext(path);
    const root = repoRoot ?? path;
    const target = join(root, EXCLUDE);
    if (seen.has(target)) continue;
    seen.add(target);
    const isTracked = repoRoot ? tracked(root) : false;
    const replaceEmptyMarker = !isTracked && assertConfigTarget(
      root, target, !repoRoot || !tracked(root, '.codex'),
    );

    const projectKey = projectKeyFor({ remote, repoRoot, cwd: path });
    const project = displayProject({ repoRoot, cwd: path });
    const identity = resolveIdentity({
      projectKey, project, remote, repoRoot, catalog, pack,
    });
    const wanted = selectionText(identity.member);

    if (isTracked) {
      manual.push({ path: target, setting: wanted });
      continue;
    }

    const current = readIfPresent(target);
    if (current !== null && !MANAGED_CONFIG.test(current)) {
      conflicts.push(target);
      continue;
    }
    configs.push({
      root,
      path: target,
      before: current,
      text: configText(identity.member),
      replaceEmptyMarker,
      gitBacked: Boolean(repoRoot),
    });

    if (repoRoot) {
      const path = excludePath(root);
      assertExcludeTarget(path);
      if (!seenExcludes.has(path)) excludes.push({ path });
      seenExcludes.add(path);
    }
  }

  if (conflicts.length) {
    throw new Error(`refusing unmanaged project config ${conflicts.join(', ')}`);
  }
  return { configs, excludes, manual, missing };
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
