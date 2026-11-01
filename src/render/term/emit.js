import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { oscReset } from './osc.js';
import { GRAPHICS_CAPABILITY, graphicsCapability } from './capability.js';
import { transportFor } from './tmux.js';
import { writeAllSync } from './io.js';
import { stamp, inherit } from './ledger.js';

// Everything that draws (the pose, the animation program, and the theme contract and YAML
// behind them) is in transition.js, loaded only once an emission has something to draw. A
// SessionEnd writes its tombstone and an OSC reset under relay's tightest observer budget,
// and loads none of it: test/bin-familiar.test.js traces what a teardown loads.
const loadTransition = () => import('./transition.js');

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
//
// `provisional` marks an event whose bytes may land on a screen the agent's UI is not showing.
// Claude Code's SessionStart hook races its fullscreen TUI's switch to the alternate screen
// (?1049h), and kitty keeps one image store per screen: when the hook wins -- measured
// 2026-09-27, 119ms ahead -- the image lands in the main screen's store, and the placeholder
// cells the TUI draws on the alternate screen name an image that screen never received. So a
// provisional section ignores held evidence, always transmits (the cat shows whenever the
// screen was already up), and publishes its evidence marked `provisional`: nothing proves the
// TUI's screen holds the image. settle() below, run by the status line once the TUI is up,
// re-creates it; the next event creates rather than updating it, whichever comes first.
export async function emit({
  prev, next, intent, seq,
  readSprite = (p) => readFileSync(p), transmitSprite = true, provisional = false,
  terminal,
  ledger, lock, ownerAlive,
  loadAnimation, plan, encode,          // transition.js supplies the theme's when these are omitted
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
      const result = writeTerminal(Buffer.from(oscReset()));
      return result.written ? { kind: 'ended' } : { kind: 'suppressed', reason: result.reason };
    }

    if (intent === null) {
      await ledger.write(stampWith({ held: null, presented: null }));
      if (alive) writeTerminal(Buffer.from(oscReset()));
      return { kind: 'withdrawn' };
    }

    const { renderTransition, encodeGraphics } = await loadTransition();
    const held = provisional ? null : inherit(entry, owner);
    if (!alive) {
      await ledger.write(stampWith({ held }));
      return { kind: 'suppressed', reason: 'owner-dead' };
    }

    // 4. Decide. Evidence is valid only for the same owner (inherit) AND the same
    //    transport; `update` additionally needs a terminal that accepts animation
    //    commands — Ghostty does not, so STATIC is always a fresh create.
    const capability = env === undefined ? GRAPHICS_CAPABILITY.NONE : graphicsCapability(env, tmux);
    const transport = transportFor(tmux);
    const evidence = held !== null && !held.provisional && held.transport === transport;
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
    const { id, bytes: graphics } = encodeGraphics({
      intent, capability, lifecycle, tmux, loadAnimation, plan, encode, readFrame,
    });
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
      await ledger.write(stampWith({
        held: { transport, capability, id, intent: bindingFields(intent), ...(provisional ? { provisional: true } : {}) },
        presented: next.state,
      }));
      return { kind: 'transmitted', lifecycle, bytes: bytes.length };
    } finally {
      close(fd);
    }
  });
}

// FINISH A PROVISIONAL TRANSMISSION. The status line calls this on every refresh; it only
// runs when the TUI is up, so the screen it is drawn on is the screen the TUI shows -- the
// one fact a SessionStart hook cannot know (see emit()'s `provisional`). The common case
// is one ledger read and nothing else.
//
// Inside the same lock as emit(), and it neither reads nor advances the bus order: it
// re-sends the image the ledger already names, as a create, and publishes the same
// evidence without the mark. An event that runs first has already replaced the mark, and
// this finds nothing to do.
export async function settle({
  owner, intent, terminal,
  ledger, lock, ownerAlive,
  loadAnimation, plan, encode,          // transition.js supplies the theme's when these are omitted
  readFrame = (p) => readFileSync(p),
  open = openSync, write = writeSync, close = closeSync, checkTty = isatty,
}) {
  if (!terminal || typeof terminal.path !== 'string') {
    throw new Error('settle requires terminal { path, env, tmux }');
  }
  if (!ledger) throw new Error('settle requires ledger — the transmission ledger for this session');
  if (typeof lock !== 'function') throw new Error('settle requires lock — the per-session transmission lock');
  if (typeof ownerAlive !== 'function') throw new Error('settle requires ownerAlive — the fresh liveness predicate');

  return lock(async () => {
    const entry = await ledger.read();
    const held = inherit(entry, owner);
    if (entry.ended || held === null || !held.provisional) return { kind: 'noop' };
    // Another tmux client, or tmux gone: not the terminal the evidence names. The next event
    // creates for the terminal that is there.
    if (held.transport !== transportFor(terminal.tmux)) return { kind: 'noop' };
    if (!ownerAlive(owner.pid, { starttime: owner.starttime })) return { kind: 'noop' };

    const { encodeGraphics } = await loadTransition();
    const { id, bytes } = encodeGraphics({
      intent, capability: held.capability, lifecycle: 'create', tmux: terminal.tmux,
      loadAnimation, plan, encode, readFrame,
    });
    let fd;
    try { fd = open(terminal.path, 'a'); } catch { return { kind: 'suppressed', reason: 'open' }; }
    try {
      if (!checkTty(fd)) return { kind: 'suppressed', reason: 'not-a-tty' };
      // The same write-ahead as emit(): a partial write leaves nothing held, and the next
      // event creates.
      await ledger.write({ ...entry, held: null });
      writeAllSync(bytes, { fd, write });
      await ledger.write({
        ...entry,
        held: { transport: held.transport, capability: held.capability, id, intent: bindingFields(intent) },
      });
      return { kind: 'settled', bytes: bytes.length };
    } finally {
      close(fd);
    }
  });
}
