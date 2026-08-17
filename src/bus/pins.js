import { readFile as fsReadFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { assertSlot } from 'familiar-theme';

// A pin path and a git repo root can name the same directory through different
// routes: `git rev-parse --show-toplevel` reports the PHYSICAL path, while a
// human writes the symlink they actually `cd` through (`~/d/familiar`, which on
// this machine is /mnt/ssd/Dropbox/familiar). Compare them lexically and the pin
// matches nothing — silently, which is the one outcome this whole system exists
// to prevent. So canonicalize BOTH sides.
//
// A pin may legitimately name a path that does not exist yet (a repo not cloned
// on this machine). realpath throws there, so fall back to the lexical path: it
// cannot match anything either way, and a missing directory is not a config error.
const defaultRealpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const canonical = (path, realpath) =>
  realpath(path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path));

export function parseIdentities(text) {
  const data = parse(text) ?? {};
  const identities = data.identities ?? [];
  if (!Array.isArray(identities)) {
    throw new Error('identities.yaml: `identities` must be a list');
  }

  for (const pin of identities) {
    if (!pin.remote && !pin.path && !pin.project) {
      throw new Error(`identity pin needs one of: remote, path, project — got ${JSON.stringify(pin)}`);
    }
    assertSlot(pin.slot);
    if (pin.member) {
      // The example names a member the shipped theme ACTUALLY HAS. It once said
      // `maine-coon`, a deferred alternate that existed in no theme -- so the message
      // correcting your config handed you a config that hard-errors one line later
      // with `theme "cats" has no member "maine-coon"`. An error message is
      // documentation with a captive audience; it does not get to be aspirational.
      // It said `cheshire` next, which was true until `cats` was replaced by the
      // roster that retired cheshire -- so test/pins.test.js resolves whatever name
      // appears here against the live theme rather than trusting this comment.
      throw new Error(
        'identity pin uses `member:`; member pins are theme-scoped — write `members: { cats: tuxedo }`'
      );
    }
  }

  return { identities };
}

export async function loadIdentities(path, { readFile = fsReadFile } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // No pins is the normal case: every repo gets a character on day one with
    // no configuration. Only a MALFORMED file is an error.
    if (error.code === 'ENOENT') return { identities: [] };
    throw error;
  }
  return parseIdentities(text);
}

// Specificity: remote > path > project. A bare `project` pin is a deliberate
// alias — "every repo called dotfiles gets the ginger tabby, wherever it lives".
// When two repos share a basename and you want them distinct, pin the one you
// care about by remote or path; the other falls through to its hashed slot.
export function matchPin(catalog, { remote, repoRoot, project }, { realpath = defaultRealpath } = {}) {
  const pins = catalog.identities;
  const root = repoRoot ? canonical(repoRoot, realpath) : null;
  return (
    (remote ? pins.find((p) => p.remote && p.remote.toLowerCase() === remote.toLowerCase()) : null) ??
    (root ? pins.find((p) => p.path && canonical(p.path, realpath) === root) : null) ??
    (project ? pins.find((p) => p.project && p.project === project) : null) ??
    null
  );
}

// A slot is theme-independent; a member is not. `cheshire` exists only in
// `cats`, so a pin naming a theme that is not active is INERT, not an error —
// you may keep pins for themes you switch between.
export function pinnedMember(pin, themeId) {
  return pin?.members?.[themeId] ?? null;
}
