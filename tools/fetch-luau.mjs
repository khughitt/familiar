#!/usr/bin/env node
// Provision the pinned Luau 0.743 development runtime the Noctalia plugin's contract
// tests run under. Downloads the official release archive for this host (or takes a
// local copy with --archive), verifies its SHA-256 BEFORE extracting anything, and
// writes the `luau` binary to node_modules/.cache/familiar-luau/0.743/luau. Lua 5.4 is
// not a substitute, and nothing here is a runtime dependency of familiar itself.
//
//   node tools/fetch-luau.mjs [--archive <luau-*.zip>] [--dest <path>]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LUAU_VERSION = '0.743';
const RELEASE = `https://github.com/luau-lang/luau/releases/download/${LUAU_VERSION}`;
// Verified against the 0.743 release metadata; the macOS build is arm64 only.
const PINS = {
  'linux-x64': { archive: 'luau-ubuntu.zip', sha256: '99d45afb4afaee00ba631c526c8e8c76c67b60f6f119953ce6409be6d6953663' },
  'darwin-arm64': { archive: 'luau-macos.zip', sha256: '4334afbfb0c05ee697c9bfea64a85f950249c1e8f6f7d99aaa5a24ee362b09c3' },
};
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LUAU_PATH = join(ROOT, 'node_modules', '.cache', 'familiar-luau', LUAU_VERSION, 'luau');

function fail(message, code = 1) {
  process.stderr.write(`fetch-luau: ${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
let archivePath = null;
let dest = LUAU_PATH;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--archive' && args[i + 1]) archivePath = args[++i];
  else if (args[i] === '--dest' && args[i + 1]) dest = args[++i];
  else fail('usage: node tools/fetch-luau.mjs [--archive <luau-*.zip>] [--dest <path>]', 2);
}

const pin = PINS[`${process.platform}-${process.arch}`];
if (!pin) fail(`no pinned Luau ${LUAU_VERSION} build for ${process.platform}-${process.arch}; supported: ${Object.keys(PINS).join(', ')}`);

let bytes;
if (archivePath) {
  bytes = readFileSync(archivePath);
} else {
  const response = await fetch(`${RELEASE}/${pin.archive}`);
  if (!response.ok) fail(`download of ${pin.archive} failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== pin.sha256) fail(`SHA-256 mismatch for ${pin.archive}: expected ${pin.sha256}, got ${digest}; nothing was extracted`);

mkdirSync(dirname(dest), { recursive: true });
const zip = `${dest}.${process.pid}.zip`;
const staged = `${dest}.${process.pid}.tmp`;
try {
  writeFileSync(zip, bytes);
  writeFileSync(staged, execFileSync('unzip', ['-p', zip, 'luau'], { maxBuffer: 64 * 1024 * 1024 }));
  chmodSync(staged, 0o755);
  renameSync(staged, dest);
} finally {
  rmSync(zip, { force: true });
  rmSync(staged, { force: true });
}
process.stdout.write(`${dest}\n`);
