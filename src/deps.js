// Dependency preflight for the entrypoints in bin/.
//
// A missing bare specifier fails at RESOLUTION, before any module in the graph is
// evaluated, so a file that imports `yaml` can never report its own missing
// dependency: node prints ERR_MODULE_NOT_FOUND out of package_json_reader and
// nothing in it names familiar. That is why bin/familiar and bin/familiar-opencode
// are launchers that call this and then import their implementation dynamically,
// and why this module imports node: builtins only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function missingDependencies({
  root = projectRoot, exists = existsSync, read = readFileSync,
} = {}) {
  const manifest = JSON.parse(read(join(root, 'package.json'), 'utf8'));
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => !exists(join(root, 'node_modules', name)));
}

// One line, naming the project and the command that fixes it: hook stderr is all a
// Claude Code or OpenCode user sees, and they see it once per hook until it is fixed.
export function requireDependencies({
  root = projectRoot,
  exists = existsSync,
  read = readFileSync,
  write = (line) => process.stderr.write(line),
  exit = (code) => process.exit(code),
} = {}) {
  const missing = missingDependencies({ root, exists, read });
  if (missing.length === 0) return;
  write(`familiar: dependencies are not installed (missing ${missing.join(', ')}); `
    + `run \`npm install --prefix ${root}\`\n`);
  exit(1);
}
