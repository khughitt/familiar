import { presentationFor, ttlFor, decayTo } from '../protocol/intent.js';
import { identityColors } from '../theme/ramp.js';
import { assertState, defaultMember, memberForRole, memberOrThrow } from 'familiar-theme';
import { assertHexColor } from '../protocol/color.js';
import { slotForColor } from '../protocol/slot-hues.js';
import { themeFor } from '../config.js';
import { autoSlot } from './identity.js';
import { matchPin, pinnedMember } from './pins.js';
import { MOTION_POLICIES } from '../animation/program.js';
import { RESERVED_ROLE } from './id.js';

const nullableString = (value) => value === null || typeof value === 'string';

// projectKey -> slot -> hue for the colour; family -> theme, then role, pin and the
// theme's `default` holder -> member for the face. The two axes are independent: a
// role never changes a project's colour, and a slot never chooses a member.
//
// `remote`, `repoRoot` and `repositoryRoot` are carried separately rather than
// recovered from `projectKey`: the key collapses to whichever is available, so a
// `path:` pin could never match a repo that also has a remote. Silently ignoring a
// pin the user wrote is exactly the failure this system exists to avoid.
//
// `themes` is `{ themeId, families, packFor }`: the default theme and the family map
// loadConfig reads, and a synchronous `packFor(themeId)` that returns the loaded pack
// or throws that theme's own load error, so a family whose theme is broken faults
// exactly its own records.
export function resolveIdentity({
  projectKey, project, remote, repoRoot, repositoryRoot, projectColor, family, role, catalog, themes,
}) {
  if (projectColor === undefined) {
    throw new Error('resolveIdentity: projectColor must be a #rrggbb string or null');
  }
  if (projectColor !== null) assertHexColor(projectColor);
  if (!nullableString(family)) throw new Error('resolveIdentity: family must be a string or null');
  if (!nullableString(role)) throw new Error('resolveIdentity: role must be a string or null');
  if (role === RESERVED_ROLE) {
    throw new Error(`resolveIdentity: role "${RESERVED_ROLE}" is reserved for an agent with no role; pass null`);
  }

  // 1. Theme.
  const { theme, themeSource } = themeFor(themes, family);
  const pack = themes.packFor(theme);

  // 2. Slot and colours: colour, else pin, else hash. Unchanged by roles.
  const pin = matchPin(catalog, { remote, repoRoot, repositoryRoot, project });
  const slot = projectColor === null ? (pin ? pin.slot : autoSlot(projectKey)) : slotForColor(projectColor);
  const source = projectColor !== null ? 'colour' : pin ? 'pin' : 'auto';
  if (projectColor !== null && pin && pin.slot !== slot) {
    throw new Error(
      `pin declares slot ${pin.slot}, but project colour ${projectColor} (from tasks) maps to slot ${slot}: `
      + "remove the pin or change the project's colour",
    );
  }

  // 3. Member. A pin is the project's own face: it replaces the `default` holder and
  // never overrides a role the theme covers. A pin naming a member its theme lacks is
  // an error whichever way the table resolves, so a broken pin cannot hide behind a role.
  const pinned = pinnedMember(pin, theme);
  if (pinned !== null) memberOrThrow(pack, pinned);
  const roleMember = role === null ? null : memberForRole(pack, role);
  let memberId;
  let memberSource;
  if (roleMember !== null) {
    memberId = roleMember;
    memberSource = 'role';
  } else if (pinned !== null) {
    memberId = pinned;
    memberSource = 'pin';
  } else {
    memberId = defaultMember(pack);
    memberSource = role === null ? 'default' : 'unmapped';
  }
  const member = memberOrThrow(pack, memberId);

  return {
    projectKey,
    project,
    slot,
    member: memberId,
    label: member.label,
    projectColor,
    source,
    family,
    theme,
    themeSource,
    role,
    memberSource,
    anchor: member.anchor,
  };
}

// SHIM for the single-theme callers (identityResolver, install pets), which still load
// one pack from `theme:`: a `packFor` over that one theme that refuses any other id by
// name. Tasks C7 and C9 replace those callers; the last of them deletes this.
export function oneThemePackFor(themeId, pack) {
  return (wanted) => {
    if (wanted !== themeId) throw new Error(`theme "${wanted}" is not loaded (only "${themeId}" is)`);
    return pack;
  };
}

export function resolveIntent({
  record, identity, tone, spriteFor, animationFor, worldFor, motionPolicy,
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
  if (typeof worldFor !== 'function') {
    throw new Error(`resolveIntent: worldFor must be a function (found ${typeof worldFor})`);
  }
  const color = identityColors(identity, tone);
  // Proven once per record: a locale image that fails proof throws here and faults the
  // record, like a missing sprite. The world rides on the identity so a consumer reads
  // it from the snapshot it displays.
  const shownIdentity = { ...identity, world: worldFor(identity.theme) };
  const animation = animationFor(identity.theme, identity.member);

  const intentFor = (state) => ({
    sessionId: record.sessionId,
    pid: record.pid,
    admitted: record.admitted,
    identity: shownIdentity,
    state: assertState(state),
    ...presentationFor(state),
    motionPolicy,
    color,
    sprite: spriteFor(identity.theme, identity.member, state),
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
// returns. `resolveIdentity` is all-or-nothing for ONE record — a member renamed
// out of the theme, a pin contradicting the project colour, a family whose theme
// does not load — and it SHOULD be: that record cannot be drawn.
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
export function resolveIdentities({ agents, catalog, themes }) {
  const identities = new Map();
  const faults = new Map();
  for (const [sessionId, record] of Object.entries(agents)) {
    try {
      // A record written before the repository anchor existed carries a key derived the old
      // way. It is not guessed from repoRoot: it faults, and its session's next hook writes
      // it again with the anchor. An own null (outside any repository) is an answer. The
      // same holds for the project colour, the family and the role.
      for (const property of ['repositoryRoot', 'projectColor', 'family', 'role']) {
        if (!Object.hasOwn(record, property)) {
          throw new Error(`session record lacks ${property}; wait for its next hook`);
        }
      }
      identities.set(sessionId, resolveIdentity({
        projectKey: record.projectKey,
        project: record.project,
        remote: record.remote,
        repoRoot: record.repoRoot,
        repositoryRoot: record.repositoryRoot,
        projectColor: record.projectColor,
        family: record.family,
        role: record.role,
        catalog,
        themes,
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
  agents, identities, tone, spriteFor, animationFor, worldFor, motionPolicy,
}) {
  const out = {};
  for (const [sessionId, record] of Object.entries(agents)) {
    const identity = identities.get(sessionId);
    if (!identity) throw new Error(`no resolved identity for session "${sessionId}"`);
    out[sessionId] = resolveIntent({
      record, identity, tone, spriteFor, animationFor, worldFor, motionPolicy,
    });
  }
  return out;
}
