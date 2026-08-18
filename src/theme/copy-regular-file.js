import { constants, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export function unsupportedEntry(path) {
  return new Error(
    `theme add: ${path} is not a regular file or directory — the source must contain only files and directories`
  );
}

export async function copyRegularFile(src, display, out, signal) {
  let handle;
  try {
    try {
      handle = await open(
        src,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if (error.code === 'ELOOP') throw unsupportedEntry(display);
      throw error;
    }
    if (!(await handle.stat()).isFile()) throw unsupportedEntry(display);
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
