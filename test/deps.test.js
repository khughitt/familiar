import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { missingDependencies, requireDependencies } from '../src/deps.js';

const manifest = JSON.stringify({ dependencies: { yaml: '^2.4.0', 'jsonc-parser': '3.3.1' } });
const fixture = (installed) => ({
  root: '/project',
  read: () => manifest,
  exists: (path) => installed.some((name) => path === `/project/node_modules/${name}`),
});

test('missingDependencies: every declared dependency without a node_modules entry', () => {
  assert.deepEqual(missingDependencies(fixture(['yaml'])), ['jsonc-parser']);
  assert.deepEqual(missingDependencies(fixture(['yaml', 'jsonc-parser'])), []);
});

test('requireDependencies: one line naming the project and the install command', () => {
  const lines = [];
  const codes = [];
  requireDependencies({
    ...fixture([]), write: (line) => lines.push(line), exit: (code) => codes.push(code),
  });

  assert.deepEqual(codes, [1]);
  assert.equal(lines.length, 1, 'a hook shows its stderr once per run; keep it to one line');
  assert.equal(
    lines[0],
    'familiar: dependencies are not installed (missing yaml, jsonc-parser); '
    + 'run `npm install --prefix /project`\n',
  );
});

test('requireDependencies: silent and non-exiting when the tree is installed', () => {
  const lines = [];
  const codes = [];
  requireDependencies({
    ...fixture(['yaml', 'jsonc-parser']),
    write: (line) => lines.push(line),
    exit: (code) => codes.push(code),
  });

  assert.deepEqual(lines, []);
  assert.deepEqual(codes, []);
});

// The launchers exist for one reason: a bare specifier that cannot resolve fails before
// any module is evaluated, so the check must run in a file that imports nothing else.
for (const launcher of ['familiar', 'familiar-opencode']) {
  test(`bin/${launcher} checks dependencies before importing anything that needs them`, () => {
    const source = readFileSync(
      fileURLToPath(new URL(`../bin/${launcher}`, import.meta.url)), 'utf8');
    const staticImports = [...source.matchAll(/^import .*? from '(.+)';$/gm)].map((m) => m[1]);

    assert.deepEqual(staticImports, ['../src/deps.js']);
    assert.match(source, /requireDependencies\(\);\n/);
    assert.ok(
      source.indexOf('requireDependencies()') < source.indexOf('await import('),
      'the check must precede the dynamic import',
    );
  });
}
