import { presentationFor, ttlFor, decayTo } from '../protocol/intent.js';
import { identityColors } from '../theme/ramp.js';
import { assertState, defaultMemberForSlot, memberOrThrow } from 'familiar-theme';
import { autoSlot } from './identity.js';
import { matchPin, pinnedMember } from './pins.js';
import { MOTION_POLICIES } from '../animation/program.js';

// projectKey -> slot -> hue -> member -> sprite.
// The hue is the stable axis; the theme is data layered on top.
//
// `remote` and `repoRoot` are carried separately rather than recovered from
// `projectKey`: the key collapses to whichever is available, so a `path:` pin
// could never match a repo that also has a remote. Silently ignoring a pin the
// user wrote is exactly the failure this system exists to avoid.
export function resolveIdentity({ projectKey, project, remote, repoRoot, catalog, pack }) {
  const pin = matchPin(catalog, { remote, repoRoot, project });

  const slot = pin ? pin.slot : autoSlot(projectKey);

  const pinned = pinnedMember(pin, pack.id);
  let memberId;
  if (pinned) {
    const member = memberOrThrow(pack, pinned);   // unknown to its own theme -> error
    if (!member.slots.includes(slot)) {
      throw new Error(
        `member "${pinned}" holds ` +
        `${member.slots.length === 1 ? `slot ${member.slots[0]}` : `slots ${member.slots.join(', ')}`}, ` +
        `but the pin declares slot ${slot}`
      );
    }
    memberId = pinned;
  } else {
    memberId = defaultMemberForSlot(pack, slot);
  }

  return {
    projectKey,
    project,
    slot,
    member: memberId,
    label: memberOrThrow(pack, memberId).label,
  };
}

export function resolveIntent({
  record, identity, tone, spriteFor, animationFor, motionPolicy,
}) {
  if (!MOTION_POLICIES.includes(motionPolicy)) {
    const choices = `${MOTION_POLICIES.slice(0, -1).join(', ')}, or ${MOTION_POLICIES.at(-1)}`;
    throw new Error(
      `resolveIntent: motionPolicy must be exactly ${choices} `
      + `(found ${JSON.stringify(motionPolicy)})`,
    );
  }
  if (typeof animationFor !== 'function') {
    throw new Error(
      `resolveIntent: animationFor must be a function (found ${typeof animationFor})`,
    );
  }
  const color = identityColors(identity.slot, tone);
  const animation = animationFor(identity.member);

  const intentFor = (state) => ({
    sessionId: record.sessionId,
    pid: record.pid,
    identity,
    state: assertState(state),
    ...presentationFor(state),
    motionPolicy,
    color,
    sprite: spriteFor(identity.member, state),
    animation,
  });

  const current = intentFor(record.state);
  const ttl = ttlFor(record.state);

  // A persistent state stays true until something acts on it, so it needs no
  // expiry. A transient one carries BOTH its expiry and its fully-resolved
  // successor, so the renderer's job reduces to a timed swap.
  if (ttl === null) return { current, expiresAt: null, after: null };

  return {
    current,
    expiresAt: record.updatedAt + ttl,
    after: intentFor(decayTo(record.state)),
  };
}

// The identity pass, hoisted out of resolveAll and named. It runs ONCE per
// transaction: its caller needs the identities anyway, to know which members to
// resolve assets for, and resolving them a second time inside resolveAll would mean
// a second full pin-match + realpathSync sweep on every tool call.
//
// FAULT-ISOLATED PER RECORD, and that is the whole point of the shape it
// returns. `resolveIdentity` is all-or-nothing for ONE record — a pin to a slot
// the theme does not populate, a member renamed out of the theme, a `theme:`
// switched in config.yaml — and it SHOULD be: that record cannot be drawn.
//
// But this pass runs over EVERY record on the bus, on every hook, for every
// session on the machine. Letting one record's throw escape makes resolution
// all-or-nothing over the whole bus: edit identities.yaml for project B and
// project A's hooks — a different repo, a different slot, a different terminal —
// start throwing before they write anything, and BOTH files freeze mid-state
// for everyone. One project's misconfiguration must never take down another
// project's session.
//
// So a failure is recorded AGAINST THE RECORD and the pass keeps going. This
// function does not decide what a fault MEANS: whether the record aborts the
// transaction or is evicted from the bus depends on whether it is the incoming
// record or a pre-existing one, and only the transaction knows which (see
// commit() in ./transaction.js).
export function resolveIdentities({ agents, catalog, pack }) {
  const identities = new Map();
  const faults = new Map();
  for (const [sessionId, record] of Object.entries(agents)) {
    try {
      identities.set(sessionId, resolveIdentity({
        projectKey: record.projectKey,
        project: record.project,
        remote: record.remote,
        repoRoot: record.repoRoot,
        catalog,
        pack,
      }));
    } catch (error) {
      faults.set(sessionId, error.message);
    }
  }
  return { identities, faults };
}

// Takes the identity map rather than re-deriving it. Every record must already
// have one: a missing entry means the identity pass and this one disagree about
// what is on the bus, which is a bug in the caller, not a record to skip.
// (Faulted records are not "missing" — the transaction has already dropped them
// from `agents` by the time this runs.)
export function resolveAll({
  agents, identities, tone, spriteFor, animationFor, motionPolicy,
}) {
  const out = {};
  for (const [sessionId, record] of Object.entries(agents)) {
    const identity = identities.get(sessionId);
    if (!identity) throw new Error(`no resolved identity for session "${sessionId}"`);
    out[sessionId] = resolveIntent({
      record, identity, tone, spriteFor, animationFor, motionPolicy,
    });
  }
  return out;
}
