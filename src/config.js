import { readFile as fsReadFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { assertTone } from './theme/ramp.js';
import { assertId } from 'familiar-theme';
import { writeJsonAtomic } from './bus/store.js';

const DEFAULT_THEME = 'cats';
const MOTION = new Set(['full', 'reduced', 'off']);

export async function loadConfig({ paths, readFile = fsReadFile }) {
  let text;
  try {
    text = await readFile(paths.configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { themeId: DEFAULT_THEME, motionPolicy: 'full' };
    throw error;
  }
  const data = parse(text) ?? {};
  const motionPolicy = data.motion ?? 'full';
  if (!MOTION.has(motionPolicy)) {
    throw new Error(
      `config.yaml: motion must be full, reduced, or off (found ${JSON.stringify(motionPolicy)})`
    );
  }
  return { themeId: data.theme ?? DEFAULT_THEME, motionPolicy };
}

// A theme in ~/.config/familiar/themes/<id> shadows a shipped one of the same
// name. This is the whole of "themes are user-authorable": without it, the
// user themes dir is a path constant nothing resolves.
//
// The id is CHARSET-VALIDATED before it is joined, against the same regex that
// governs every other id in a theme pack (familiar-theme's ID_RE). Without it,
// `theme: ../../../../etc` in config.yaml resolves to /etc — a themes dir that
// is not a directory the themes live in. Self-inflicted, since it is the user's
// own config file, but "the user typed it" is not a reason for a path join to
// leave the directory it names.
export function themeDirFor(paths, themeId, { exists = existsSync } = {}) {
  assertId(themeId, 'config.yaml: theme', DEFAULT_THEME);
  const userDir = join(paths.userThemesDir, themeId);
  return exists(userDir) ? userDir : join(paths.themesDir, themeId);
}

// SchemeTone is an INPUT. The core never asks a bar what the colorscheme is;
// something writes this file. Welding the color model to one bar would defeat
// the whole seam — which is exactly why the error below names `familiar scheme
// set`, the PORTABLE writer, and not any particular integration. A bare
// terminal with no compositor and no bar must be able to get itself running.
export async function loadTone({ paths, readFile = fsReadFile }) {
  let text;
  try {
    text = await readFile(paths.schemePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `no scheme at ${paths.schemePath} — run: familiar scheme set dark|light`
      );
    }
    throw error;
  }
  const tone = JSON.parse(text);
  assertTone(tone);
  return { mode: tone.mode, satScale: tone.satScale };
}

// The PORTABLE writer, backing `familiar scheme set`. An integration may
// overwrite this file from a real colorscheme; on a bare terminal with no
// bar, this is how the file comes to exist at all. Without it, "runs
// anywhere" means "runs anywhere you have first hand-written a JSON file
// nobody told you about".
export async function writeTone(paths, tone) {
  assertTone(tone);
  await writeJsonAtomic(paths.schemePath, { mode: tone.mode, satScale: tone.satScale });
}
