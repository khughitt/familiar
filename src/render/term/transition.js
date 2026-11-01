// The bytes of one drawn state change: the pose, its animation program, and the colours and
// bell around them. emit.js loads this only once an emission has something to draw; a
// SessionEnd never does.
import { readFileSync } from 'node:fs';
import { oscBackground, oscCursor, oscReset, BEL } from './osc.js';
import { GRAPHICS_CAPABILITY, graphicsCapability } from './capability.js';
import { transmitVirtual, imageIdFor } from './placeholder.js';
import { wrapForTmux } from './tmux.js';
import { boxFor } from './box.js';
import { loadAnimationRefSync } from 'familiar-theme';
import { planAnimation } from '../../animation/program.js';
import { encodeKittyProgram } from './kitty-animation.js';

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

// The complete graphics program for one intent, as bytes: planned and encoded before any
// fd is opened.
export function encodeGraphics({
  intent, capability, lifecycle, tmux, readFrame,
  loadAnimation = loadAnimationRefSync, plan = planAnimation, encode = encodeKittyProgram,
}) {
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
  const bytes = encode(program, {
    id,
    placement: { kind: 'virtual', ...boxFor(readCachedFrame(intent.sprite.terminal), intent.sprite.rows) },
    lifecycle,
    readFrame: readCachedFrame,
    frame: tmux?.ok ? wrapForTmux : (command) => command,
  }).bytes;
  return { id, bytes };
}
