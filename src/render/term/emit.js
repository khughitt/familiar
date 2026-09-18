import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { oscBackground, oscCursor, oscReset, BEL } from './osc.js';
import { GRAPHICS_CAPABILITY, graphicsCapability } from './capability.js';
import { transmitVirtual, imageIdFor } from './placeholder.js';
import { wrapForTmux, transportFor } from './tmux.js';
import { boxFor } from './box.js';
import { loadAnimationRefSync } from 'familiar-theme';
import { planAnimation } from '../../animation/program.js';
import { encodeKittyProgram } from './kitty-animation.js';
import { writeAllSync } from './io.js';
import { stamp, inherit } from './ledger.js';

// The three states worth interrupting you for.
const RINGS = new Set(['needs-input', 'needs-approval', 'error']);

// NO DEFAULT FOR `env`, for exactly the reason graphicsCapability() has
// none: the environment that decides "does this terminal do graphics" belongs to the
// AGENT process — the one whose fd 1 the bytes are written to — and NOT to whoever
// happens to be asking. A `env = process.env` default here would hand graphicsCapability
// the very default it refuses, one layer up: the hook subprocess's own environment,
// silently, in the one function that turns the answer into escape bytes. The caller
// says which env, or it says which `capability` — it does not get to say neither.
export function renderTransition({
  prev, next, intent,
  readSprite = (p) => readFileSync(p),
  env,                                         // required, unless `capability` is given outright
  tmux,                                        // the probe result for `env`; decides FRAMING, not sending
  capability = graphicsCapability(env, tmux),  // the ANSWER is derived from them
}) {
  // This takes an Intent, not an IntentRecord. They are one `.current` apart and
  // trivially confusable, and getting it wrong breaks EVERY hook event in EVERY
  // project — so say so, rather than dying on `undefined.project` four lines down.
  if (!intent?.identity) {
    throw new Error('intent.identity is undefined — did you pass an IntentRecord instead of its .current?');
  }
  if (next === null) return oscReset();
  if (prev === next) return '';
  return [
    // A terminal that cannot parse a graphics escape gets no substitute rendering.
    capability === GRAPHICS_CAPABILITY.ANIMATION || capability === GRAPHICS_CAPABILITY.STATIC
      ? transmitPose({ intent, readSprite, tmux })
      : '',
    oscBackground(intent.color.backdrop),
    oscCursor(intent.color.base),
    RINGS.has(next) ? BEL : '',
  ].join('');
}

// THE CAT IS NO LONGER PRINTED. It is TRANSMITTED, and it draws nothing.
//
// What this replaces: transmit() from kitty.js put a real placement on the screen and reserved
// its rows with newlines. That works in a shell and is hopeless against claude-code, which is a
// fullscreen TUI that owns and repaints the screen -- the image is independent of the text grid,
// so it floated on top of text it never reserved. Measured: the cat landed on the permission
// dialog and covered the "Yes, always allow access to tmp/" option. The cat announcing a waiting
// decision was covering the decision.
//
// So the gating goes too, and that is the real change. ATTENTION_STATES existed because the
// terminal was a LOG: every transition printed ten rows into scrollback, a busy session
// transitions 50-60 times, and the only defence was to print rarely. A virtual placement draws
// NOTHING -- it just replaces the image sitting under the status line's cells -- so there is no
// scrollback to protect and no reason to be shy. The cat is level-triggered now: it always shows
// the CURRENT state, not the last one interesting enough to print.
//
// The id is derived from the session, so this and the status line (a different process, later,
// with no channel to here) name the same image without coordinating. The box comes from the
// sprite, via the one function they both call.
function transmitPose({ intent, readSprite, tmux }) {
  const png = readSprite(intent.sprite.terminal);
  const escapes = transmitVirtual(png, {
    id: imageIdFor(intent.sessionId),
    ...boxFor(png, intent.sprite.rows),
  });
  // Framed when the PROBE says the pane forwards passthrough — $TMUX alone is the inner
  // environment's claim, and the probe is the server's answer.
  return tmux?.ok ? wrapForTmux(escapes) : escapes;
}

// The fields of an intent that decide whether the terminal must be redrawn. This is what
// the ledger stores as `held.intent`; nothing else about an intent changes the pixels.
export function bindingFields(intent) {
  return {
    state: intent.state,
    motionPolicy: intent.motionPolicy,
    animation: intent.animation,
    sprite: { terminal: intent.sprite.terminal, rows: intent.sprite.rows },
  };
}

const sameBinding = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// THE EMISSION CRITICAL SECTION (docs/specs/2026-09-18-tmux-rendering-design.md §3.5).
//
// Everything that decides create-versus-update-versus-nothing, and every byte written to
// the agent's terminal, happens inside `lock`, in this order: read the ledger, gate on
// order and on the owner being alive, decide, null the evidence, write the terminal,
// publish the evidence. The ledger says what the TERMINAL holds; the bus's intent record
// says what familiar meant, and that used to be the evidence — a hook whose emission was
// suppressed still left an intent behind, and the next hook `update`d an image no
// terminal had. Two hooks of one session also used to interleave bytes on the same pty;
// the lock ends that.
//
// `seq` is the event's place in the bus-wide order (src/bus/seq.js). `ledger`, `lock`,
// and `ownerAlive` are REQUIRED, like `terminal`: the section cannot run without its
// evidence, its serialization, and its liveness check, and a caller that forgets one gets
// told rather than getting a section that silently runs unprotected.
export async function emit({
  prev, next, intent, seq,
  readSprite = (p) => readFileSync(p), transmitSprite = true,
  terminal,
  ledger, lock, ownerAlive,
  loadAnimation = loadAnimationRefSync,
  plan = planAnimation,
  encode = encodeKittyProgram,
  readFrame = readSprite,
  open = openSync, write = writeSync, close = closeSync, checkTty = isatty,
}) {
  if (!terminal || typeof terminal.path !== 'string') {
    throw new Error('emit requires terminal { path, env, tmux }');
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error('emit requires seq — the event\'s place in the bus order, from the transaction');
  }
  if (!ledger) throw new Error('emit requires ledger — the transmission ledger for this session');
  if (typeof lock !== 'function') throw new Error('emit requires lock — the per-session transmission lock');
  if (typeof ownerAlive !== 'function') throw new Error('emit requires ownerAlive — the fresh liveness predicate');
  const owner = next ?? prev;
  if (!owner) throw new Error('emit needs a record to own the terminal: prev and next are both null');
  const { env, tmux } = terminal;

  // Writes bytes to the terminal, or reports that it could not. Silent on a missing
  // process or fd: nothing to paint, not an error.
  const writeTerminal = (bytes) => {
    let fd;
    try { fd = open(terminal.path, 'a'); } catch { return { written: false, reason: 'open' }; }
    try {
      // open() succeeding is NOT evidence the fd is a terminal: in 370 of 1507
      // spike samples it belonged to a daemon whose stdout is a pipe or a log
      // file. Writing OSC escapes there would inject escape bytes into whatever
      // is reading that stream, silently. isatty() is not a refinement of the
      // path above; it is the actual gate.
      if (!checkTty(fd)) return { written: false, reason: 'not-a-tty' };
      writeAllSync(bytes, { fd, write });
      return { written: true };
    } finally {
      close(fd);
    }
  };

  return lock(async () => {
    const entry = await ledger.read();
    // Presentation has its own evidence: graphics may be disabled, and the bus's
    // previous state may belong to an event that has not reached this lock yet.
    const presented = entry.pid === owner.pid && entry.starttime === owner.starttime
      ? entry.presented ?? null : null;
    const stampWith = (fields) => stamp({ presented, ...fields }, { seq, owner });

    // 1. Order. A newer event already owns the terminal — whether it ran before we got
    //    the lock, or we are a straggler arriving after SessionEnd's tombstone.
    if (entry.seq >= seq) return { kind: 'superseded' };

    // 2. Ownership. Every byte below goes to a terminal `owner` is supposed to own; a
    //    straggler of an exited agent must not tint a pty the kernel has since handed to
    //    someone else, and on Darwin the /dev/ttys path can outlive the process.
    const alive = ownerAlive(owner.pid, { starttime: owner.starttime });

    // 3. SessionEnd: the tombstone first (it is ordering evidence, written even for a
    //    dead owner), then the reset, which needs no evidence.
    if (next === null) {
      await ledger.write(stampWith({ held: null, presented: null, ended: true }));
      if (!alive) return { kind: 'suppressed', reason: 'owner-dead' };
      writeTerminal(Buffer.from(oscReset()));
      return { kind: 'ended' };
    }

    const held = inherit(entry, owner);
    if (!alive) {
      await ledger.write(stampWith({ held }));
      return { kind: 'suppressed', reason: 'owner-dead' };
    }

    // 4. Decide. Evidence is valid only for the same owner (inherit) AND the same
    //    transport; `update` additionally needs a terminal that accepts animation
    //    commands — Ghostty does not, so STATIC is always a fresh create.
    const capability = env === undefined ? GRAPHICS_CAPABILITY.NONE : graphicsCapability(env, tmux);
    const transport = transportFor(tmux);
    const evidence = held !== null && held.transport === transport;
    const lifecycle = evidence && capability === GRAPHICS_CAPABILITY.ANIMATION ? 'update' : 'create';
    const graphical = transmitSprite
      && capability !== GRAPHICS_CAPABILITY.NONE
      && intent.motionPolicy !== 'off'
      && (!evidence || !sameBinding(held.intent, bindingFields(intent)));
    const presentation = renderTransition({
      prev: presented,
      next: next.state,
      intent,
      readSprite,
      env,
      tmux,
      capability: GRAPHICS_CAPABILITY.NONE,     // graphics come from encode() below, never from here
    });

    // 5. Unchanged (or nothing graphical possible): the evidence stands, the order advances.
    if (!graphical) {
      await ledger.write(stampWith({ held }));
      if (presentation.length > 0 && writeTerminal(Buffer.from(presentation)).written) {
        await ledger.write(stampWith({ held, presented: next.state }));
      }
      return { kind: 'unchanged' };
    }

    // 6. Graphics. The byte plan is complete before the fd is opened, so planning,
    //    encoding and limit checks cannot strand a partial program on the terminal.
    const set = loadAnimation(intent.animation);
    const program = plan({
      set, root: intent.sprite.terminal, state: intent.state, sessionId: intent.sessionId,
      policy: intent.motionPolicy, capability,
    });
    if (program.kind === 'none') {
      throw new Error('terminal animation: graphical capability produced no program');
    }
    const frameCache = new Map();
    const readCachedFrame = (path) => {
      if (!frameCache.has(path)) frameCache.set(path, Buffer.from(readFrame(path)));
      return frameCache.get(path);
    };
    const id = imageIdFor(intent.sessionId);
    const graphics = encode(program, {
      id,
      placement: { kind: 'virtual', ...boxFor(readCachedFrame(intent.sprite.terminal), intent.sprite.rows) },
      lifecycle,
      readFrame: readCachedFrame,
      frame: tmux?.ok ? wrapForTmux : (command) => command,
    }).bytes;
    const bytes = Buffer.concat([graphics, Buffer.from(presentation)]);

    let fd;
    try { fd = open(terminal.path, 'a'); } catch {
      await ledger.write(stampWith({ held }));
      return { kind: 'suppressed', reason: 'open' };
    }
    try {
      if (!checkTty(fd)) {
        await ledger.write(stampWith({ held }));
        return { kind: 'suppressed', reason: 'not-a-tty' };
      }
      // WRITE-AHEAD: from here until publish, the ledger says nothing is held. A partial
      // write, a crash, or a failed publish all leave that state, and the next event
      // creates. A failed write-ahead throws before any terminal byte.
      await ledger.write(stampWith({ held: null }));
      writeAllSync(bytes, { fd, write });
      await ledger.write(stampWith({ held: { transport, capability, id, intent: bindingFields(intent) }, presented: next.state }));
      return { kind: 'transmitted', lifecycle, bytes: bytes.length };
    } finally {
      close(fd);
    }
  });
}
