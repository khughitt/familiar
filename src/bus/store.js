import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;   // no agents yet — not an error
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // ohai returned {} here. We do not: silently discarding every live agent
    // because one byte is wrong is exactly the failure the user never sees.
    throw new Error(`corrupt JSON at ${path}: ${error.message}`);
  }
}

// Temp-file-and-rename. rename(2) is atomic within a filesystem, so a renderer
// watching this path sees either the old file or the new one — never a partial
// write. This is what protects readers, not defensive parsing.
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
