// THE STATUS LINE'S RENDER CACHE. Claude Code polls `familiar statusline` every two seconds
// for every open session, idle or not. A full render loads the theme contract, YAML and the
// render modules, which is most of its cost; an idle session's line does not change between
// polls. So the front door keys each render on everything it reads, and prints the line it
// cached for that key without loading the renderer at all.
//
// THIS FILE IS ON THE HIT PATH, so it imports node builtins and the cheap ledger and store
// helpers only. Nothing here may pull in the theme contract, YAML or relay.
//
// WHAT THE KEY COVERS, and so what a hit can never show stale:
// - `fields`: everything readFields took from the payload, git and the claim (and whatever it
//   grows to read). Anything new the line shows must come through readFields, or it is cached.
// - this session's record on the bus, raw: state, identity, project colour and timestamps.
// - config.yaml, scheme.json and identities.yaml, by inode, size and mtime. With the record's
//   family and role, they decide which theme and member the session draws (`families:`).
// - every installed theme's descriptor (theme.yaml, user and shipped roots), by the same stamp:
//   which theme ids exist, so `theme add`, `theme add --replace` (a new pack renamed into
//   place) and `theme remove` are each a miss, and an edit to a pack's roles, rows or world.
//   The descriptors are stamped, never parsed: no YAML on the hit path.
// - this session's transmit ledger, raw; a provisional one is never cached at all.
// WHAT IT DOES NOT COVER is bounded by RENDER_TTL_MS: a pack's other files (its sprites and
// world images, so a world image deleted under a cached line faults within that long),
// familiar's own code, symlinks under a pinned or recorded path (pins match on realpaths), and
// the validity of other sessions' entries in the sessions file. A change to any reaches the
// line within that long. A faulted line is never cached, so a fault is said on every poll.
//
// TIME IS PART OF THE ANSWER: a `done` or `error` intent decays to `idle` at its expiresAt.
// The renderer knows that deadline, so an entry is valid until the earlier of it and the TTL.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ledgerName, ledgerPaths } from './ledger.js';
import { writeJsonAtomic } from '../../bus/store.js';

export const RENDER_TTL_MS = 30_000;

// Bumped when the entry or key shape changes, so an old entry is a miss, not a misread.
const SCHEMA = 2;

export const renderCacheDir = (stateDir) => join(stateDir, 'statusline-render');

export function renderCachePath(stateDir, sessionId) {
  return join(renderCacheDir(stateDir), `${ledgerName(sessionId)}.json`);
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// An atomic rewrite (temp + rename) changes the inode even when size and mtime collide.
function stamp(path) {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// Each entry of a themes root that holds a theme.yaml, with that descriptor's stamp, in name
// order; null for a root that does not exist. An entry with none (a stray file, a staging
// directory) is left out, as the catalog skips it.
function themeStamps(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  return names.sort()
    .map((name) => [name, stamp(join(root, name, 'theme.yaml'))])
    .filter(([, descriptor]) => descriptor !== null);
}

// The key for one session's render, or null when this render cannot be keyed and must run
// in full. Null is not a fault: JSON that does not parse is reported by the renderer.
//
// Only this session's record is read out of the sessions file, unvalidated: keying on the
// whole file would miss on every other session's hook event. So a file that parses but fails
// the renderer's validation (another session's malformed entry, a newer schema) is reported
// only once this session's entry expires, within RENDER_TTL_MS.
export function renderKey({ paths, sessionId, fields }) {
  const sessionsText = readText(paths.sessionsPath);
  let record = null;
  if (sessionsText !== null) {
    try {
      record = JSON.parse(sessionsText)?.sessions?.[sessionId] ?? null;
    } catch {
      return null;
    }
  }
  // A PROVISIONAL IMAGE IS NEVER CACHED. settle() answers noop for evidence it cannot settle
  // yet (tmux gone, another tmux client) and leaves it provisional; the next poll must try
  // again, as every poll did before this cache existed.
  const ledger = readText(ledgerPaths(paths.transmitDir, sessionId).entryPath);
  if (ledger !== null) {
    try {
      if (JSON.parse(ledger)?.held?.provisional) return null;
    } catch {
      return null;
    }
  }
  const key = {
    schema: SCHEMA,
    sessionId,
    fields,
    record,
    ledger,
    config: stamp(paths.configPath),
    scheme: stamp(paths.schemePath),
    identities: stamp(paths.identitiesPath),
    userThemes: themeStamps(paths.userThemesDir),
    shippedThemes: themeStamps(paths.themesDir),
  };
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

// The cached line for `key` at `now`, or null. A missing, foreign or unreadable entry is a
// miss: the render that follows rewrites it, which is the whole of a cache's recovery.
export function readRender(path, key, now) {
  const text = readText(path);
  if (text === null) return null;
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return null;
  }
  if (entry?.schema !== SCHEMA || entry.key !== key || typeof entry.output !== 'string') return null;
  // A clock that stepped backwards past the render is not trusted to be inside the window.
  if (!(now >= entry.renderedAt && now < entry.validUntil)) return null;
  return entry.output;
}

// The earlier of the TTL and the intent's decay deadline, when that is still ahead.
export function validUntil(now, expiresAt) {
  const ttl = now + RENDER_TTL_MS;
  return Number.isFinite(expiresAt) && expiresAt > now ? Math.min(ttl, expiresAt) : ttl;
}

export function writeRender(path, { key, output, renderedAt, until }) {
  return writeJsonAtomic(path, { schema: SCHEMA, key, renderedAt, validUntil: until, output });
}

// `reap`'s half: an entry whose session is no longer on the bus. A session not yet on the bus
// loses its entry too, and its next poll writes it again. Atomic-write temps here are
// sweepTemps' job, not this one's.
export async function pruneRenders({ stateDir, sessions }) {
  const dir = renderCacheDir(stateDir);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: [] };
    throw error;
  }
  const live = new Set(Object.keys(sessions).map((sessionId) => `${ledgerName(sessionId)}.json`));
  const removed = [];
  for (const name of names) {
    if (!name.endsWith('.json') || live.has(name)) continue;
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { removed };
}
