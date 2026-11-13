import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, posix, relative } from 'node:path';
import { parse } from 'smol-toml';

export function scanCurrentSurfaces(root, trackedPaths) {
  // Art surfaces may live in the split-out repositories; engine roots are required.
  const tracked = new Set(trackedPaths);
  const excluded = (path) => ['README.md', 'AGENTS.md', 'CLAUDE.md'].includes(basename(path))
    || /^docs\/(?:specs|plans|notes|reports)\//.test(path)
    || /^\d{4}-\d{2}-\d{2}-/.test(basename(path));
  const declared = parse(readFileSync(join(root, 'identity.toml'), 'utf8')).documents?.references ?? [];
  assert.ok(Array.isArray(declared), 'documents.references must be an array');
  for (const path of declared) {
    assert.ok(typeof path === 'string' && path.endsWith('.md') && !path.includes('\\')
      && !posix.isAbsolute(path) && posix.normalize(path) === path
      && !path.split('/').includes('..') && !excluded(path),
    `invalid declared reference: ${JSON.stringify(path)}`);
  }
  const documents = new Set([
    ...trackedPaths.filter((path) => /^docs\/[^/]+\.md$/.test(path) && !excluded(path)),
    ...declared,
  ]);
  const currentSurfaces = [
    { path: 'README.md', splitAway: false },
    { path: 'docs/art/discovery.md', splitAway: true },
    { path: 'docs/art/lessons.md', splitAway: true },
    { path: 'AGENTS.md', splitAway: false },
    { path: 'skills/art-discovery/SKILL.md', splitAway: true },
    { path: 'themes/cats/theme.yaml', splitAway: true },
    { path: 'tools/art/theme/scaffold.js', splitAway: true },
    { path: 'src', splitAway: false },
    { path: 'bin', splitAway: false },
    { path: 'test', splitAway: false },
    ...[...documents].map((path) => ({ path, splitAway: false })),
  ];
  const oldRootLeaves = ['themes', 'preview', 'contact', 'pets'];
  const retired = new RegExp(
    `familiar (?:${oldRootLeaves.join('|')})\\b|tools/whoami\\.mjs|` +
    'familiar theme (?!list\\b|add\\b|remove\\b|validate\\b|show\\b|preview\\b|sheet\\b|--help\\b|<command>)',
    'u',
  );
  // Both agents' configuration is generated now, so a literal placeholder path in user-facing
  // Markdown is stale by construction -- as is any instruction to copy the deleted Codex hooks
  // fixture, which is what `familiar setup codex` replaced.
  const retiredLiteralSetup =
    /\/path\/to\/familiar\/bin\/familiar (?:hook|statusline)|integrations\/codex\/hooks\.json/u;
  const textExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.md', '.yaml', '.yml']);
  const failures = [];

  function inspect(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.isFile() && (
        textExtensions.has(extname(entry.name)) || (path === join(root, 'bin') && extname(entry.name) === '')
      )) {
        const name = relative(root, file);
        if (name === 'test/cli-help.test.js' || name === 'test/helpers/current-docs.js') continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
          if (retired.test(line) || (extname(name) === '.md' && retiredLiteralSetup.test(line))) {
            failures.push(`${name}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }

  for (const { path: surface, splitAway } of new Map(currentSurfaces.map((item) => [item.path, item])).values()) {
    const path = join(root, surface);
    if (declared.includes(surface) && (!existsSync(path) || !tracked.has(surface))) {
      failures.push(`${surface}: declared reference is missing or untracked`);
      continue;
    }
    if (!existsSync(path)) {
      if (!splitAway) failures.push(`${surface}: engine-owned surface is missing`);
      continue;
    }
    if (extname(path)) {
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (retired.test(line) || (extname(surface) === '.md' && retiredLiteralSetup.test(line))) {
          failures.push(`${surface}:${index + 1}: ${line.trim()}`);
        }
      });
    } else inspect(path);
  }
  return failures;
}
