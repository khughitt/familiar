import { readFileSync } from 'node:fs';
import { loadThemePack, assetsFor, STATES, loadAnimationMember } from 'familiar-theme';
import { paths as resolvePaths } from '../bus/paths.js';
import { loadConfig, loadTone, themeDirFor } from '../config.js';
import { loadIdentities } from '../bus/pins.js';
import { resolveIdentities, resolveAll } from '../bus/resolve.js';
import { preflightKittyPrograms } from '../render/term/kitty-animation.js';

// Everything the resolver needs, assembled once. This is the composition root:
// the only place that knows where files live.
export async function loadContext({ paths = resolvePaths(), config } = {}) {
  const [{ themeId, motionPolicy }, tone] = await Promise.all([
    config ?? loadConfig({ paths }),
    loadTone({ paths }),
  ]);
  const pack = await loadThemePack(themeDirFor(paths, themeId));
  const catalog = await loadIdentities(paths.identitiesPath);
  return { paths, themeId, motionPolicy, tone, pack, catalog };
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
    const { identities, faults } = resolveIdentities({ agents, catalog: ctx.catalog, pack: ctx.pack });

    // Keyed by MEMBER, because that is what an asset or animation failure is
    // about: a deleted PNG or malformed manifest belongs to a member, and faults
    // exactly the sessions resolving to that member — not its bus neighbours.
    //
    // Nothing is generated here any more: the assets are committed, and this
    // pass RESOLVES and VALIDATES them. The recolouring died with the indexed
    // codec; the per-member fault isolation did not, and it is the reason a
    // missing sprite cannot write a dangling path onto a surface with no error
    // channel.
    const cache = new Map();
    const memberFaults = new Map();
    for (const { member } of identities.values()) {
      if (cache.has(member) || memberFaults.has(member)) continue;
      try {
        const assets = assetsFor(ctx.pack, member, ctx.tone.mode);
        const { ref: animationRef, set: animationSet } = await loadMember(ctx.pack, member);
        const animationPreflight = animationSet.kind === 'clips'
          ? preflight(animationSet, {
            memberId: member,
            roots: Object.fromEntries(
              STATES.map((state) => [state, assets[state].terminal]),
            ),
            readFrame,
          })
          : null;
        cache.set(member, {
          assets,
          animationRef,
          animationSet,
          preflight: animationPreflight,
        });
      } catch (error) {
        memberFaults.set(member, error.message);
      }
    }

    for (const [sessionId, identity] of [...identities]) {
      if (!memberFaults.has(identity.member)) continue;
      faults.set(sessionId, memberFaults.get(identity.member));
      identities.delete(sessionId);
    }

    // Named, not `cache.get(id)[state]`. If the identity pass and the asset pass
    // ever disagree, the bare version says "Cannot read properties of undefined"
    // and names neither the member nor the state — an anonymous failure in the
    // one place that has both facts to hand. Every surviving identity now has
    // resolved assets by construction, so reaching either throw is a bug here,
    // not a user's config.
    const spriteFor = (memberId, state) => {
      const admitted = cache.get(memberId);
      if (!admitted) {
        throw new Error(`no assets for member "${memberId}" (needed for state "${state}")`);
      }
      const { assets } = admitted;
      const sprite = assets[state];
      if (!sprite) throw new Error(`member "${memberId}" has no asset for state "${state}"`);
      return sprite;
    };

    const animationFor = (memberId) => {
      const admitted = cache.get(memberId);
      if (!admitted) throw new Error(`no animation for member "${memberId}"`);
      return admitted.animationRef;
    };

    const animationSetFor = (memberId) => {
      const admitted = cache.get(memberId);
      if (!admitted) throw new Error(`no animation set for member "${memberId}"`);
      return admitted.animationSet;
    };

    return { identities, spriteFor, animationFor, animationSetFor, faults };
  };
}

export function visualResolver(ctx) {
  const prepare = makePrepareSprites(ctx);
  return async (sessions) => {
    const { identities, spriteFor, animationFor, faults } = await prepare(sessions);
    const intent = {};
    for (const [sid, record] of Object.entries(sessions)) {
      if (faults.has(sid)) continue;
      try {
        Object.assign(intent, resolveAll({
          agents: { [sid]: record }, identities, spriteFor, animationFor,
          tone: ctx.tone, motionPolicy: ctx.motionPolicy,
        }));
      } catch (error) {
        faults.set(sid, error.message);
      }
    }
    return { intent, faults };
  };
}
