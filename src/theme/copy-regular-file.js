import { constants, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export function unsupportedEntry(path) {
  return new Error(
    `theme add: ${path} is not a regular file or directory — the source must contain only files and directories`
  );
}

export function changedEntry(path) {
  const error = new Error(
    `theme add: ${path} changed during acquisition — retry with a stable source`
  );
  error.code = 'THEME_ENTRY_CHANGED';
  return error;
}

export async function copyRegularFile(
  src, display, out, signal, expected,
  { open: openFile = open } = {},
) {
  let handle;
  try {
    try {
      handle = await openFile(
        src,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if (error.code === 'ELOOP') throw unsupportedEntry(display);
      throw error;
    }
    const actual = await handle.stat();
    if (!actual.isFile()) throw unsupportedEntry(display);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw changedEntry(display);
    }
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(out, { flags: 'wx' }),
      { signal }
    );
  } catch (error) {
    throw signal?.aborted ? signal.reason : error;
  } finally {
    await handle?.close();
  }
}
