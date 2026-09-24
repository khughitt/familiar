// familiar -> niri material signals. niri-material gives every window a set of
// signal SLOTS, one per source, written over IPC (`niri msg set-window-signal`,
// `pulse-window-signal`, `clear-window-signal`); its glass draws the folded result
// (an accent on the ring, a level, a motion). This module is the whole of the
// mapping, and it is PURE: it turns the bus and niri's window list into a list of
// `niri msg` argument vectors, and bin/familiar-niri runs them. The mapping is
// the one niri-material's signals design fixes (section 2, "The familiar bridge").
//
// Identity owns the accent, state owns level and motion — the same split as
// src/protocol/intent.js, so an erroring ginger tabby still lights its window ginger.

export const SOURCE = 'familiar';

const LEVELS = ['quiet', 'active', 'notice', 'demand'];

// Transitions INTO these states are events, not just levels: niri draws them as a
// one-shot impulse on top of the slot.
const IMPULSE_STATES = new Set(['done', 'error']);

// urgency `none` is two levels to niri: a working agent is doing something, an idle
// one is not. Every other urgency has a level of the same name.
export function levelFor(intent) {
  if (intent.urgency === 'none') return intent.state === 'working' ? 'active' : 'quiet';
  if (!LEVELS.includes(intent.urgency)) {
    throw new Error(`no niri level for urgency ${JSON.stringify(intent.urgency)}`);
  }
  return intent.urgency;
}

// familiar's motion policy is applied HERE, before niri sees the motion; niri's own
// global `signal { motion }` then applies on top, so the stricter of the two wins.
const REDUCED = { flash: 'pulse', pulse: 'breathe', breathe: 'breathe', static: 'static' };

export function motionFor(intent) {
  switch (intent.motionPolicy) {
    case 'full': return intent.motion;
    case 'reduced': return REDUCED[intent.motion];
    case 'off': return 'static';
    default: throw new Error(`unknown motionPolicy ${JSON.stringify(intent.motionPolicy)}`);
  }
}

// One session's contribution: the slot it would write if it had the window to
// itself. The decay contract of src/protocol/intent.js (displayedIntent) is carried
// across rather than re-implemented on a timer: a record that has not expired yet
// hands niri its successor and the time left, and niri swaps it itself.
export function sessionSlot(record, { themeId, now }) {
  const expired = record.expiresAt !== null && now >= record.expiresAt;
  const shown = expired ? record.after : record.current;
  const slot = {
    accent: shown.color.base,
    level: levelFor(shown),
    motion: motionFor(shown),
    tag: `${themeId}/${shown.identity.member}`,
    expiresAt: null,
    afterLevel: null,
    afterMotion: null,
  };
  if (!expired && record.expiresAt !== null) {
    slot.expiresAt = record.expiresAt;
    slot.afterLevel = levelFor(record.after);
    slot.afterMotion = motionFor(record.after);
  }
  return slot;
}

// Stock niri has no signal slots, and its `niri msg -j windows` has no `signal` key
// at all; niri-material always sends one, `null` when a window carries no slot.
export function niriHasSignals(windows) {
  return windows.every((w) => 'signal' in w);
}

function setArgs(windowId, slot, now) {
  const args = [
    'set-window-signal', '--id', String(windowId), '--source', SOURCE,
    '--accent', slot.accent, '--level', slot.level, '--motion', slot.motion, '--tag', slot.tag,
  ];
  if (slot.expiresAt !== null) {
    // At least 1 ms: niri treats the deadline as a real timer, and a slot that
    // expires as it is written is still the right thing to send.
    const ttl = Math.max(1, slot.expiresAt - now);
    args.push('--ttl-ms', String(ttl), '--after-level', slot.afterLevel, '--after-motion', slot.afterMotion);
  }
  return args;
}

// Plans one resync.
//
//   intent          intent.json, sessionId -> { current, expiresAt, after }
//   agents          agents.json, for each record's bus `seq` (the tie-break)
//   sessionWindows  niri-windows.json as mapSessionsToWindows computed it
//   windows         `niri msg -j windows`, niri's truth about which windows exist
//                   and which already carry a familiar slot
//   sent            windowId -> serialized slot, as last sent by this process
//   states          sessionId -> state, as last seen by this process
//
// Returns the commands to run in order ({ windowId, args }, args without `niri msg`),
// and the `sent` and `states` to carry into the next resync. Both start empty in a
// fresh process, which is what makes a restart safe: every window gets its slot
// again, and no stale transition is pulsed.
export function planWindowSignals({
  intent, agents, sessionWindows, windows, sent, states, themeId, now,
}) {
  // Several sessions in one terminal share one slot. The one that most needs the
  // user wins it — highest level, ties to the latest on the bus — and its accent,
  // tag, motion, and expiry come with it.
  const winners = new Map();
  const pulses = [];
  const nextStates = new Map();
  for (const [sessionId, { windowId }] of Object.entries(sessionWindows)) {
    const record = intent[sessionId];
    // agents.json and intent.json are two atomic renames, agents first. A resync
    // landing between them sees a session intent does not have yet; the rename
    // that follows fires another resync, which places it. Its last seen state is
    // carried so that resync can still pulse the transition.
    if (!record) {
      if (states.has(sessionId)) nextStates.set(sessionId, states.get(sessionId));
      continue;
    }

    const slot = sessionSlot(record, { themeId, now });
    const seq = agents[sessionId]?.seq ?? -1;
    const rank = LEVELS.indexOf(slot.level);
    const held = winners.get(windowId);
    if (!held || rank > held.rank || (rank === held.rank && seq > held.seq)) {
      winners.set(windowId, { slot, rank, seq });
    }

    const state = record.current.state;
    nextStates.set(sessionId, state);
    const prev = states.get(sessionId);
    const live = record.expiresAt === null || now < record.expiresAt;
    if (prev !== undefined && prev !== state && IMPULSE_STATES.has(state) && live
        && record.current.motionPolicy !== 'off') {
      pulses.push({ windowId, seq, args: [
        'pulse-window-signal', '--id', String(windowId), '--source', SOURCE,
        '--kind', state, '--accent', record.current.color.base,
      ] });
    }
  }

  const commands = [];
  const nextSent = new Map();
  const present = new Map(windows.map((w) => [w.id, w]));
  const carriesSlot = (w) => (w?.signal?.sources ?? []).includes(SOURCE);

  for (const [windowId, { slot }] of winners) {
    const serialized = JSON.stringify(slot);
    nextSent.set(windowId, serialized);
    // Resend when the slot changed, AND when niri no longer carries it: another
    // client may have cleared it, and a bridge that trusted its own memory over
    // niri's would leave that window dark until the next state change.
    if (sent.get(windowId) !== serialized || !carriesSlot(present.get(windowId))) {
      commands.push({ windowId, args: setArgs(windowId, slot, now) });
    }
  }

  // Clear by NIRI's account of which windows carry the slot, not by memory: a
  // restarted bridge knows nothing it sent, and the windows a previous run lit are
  // exactly the ones it must darken. A closed window is simply absent — its slot
  // died with it.
  for (const w of windows) {
    if (carriesSlot(w) && !winners.has(w.id)) {
      commands.push({ windowId: w.id, args: ['clear-window-signal', '--id', String(w.id), '--source', SOURCE] });
    }
  }

  // A pulse needs its slot to exist, so pulses go last; oldest first, so the most
  // recent transition is the one niri keeps if a burst overflows its impulse cap.
  pulses.sort((a, b) => a.seq - b.seq);
  for (const { windowId, args } of pulses) commands.push({ windowId, args });

  return { commands, sent: nextSent, states: nextStates };
}
