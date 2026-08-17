import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function writeAtomicSync(path, text, {
  write = writeFileSync,
  rename = renameSync,
  remove = unlinkSync,
  suffix = randomUUID,
} = {}) {
  const temp = `${path}.tmp.${suffix()}`;
  try {
    write(temp, text);
    rename(temp, path);
  } catch (error) {
    try {
      remove(temp);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          `atomic write failed and cleanup failed for ${temp}`,
        );
      }
    }
    throw error;
  }
}
