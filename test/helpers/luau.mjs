// Runs the Noctalia plugin's production Luau under the pinned Luau 0.743 runtime.
// The chunk is assembled from the unmodified bytes of the production files plus a
// test-owned host fixture; nothing is transpiled and no presentation is re-implemented
// in JavaScript. Fixtures cross into Luau as table literals with JSON nulls omitted,
// exactly as the host's decoder drops them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const LUAU_VERSION = '0.743';
export const LUAU = join(ROOT, 'node_modules', '.cache', 'familiar-luau', LUAU_VERSION, 'luau');
export const PLUGIN_DIR = join(ROOT, 'integrations', 'noctalia-plugin');
export const HOST = join(ROOT, 'test', 'fixtures', 'noctalia-host.luau');
const RESULT = '@@familiar-result@@';

// Missing runtime is a failed prerequisite, never a skipped contract.
export function requireLuau() {
  if (!existsSync(LUAU)) {
    throw new Error(`Luau ${LUAU_VERSION} development runtime missing at ${LUAU}; provision it with: node tools/fetch-luau.mjs`);
  }
  return LUAU;
}

function luauString(text) {
  return JSON.stringify(text).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');
}

// A JSON value as a Luau literal. null is absent: a null object field is omitted and a
// null array element leaves a hole, matching how the host decodes JSON null.
export function luauLiteral(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return luauString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('luauLiteral: non-finite number');
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `{${value.map((item, index) => `[${index + 1}] = ${luauLiteral(item)}`).join(', ')}}`;
  const fields = Object.entries(value).filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => `[${luauString(key)}] = ${luauLiteral(item)}`);
  return `{${fields.join(', ')}}`;
}

// Production files keyed by module name, as host-loadable chunks of their own bytes.
export function pluginSources(names = ['presentation', 'service', 'widget', 'panel']) {
  return Object.fromEntries(names.map((name) => [name, readFileSync(join(PLUGIN_DIR, `${name}.luau`), 'utf8')]));
}

// Run `driver` (Luau source) after the host fixture and the plugin sources; the driver
// reports with `emit(value)`, which the fixture prints as JSON on a marked line.
export function runLuau(driver, { sources = pluginSources(), fixtures = {}, timeoutMs = 20_000 } = {}) {
  requireLuau();
  const dir = mkdtempSync(join(tmpdir(), 'familiar-luau-'));
  try {
    const chunk = [
      readFileSync(HOST, 'utf8'),
      ...Object.entries(sources).map(([name, text]) => `__define(${luauString(name)}, ${luauString(text)})`),
      ...Object.entries(fixtures).map(([name, value]) => `__fixture(${luauString(name)}, ${luauLiteral(value)})`),
      driver,
    ].join('\n');
    const file = join(dir, 'chunk.luau');
    writeFileSync(file, chunk);
    const result = spawnSync(LUAU, [file], { encoding: 'utf8', timeout: timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: dir } });
    if (result.error) throw result.error;
    const lines = result.stdout.split('\n');
    const emitted = lines.filter((line) => line.startsWith(RESULT)).map((line) => JSON.parse(line.slice(RESULT.length)));
    if (result.status !== 0) throw new Error(`luau exited ${result.status}: ${result.stderr || result.stdout}`);
    return { emitted, stdout: lines.filter((line) => !line.startsWith(RESULT)).join('\n'), stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
