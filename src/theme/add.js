import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { validateThemePack } from 'familiar-theme';
import { withLock } from '../bus/lock.js';
import { acquireSource, classifySource } from './acquire.js';
import { receiptPath, writeReceipt } from './receipt.js';

export const STAGING_DIR_NAME = '.staging';

export function lockPathFor(paths) {
  return join(paths.userThemesDir, '.theme-add.lock');
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function addTheme({
  paths,
  source,
  caFile,
  timeoutMs,
  growthLimitBytes,
  lockOpts = {},
  validate = validateThemePack,
  writeReceiptFn = writeReceipt,
  now = () => new Date(),
}) {
  const classified = classifySource(source);
  mkdirSync(paths.userThemesDir, { recursive: true });
  const lockPath = lockPathFor(paths);

  try {
    return await withLock(lockPath, async () => {
      const stagingRoot = join(paths.userThemesDir, STAGING_DIR_NAME);
      const stagingStat = lstatOrNull(stagingRoot);
      if (stagingStat === null) mkdirSync(stagingRoot);
      else if (!stagingStat.isDirectory()) {
        throw new Error(`theme add: ${stagingRoot} is not a directory — remove it`);
      }

      for (const entry of readdirSync(stagingRoot)) {
        rmSync(join(stagingRoot, entry), { recursive: true, force: true });
      }

      const runDir = mkdtempSync(join(stagingRoot, 'run-'));
      let promoted = false;
      try {
        const provenance = await acquireSource(classified, runDir, {
          caFile,
          timeoutMs,
          growthLimitBytes,
        });
        rmSync(join(runDir, '.git'), { recursive: true, force: true });
        const pack = await validate(runDir);
        const target = join(paths.userThemesDir, pack.id);

        if (lstatOrNull(target) !== null) {
          throw new Error(
            `theme '${pack.id}' is already installed at ${target} — remove it first`
          );
        }

        const receiptFile = receiptPath(paths, pack.id);
        if (lstatOrNull(receiptFile) !== null) {
          throw new Error(
            `theme add: orphan receipt at ${receiptFile} describes no installed theme — remove it first`
          );
        }

        renameSync(runDir, target);
        promoted = true;
        const receipt = {
          id: pack.id,
          source: provenance,
          installedAt: now().toISOString(),
        };
        await writeReceiptFn(paths, receipt);
        return { id: pack.id, dir: target, members: pack.members.size, provenance };
      } finally {
        if (!promoted) rmSync(runDir, { recursive: true, force: true });
      }
    }, { ...lockOpts, staleMs: Infinity });
  } catch (error) {
    if (error.message === `could not acquire lock: ${lockPath}`) {
      throw new Error('theme add: another theme add is running');
    }
    throw error;
  }
}
