// The project family, read from the published family file at the project's registered
// root (spec §5.3). This runs on the hook path, once per session and checkout, so the
// read is bounded, never follows a symlink out of the root, and loads the TOML parser
// only once a family file is found: a checkout without one never pays for it, and a
// SessionEnd teardown never reaches this module (test/bin-familiar.test.js traces it).
import { constants } from 'node:fs';
import { lstat as fsLstat, open as fsOpen, realpath as fsRealpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ID_RE } from './id.js';

export const FAMILY_FILE_MAX_BYTES = 65_536;

// In order: the first that exists is the family file, and the rest are never read.
const CANDIDATES = [['tools', 'family.toml'], ['family.toml']];

const absent = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';

const within = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export async function lookupFamily(root, {
  lstat = fsLstat, open = fsOpen, realpath = fsRealpath, maxBytes = FAMILY_FILE_MAX_BYTES,
} = {}) {
  if (typeof root !== 'string' || root === '') {
    throw new TypeError(`lookupFamily: root must be a non-empty path, got ${JSON.stringify(root)}`);
  }
  for (const parts of CANDIDATES) {
    const path = join(root, ...parts);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (absent(error)) continue;
      throw new Error(`family.toml at ${path}: ${error.message}`);
    }
    try {
      return await readFamily({ root, path, stat, open, realpath, maxBytes });
    } catch (error) {
      throw new Error(`family.toml at ${path}: ${error.message}`);
    }
  }
  return null;
}

async function readFamily({ root, path, stat, open, realpath, maxBytes }) {
  if (stat.isSymbolicLink()) throw new Error('is a symlink — the family file must be a regular file');
  if (!stat.isFile()) throw new Error('is not a regular file');
  if (stat.size > maxBytes) throw new Error(`is more than ${maxBytes} bytes (FAMILY_FILE_MAX_BYTES)`);
  // lstat refuses a symlinked file, not a symlinked tools/ directory above it.
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
  if (!within(realRoot, realFile)) throw new Error(`resolves outside ${realRoot} (to ${realFile})`);

  const text = (await readBounded(path, stat, open, maxBytes)).toString('utf8');
  const { parse } = await import('smol-toml');
  let document;
  try {
    document = parse(text);
  } catch (error) {
    const where = Number.isInteger(error.line) ? ` (line ${error.line}, column ${error.column})` : '';
    throw new Error(`cannot be parsed: ${String(error.message).split('\n')[0]}${where}`);
  }
  const { name } = document;
  if (typeof name !== 'string') {
    throw new Error(`name must be an id, got ${name === undefined ? 'no name' : JSON.stringify(name)}`);
  }
  if (!ID_RE.test(name)) {
    throw new Error(`family ${JSON.stringify(name)} is invalid — a family name is an id `
      + '(lowercase letters and digits, joined by single hyphens)');
  }
  return name;
}

// As familiar-theme's readDescriptor reads: the lstat size is only a pre-check, since the
// file can grow after it. At most maxBytes + 1 bytes are ever held; the extra byte proves
// the file is over the bound. O_NOFOLLOW refuses a file swapped for a symlink after lstat.
async function readBounded(path, stat, open, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = await handle.stat();
    if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino) {
      throw new Error('changed while it was read');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) throw new Error(`is more than ${maxBytes} bytes (FAMILY_FILE_MAX_BYTES)`);
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}
