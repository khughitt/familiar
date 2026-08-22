import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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

function tracked(root) {
  const result = git(root, ['ls-files', '--error-unmatch', '--', EXCLUDE]);
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

const withExclude = (text) => {
  if (text.split(/\r?\n/).includes(EXCLUDE)) return text;
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${EXCLUDE}\n`;
};

const selectionText = (member) => `[tui]\npet = "custom:familiar-${member}"\n`;
const configText = (member) => `${MANAGED_HEADER}\n${selectionText(member)}`;

export async function planCodexProjectSync({ catalog, pack }) {
  const configs = [];
  const excludes = [];
  const manual = [];
  const missing = [];
  const seen = new Set();
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

    const projectKey = projectKeyFor({ remote, repoRoot, cwd: path });
    const project = displayProject({ repoRoot, cwd: path });
    const identity = resolveIdentity({
      projectKey, project, remote, repoRoot, catalog, pack,
    });
    const wanted = selectionText(identity.member);

    if (repoRoot && tracked(root)) {
      manual.push({ path: target, setting: wanted });
      continue;
    }

    const current = readIfPresent(target);
    if (current !== null && !MANAGED_CONFIG.test(current)) {
      conflicts.push(target);
      continue;
    }
    configs.push({ path: target, text: configText(identity.member) });

    if (repoRoot) {
      const path = excludePath(root);
      const currentExclude = readIfPresent(path) ?? '';
      const text = withExclude(currentExclude);
      if (text !== currentExclude) excludes.push({ path, text });
    }
  }

  if (conflicts.length) {
    throw new Error(`refusing unmanaged project config ${conflicts.join(', ')}`);
  }
  return { configs, excludes, manual, missing };
}

export function applyCodexProjectSync(plan) {
  for (const { path, text } of plan.configs) {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomicSync(path, text);
  }
  for (const { path, text } of plan.excludes) {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomicSync(path, text);
  }
}
