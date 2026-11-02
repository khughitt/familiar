import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertId, validateThemePack } from 'familiar-theme';
import { withLock } from '../bus/lock.js';
import { acquireSource, classifySource } from './acquire.js';
import { receiptPath, writeReceipt } from './receipt.js';

export const STAGING_DIR_NAME = '.staging';
// Where `theme add --replace` keeps the theme it is replacing until the new one is in
// and receipted. Never inside .staging: every add sweeps staging, and a backup a sweep
// reached would be the user's old theme, gone.
export const BACKUP_DIR_NAME = '.replace-backup';
// A backup's layout: <userThemesDir>/.replace-backup/<id>-<ISO instant>/{pack,receipt.json}.
const BACKUP_PACK = 'pack';
const BACKUP_RECEIPT = 'receipt.json';

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

// add and remove share one lock: neither may see the other's half-done state. The
// lock never goes stale (an install can take minutes on a slow clone); a held lock
// is a named refusal, not a wait.
async function underInstallLock(paths, verb, lockOpts, fn) {
  mkdirSync(paths.userThemesDir, { recursive: true });
  const lockPath = lockPathFor(paths);
  let entered = false;
  try {
    return await withLock(lockPath, async () => {
      entered = true;
      return fn();
    }, { ...lockOpts, staleMs: Infinity });
  } catch (error) {
    if (!entered && error instanceof Error
      && error.message === `could not acquire lock: ${lockPath}`) {
      throw new Error(`${verb}: another theme add or remove is running`);
    }
    throw error;
  }
}

export async function removeTheme({ paths, id, lockOpts = {} }) {
  assertId(id, 'theme remove: id', 'cats');
  return underInstallLock(paths, 'theme remove', lockOpts, () => {
    const dir = join(paths.userThemesDir, id);
    const packStat = lstatOrNull(dir);
    if (packStat?.isSymbolicLink()) throw new Error(`theme remove: ${dir} is a symlink — refusing`);
    const receiptFile = receiptPath(paths, id);
    const receiptStat = lstatOrNull(receiptFile);
    if (packStat === null && receiptStat === null) {
      if (existsSync(join(paths.themesDir, id))) {
        throw new Error(`theme '${id}' is shipped, not installed — nothing to remove`);
      }
      throw new Error(`theme '${id}' is not installed`);
    }
    // The receipt first: an interrupted removal may leave part of a pack, but never a
    // receipt vouching for one. A symlinked receipt is unlinked, never followed or read.
    if (receiptStat !== null) unlinkSync(receiptFile);
    if (packStat !== null) rmSync(dir, { recursive: true });
    return { id, removed: { pack: packStat !== null, receipt: receiptStat !== null } };
  });
}

// Move whatever of the installed pack and its receipt exists into a fresh backup
// directory. Returns null when there is nothing to keep. A move that fails puts back
// what had moved and rethrows; if putting it back fails too, the backup stays where it
// is and the error names it.
function moveAside({ paths, id, target, receiptFile, rename, rm, now }) {
  const hasPack = lstatOrNull(target) !== null;
  const hasReceipt = lstatOrNull(receiptFile) !== null;
  if (!hasPack && !hasReceipt) return null;

  const root = join(paths.userThemesDir, BACKUP_DIR_NAME);
  const rootStat = lstatOrNull(root);
  if (rootStat === null) mkdirSync(root);
  else if (!rootStat.isDirectory()) {
    throw new Error(`theme add: ${root} is not a directory — remove it`);
  }
  const dir = join(root, `${id}-${now().toISOString()}`);
  mkdirSync(dir);
  const backup = {
    id, dir, target, receiptFile,
    pack: hasPack ? join(dir, BACKUP_PACK) : null,
    receipt: hasReceipt ? join(dir, BACKUP_RECEIPT) : null,
  };

  let packMoved = false;
  try {
    if (backup.pack !== null) {
      rename(target, backup.pack);
      packMoved = true;
    }
    if (backup.receipt !== null) rename(receiptFile, backup.receipt);
  } catch (cause) {
    // Restore exactly what moved: the pack if it did, never the receipt that did not.
    restore({ ...backup, pack: packMoved ? backup.pack : null, receipt: null },
      { paths, rename, rm, promoted: false, cause });
    throw cause;
  }
  return backup;
}

// Remove the backup root once its last backup is gone. A root that still holds a backup
// (an earlier failure's) must stay, so ENOTEMPTY is expected; ENOENT means it is gone.
// Any other failure surfaces.
function removeBackupRoot(paths) {
  try {
    rmdirSync(join(paths.userThemesDir, BACKUP_DIR_NAME));
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
  }
}

// Put the backed-up pack and receipt back where they were, then remove the empty
// backup directory. A failed move keeps the backup: it is the one copy of the user's
// old theme, and only a person may restore or delete it. A failed removal of the
// emptied directory leaves the theme restored and says so.
function restore(backup, { paths, rename, rm, promoted, cause }) {
  const message = (error) => (error instanceof Error ? error.message : String(error));
  // What is still in the backup, so a failure names exactly the moves left to make.
  const left = { pack: backup.pack, receipt: backup.receipt };
  try {
    // A promoted new pack occupies the target, and a non-empty target blocks the
    // rename back. It is reproducible from its source; the old one is not.
    if (promoted) rm(backup.target, { recursive: true });
    if (left.pack !== null) {
      rename(left.pack, backup.target);
      left.pack = null;
    }
    if (left.receipt !== null) {
      rename(left.receipt, backup.receiptFile);
      left.receipt = null;
    }
  } catch (restoreError) {
    const moves = [
      left.pack !== null && `its ${BACKUP_PACK} to ${backup.target}`,
      left.receipt !== null && `its ${BACKUP_RECEIPT} to ${backup.receiptFile}`,
    ].filter(Boolean);
    throw new Error(
      `theme add: replacing '${backup.id}' failed (${message(cause)}) and restoring it failed `
      + `(${message(restoreError)}) — the previous theme is kept at ${backup.dir}: `
      + `move ${moves.join(' and ')}, or remove it`,
      { cause },
    );
  }
  try {
    rmdirSync(backup.dir);
    removeBackupRoot(paths);
  } catch (rmdirError) {
    throw new Error(
      `theme add: ${message(cause)} — theme '${backup.id}' is restored as it was, but its backup `
      + `directory ${backup.dir} could not be removed (${message(rmdirError)}); remove it`,
      { cause },
    );
  }
}

export async function addTheme({
  paths,
  source,
  caFile,
  timeoutMs,
  growthLimitBytes,
  replace = false,
  lockOpts = {},
  validate = validateThemePack,
  writeReceiptFn = writeReceipt,
  rename = renameSync,
  rm = rmSync,
  now = () => new Date(),
}) {
  const classified = classifySource(source);
  return underInstallLock(paths, 'theme add', lockOpts, async () => {
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
    try {
      const { provenance, packDir } = await acquireSource(classified, runDir, {
        caFile,
        timeoutMs,
        growthLimitBytes,
      });
      const pack = await validate(packDir);
      const target = join(paths.userThemesDir, pack.id);
      const receiptFile = receiptPath(paths, pack.id);

      let backup = null;
      if (replace) {
        backup = moveAside({ paths, id: pack.id, target, receiptFile, rename, rm, now });
      } else {
        if (lstatOrNull(target) !== null) {
          throw new Error(
            `theme '${pack.id}' is already installed at ${target} — use \`theme add --replace <source>\` to replace it with a backup, or \`theme remove ${pack.id}\` first`
          );
        }
        if (lstatOrNull(receiptFile) !== null) {
          throw new Error(
            `theme add: orphan receipt at ${receiptFile} describes no installed theme — remove it first`
          );
        }
      }

      const receipt = {
        id: pack.id,
        source: provenance,
        installedAt: now().toISOString(),
      };
      let promoted = false;
      try {
        rename(packDir, target);
        promoted = true;
        await writeReceiptFn(paths, receipt);
      } catch (cause) {
        // Without a backup there is nothing to restore: a fresh install whose receipt
        // write fails stays installed and unreceipted, never falsely receipted.
        if (backup === null) throw cause;
        restore(backup, { paths, rename, rm, promoted, cause });
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`theme add: ${message} — theme '${pack.id}' is restored as it was`, { cause });
      }
      // Only now, with the new pack in and receipted, is the old one disposable. A
      // backup that will not go is still an error, but one that says the replace worked.
      if (backup !== null) {
        try {
          rm(backup.dir, { recursive: true });
          removeBackupRoot(paths);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(
            `theme '${pack.id}' installed; could not remove the replacement backup at ${backup.dir}: ${message}`,
            { cause },
          );
        }
      }
      return { id: pack.id, dir: target, members: pack.members.size, provenance };
    } finally {
      // After promotion the run holds only the discarded clone, if any; before
      // it, everything. Either way nothing in it outlives this add, and nothing
      // irreplaceable is ever in it: a replacement's backup lives outside staging.
      rmSync(runDir, { recursive: true, force: true });
    }
  });
}
