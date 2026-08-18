import { lstatSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertId } from 'familiar-theme';
import { STAGING_DIR_NAME } from './add.js';

// Enumeration lives here and not in config.js, which resolves exactly ONE id
// (themeDirFor) and otherwise reads config files. This module walks directories
// and knows the shadowing rule as a LISTING rule; themeDirFor knows it as a
// RESOLUTION rule. They must agree, and the test that proves they agree is the
// "collapses to a single user entry" case in theme-catalog.test.js.
//
// A FILE IS NOT A THEME. `readdir` is called `withFileTypes` so a stray
// .DS_Store, .gitkeep, or a downloaded theme.tar.gz left in either themes root
// can be told apart from a theme directory without opening it — every entry
// used to be fed to assertId regardless of file type, so a stray file bricked
// every verb that lists or resolves themes. A DIRECTORY whose name is not a
// valid theme id is a different case and stays a named error, never silently
// skipped: a skipped directory looks identical to a theme that was never
// installed, which would hide a mistake instead of reporting it.
function idsIn(dir, { readdir, exists }, reserved = new Set()) {
  if (!exists(dir)) return [];
  return readdir(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !reserved.has(entry.name))
    .map((entry) => entry.name);
}

export function listThemes(paths, { readdir = readdirSync, exists = existsSync } = {}) {
  const io = { readdir, exists };
  const shipped = idsIn(paths.themesDir, io);
  // .staging is the installer's one reserved name; its state is reported by
  // stagingStatus, not misread as a theme id.
  const user = idsIn(paths.userThemesDir, io, new Set([STAGING_DIR_NAME]));

  // Validate BEFORE joining, exactly as themeDirFor does — a name that cannot
  // be a theme id is reported by name rather than skipped, because a skipped
  // entry looks identical to a theme that was never installed.
  for (const id of [...shipped, ...user]) assertId(id, 'themes directory', 'cats');

  const shippedSet = new Set(shipped);
  const rows = [];

  for (const id of user) {
    rows.push({
      id,
      dir: join(paths.userThemesDir, id),
      source: 'user',
      shadowed: shippedSet.has(id),
    });
  }
  const userSet = new Set(user);
  for (const id of shipped) {
    if (userSet.has(id)) continue; // the user entry above already represents it
    rows.push({ id, dir: join(paths.themesDir, id), source: 'shipped', shadowed: false });
  }

  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Read untrusted staging state with lstat first: symlinks and files must never
// redirect or be traversed.
export function stagingStatus(paths, { lstat = lstatSync, readdir = readdirSync } = {}) {
  const dir = join(paths.userThemesDir, STAGING_DIR_NAME);
  let st;
  try {
    st = lstat(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  if (!st.isDirectory()) return 'not-a-directory';
  return readdir(dir).length > 0 ? 'occupied' : 'empty';
}
