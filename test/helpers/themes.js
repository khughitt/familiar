// Theme fixtures for the multi-theme context: an installed pack written under a theme
// id with a member id of the test's choosing, and a preloaded `themes` for tests that
// hold their packs already.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/theme-pack', import.meta.url));

// The fixture pack (one static member holding `default`) as theme `id`, its member
// renamed `member`, at `<themesDir>/<id>`. `packId` writes a pack whose own id differs
// from the directory it is installed under.
export function writeTheme(themesDir, id, { member = 'pip', packId = id } = {}) {
  const dir = join(themesDir, id);
  mkdirSync(join(dir, 'sprites'), { recursive: true });
  cpSync(join(FIXTURE, 'sprites', 'pip'), join(dir, 'sprites', member), { recursive: true });
  const descriptor = readFileSync(join(FIXTURE, 'theme.yaml'), 'utf8')
    .replace(/^id: fixture$/m, `id: ${packId}`)
    .replace(/^ {2}- id: pip$/m, `  - id: ${member}`)
    .replace('asset-root: sprites/pip', `asset-root: sprites/${member}`);
  writeFileSync(join(dir, 'theme.yaml'), descriptor);
  return dir;
}

// The context's `themes` over packs a test has already loaded, keyed by theme id: the
// same `packFor` contract (`theme "<id>" was not loaded` for any other id), with every
// `load` call recorded.
export function preloadedThemes(packs, { themeId = Object.keys(packs)[0], families = {} } = {}) {
  const loads = [];
  return {
    themeId,
    families,
    loads,
    async load(ids) { loads.push([...ids]); },
    packFor(id) {
      if (!Object.hasOwn(packs, id)) throw new Error(`theme "${id}" was not loaded`);
      return packs[id];
    },
  };
}
