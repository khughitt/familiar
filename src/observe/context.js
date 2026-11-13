import { readFileSync } from 'node:fs';
import { loadThemePack, assetsFor, localeAssetFor, STATES, loadAnimationMember } from 'familiar-theme';
import { paths as resolvePaths } from '../bus/paths.js';
import { loadConfig, loadTone, themeDirFor, themeFor } from '../config.js';
import { loadIdentities } from '../bus/pins.js';
import { resolveIdentities, resolveAll } from '../bus/resolve.js';
import { preflightKittyPrograms } from '../render/term/kitty-animation.js';

// Everything the resolver needs, assembled once. This is the composition root:
// the only place that knows where files live. No pack is loaded here: several themes
// are live at once (one per project family), and each pass loads only the themes its
// records name, through `themes.load`.
export async function loadContext({ paths = resolvePaths(), config } = {}) {
  const [loaded, tone] = await Promise.all([
    config ?? loadConfig({ paths }),
    loadTone({ paths }),
  ]);
  const catalog = await loadIdentities(paths.identitiesPath);
  const themes = themeSet({ paths, config: loaded });
  return { paths, config: loaded, motionPolicy: loaded.motionPolicy, tone, catalog, themes };
}

// The live themes, keyed by the theme id config names: the id `themeDirFor` loads, the
// id pins and Niri tags key on. `load(ids)` loads each id at most once per context and
// records a failure against that theme alone; `packFor(id)` is the synchronous lookup
// resolveIdentity takes, returning the pack or throwing the theme's recorded fault.
//
// A pack whose own id differs from the directory it was loaded under is a fault for
// that theme, not a pack to key either way: a pin's `members:` and a window's tag would
// name one id while the art came from another. `theme list` applies the same check, so a
// theme it lists as readable is one this set can load.
export function assertPackMatchesDirectory(pack, id) {
  if (pack.id !== id) throw new Error(`pack id "${pack.id}" does not match its directory`);
}

export function themeSet({ paths, config: { themeId, families }, loadPack = loadThemePack }) {
  // id -> { ready, pack } or { ready, fault }, the second key set when `ready` settles.
  const entries = new Map();
  const loadOne = async (id) => {
    try {
      const pack = await loadPack(themeDirFor(paths, id));
      assertPackMatchesDirectory(pack, id);
      return { pack };
    } catch (error) {
      return { fault: new Error(`theme "${id}": ${error.message}`) };
    }
  };
  return {
    themeId,
    families,
    async load(ids) {
      for (const id of ids) {
        if (entries.has(id)) continue;
        const entry = {};
        entry.ready = loadOne(id).then((outcome) => Object.assign(entry, outcome));
        entries.set(id, entry);
      }
      await Promise.all(ids.map((id) => entries.get(id).ready));
    },
    packFor(id) {
      const entry = entries.get(id);
      if (entry === undefined) throw new Error(`theme "${id}" was not loaded`);
      if (entry.fault) throw entry.fault;
      // Only a caller that did not await `load` can see this: a bug here, named.
      if (entry.pack === undefined) throw new Error(`theme "${id}" is still loading`);
      return entry.pack;
    },
  };
}

// Resolve every live record's identity ONCE — one per project in practice, and a
// cache hit on every event after the first. Nothing is BAKED any more: the sprite
// baker is gone, the terminal ships the master's bytes to kitty verbatim. Animation
// manifests and their program budgets are admitted at this same member boundary
// before anything reaches the bus.
//
// The identity map is RETURNED, not thrown away: resolveAll needs exactly the
// same map, and recomputing it there would mean a second full pin-match +
// realpathSync sweep over every record, on every tool call, for nothing.
//
// BOTH passes fault per RECORD, never per BUS. Everything here can fail — an
// unpopulated slot, a pin contradicting its member, a deleted sprite PNG — and
// any of it can start failing for a record that was fine a moment ago, because
// all of it is read from files the user edits. A failure that escaped this
// function would be a failure of the whole transaction, for every session on the
// machine, including the ones whose config nobody touched.
//
// Faults are collected per session so projection can omit only the broken visuals.
export function makePrepareSprites(ctx, {
  loadAnimationMember: loadMember = loadAnimationMember,
  preflightKittyPrograms: preflight = preflightKittyPrograms,
  readFrame = readFileSync,
} = {}) {
  return async (agents) => {
    // The themes these records draw from, loaded before resolving: each once, and a
    // theme that fails to load faults exactly the records of the families that name it.
    // A record lacking a family, or carrying a malformed one, loads nothing:
    // resolveIdentities faults it before it asks for a pack.
    const themeIds = new Set();
    for (const record of Object.values(agents)) {
      if (!Object.hasOwn(record, 'family')) continue;
      if (record.family !== null && typeof record.family !== 'string') continue;
      themeIds.add(themeFor(ctx.themes, record.family).theme);
    }
    await ctx.themes.load([...themeIds]);
    const { identities, faults } = resolveIdentities({ agents, catalog: ctx.catalog, themes: ctx.themes });

    // Keyed by (THEME, MEMBER), because that is what an asset or animation failure is
    // about: a deleted PNG or malformed manifest belongs to one theme's member, and
    // faults exactly the sessions resolving to it — not its bus neighbours, and not a
    // member of another live theme that happens to share its id.
    //
    // Nothing is generated here any more: the assets are committed, and this
    // pass RESOLVES and VALIDATES them. The recolouring died with the indexed
    // codec; the per-member fault isolation did not, and it is the reason a
    // missing sprite cannot write a dangling path onto a surface with no error
    // channel.
    const keyOf = (theme, member) => `${theme}/${member}`;
    const cache = new Map();
    const memberFaults = new Map();
    for (const { theme, member } of identities.values()) {
      const key = keyOf(theme, member);
      if (cache.has(key) || memberFaults.has(key)) continue;
      try {
        const pack = ctx.themes.packFor(theme);
        const assets = assetsFor(pack, member, ctx.tone.mode);
        const { ref: animationRef, set: animationSet } = await loadMember(pack, member);
        const animationPreflight = animationSet.kind === 'clips'
          ? preflight(animationSet, {
            memberId: member,
            roots: Object.fromEntries(
              STATES.map((state) => [state, assets[state].terminal]),
            ),
            readFrame,
          })
          : null;
        cache.set(key, {
          assets,
          animationRef,
          animationSet,
          preflight: animationPreflight,
        });
      } catch (error) {
        memberFaults.set(key, error.message);
      }
    }

    for (const [sessionId, identity] of [...identities]) {
      const key = keyOf(identity.theme, identity.member);
      if (!memberFaults.has(key)) continue;
      faults.set(sessionId, memberFaults.get(key));
      identities.delete(sessionId);
    }

    // Named, not `cache.get(key)[state]`. If the identity pass and the asset pass
    // ever disagree, the bare version says "Cannot read properties of undefined"
    // and names neither the member nor the state — an anonymous failure in the
    // one place that has both facts to hand. Every surviving identity now has
    // resolved assets by construction, so reaching either throw is a bug here,
    // not a user's config.
    const spriteFor = (theme, member, state) => {
      const key = keyOf(theme, member);
      const admitted = cache.get(key);
      if (!admitted) {
        throw new Error(`no assets for member "${key}" (needed for state "${state}")`);
      }
      const sprite = admitted.assets[state];
      if (!sprite) throw new Error(`member "${key}" has no asset for state "${state}"`);
      return sprite;
    };

    const animationFor = (theme, member) => {
      const admitted = cache.get(keyOf(theme, member));
      if (!admitted) throw new Error(`no animation for member "${keyOf(theme, member)}"`);
      return admitted.animationRef;
    };

    const animationSetFor = (theme, member) => {
      const admitted = cache.get(keyOf(theme, member));
      if (!admitted) throw new Error(`no animation set for member "${keyOf(theme, member)}"`);
      return admitted.animationSet;
    };

    // The theme's `home` locale, proven once per theme per invocation: `null` for a pack
    // without a world (localeAssetFor is not called for it), else the image path, size and
    // places. A failed proof throws, and the record resolving to that theme faults (the local state contract).
    // A failure is cached too, so every record of the theme reports the same fault.
    const worlds = new Map();
    const worldFor = (theme) => {
      if (!worlds.has(theme)) {
        try {
          const pack = ctx.themes.packFor(theme);
          if (pack.world === null) {
            worlds.set(theme, { world: null });
          } else {
            const { image, size, places } = localeAssetFor(pack, 'home');
            worlds.set(theme, { world: { locale: 'home', image, size, places } });
          }
        } catch (error) {
          worlds.set(theme, { error });
        }
      }
      const outcome = worlds.get(theme);
      if (outcome.error) throw outcome.error;
      return outcome.world;
    };

    return { identities, spriteFor, animationFor, animationSetFor, worldFor, faults };
  };
}

export function visualResolver(ctx) {
  const prepare = makePrepareSprites(ctx);
  return async (sessions) => {
    const { identities, spriteFor, animationFor, worldFor, faults } = await prepare(sessions);
    const intent = {};
    for (const [sid, record] of Object.entries(sessions)) {
      if (faults.has(sid)) continue;
      try {
        Object.assign(intent, resolveAll({
          agents: { [sid]: record }, identities, spriteFor, animationFor, worldFor,
          tone: ctx.tone, motionPolicy: ctx.motionPolicy,
        }));
      } catch (error) {
        faults.set(sid, error.message);
      }
    }
    return { intent, faults };
  };
}
