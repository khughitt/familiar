// A module's static import graph, read from its source: every relative module it reaches
// (absolute paths, the entry included) and every bare specifier other than a `node:` builtin.
// Dynamic imports are not followed; a test that needs what a process actually loads traces
// it with trace-imports.mjs instead.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function importGraph(entry) {
  const files = new Set();
  const bare = [];
  const walk = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('./') || spec.startsWith('../')) walk(resolve(dirname(file), spec));
      else if (!spec.startsWith('node:')) bare.push(`${file}: ${spec}`);
    }
  };
  walk(entry);
  return { files, bare };
}
