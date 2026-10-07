import { readdir as readdirDefault, stat as statDefault, unlink as unlinkDefault } from 'node:fs/promises';
import { join } from 'node:path';

// lock.js acquire() and store.js writeJsonAtomic() both stage through
// `<path>.tmp.<pid>.<uuid>` and remove it in-process. A hook killed between creating
// that temp and finishing with it -- routine whenever its agent's turn is cancelled --
// leaves it behind, and nothing else ever would.
const TEMP = /\.tmp\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A live writer holds its temp for a few syscalls. The temp carries only a pid, so a
// recycled pid can make an orphan look owned; past this age it is debris either way.
const MAX_AGE_MS = 60_000;

export async function sweepTemps({
  dirs, pidExists, now = () => Date.now(), maxAgeMs = MAX_AGE_MS,
  readdir = readdirDefault, stat = statDefault, unlink = unlinkDefault,
}) {
  const removed = [];
  for (const dir of dirs) {
    let names;
    try { names = await readdir(dir); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      const match = TEMP.exec(name);
      if (match === null) continue;
      const path = join(dir, name);
      if (pidExists(Number(match[1]))) {
        const info = await stat(path).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (info === null || now() - info.mtimeMs <= maxAgeMs) continue;
      }
      try {
        await unlink(path);
        removed.push(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;   // its writer finished with it first
      }
    }
  }
  return { removed };
}
