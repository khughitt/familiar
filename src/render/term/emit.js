import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { oscBackground, oscCursor, oscReset, BEL } from './osc.js';
import { GRAPHICS_CAPABILITY, graphicsCapability } from './capability.js';
import { transmitVirtual, imageIdFor, wrapForTmux } from './placeholder.js';
import { boxFor } from './box.js';
import { loadAnimationRefSync } from 'familiar-theme';
import { planAnimation } from '../../animation/program.js';
import { encodeKittyProgram } from './kitty-animation.js';
import { writeAllSync } from './io.js';

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
  capability = graphicsCapability(env),        // the ANSWER is derived from it
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
      ? transmitPose({ intent, readSprite, env })
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
function transmitPose({ intent, readSprite, env }) {
  const png = readSprite(intent.sprite.terminal);
  const escapes = transmitVirtual(png, {
    id: imageIdFor(intent.sessionId),
    ...boxFor(png, intent.sprite.rows),
  });
  // tmux forwards 0 of 38 graphics escapes unwrapped and 38 of 38 wrapped. graphicsCapability()
  // currently refuses tmux outright, so this branch is unreachable today -- it is here so that
  // relaxing that refusal is a one-line change in ONE place, not a bug hunt in this one.
  return env?.TMUX ? wrapForTmux(escapes) : escapes;
}

// Finding A of the Task 1 spike: `/dev/tty` fails with ENXIO from a hook
// subprocess in 1507 of 1507 samples — it has no controlling terminal — and
// must never be attempted. `/proc/<agentPid>/fd/1` is the only path that can
// reach the user's screen.
const ttyFdPath = (agentPid) => `/proc/${agentPid}/fd/1`;

// The AGENT's environment, not the hook's. intent.pid is the process whose fd 1 we
// write to, so its environment is the terminal's by definition. The hook is merely
// a grandchild that may or may not have inherited it -- and the Task 1 spike is the
// reason we do not assume which.
//
// A value may itself contain '=' (LS_COLORS is the everyday case), so the split is
// on the FIRST '=' only. `kv.split('=')` truncates those, and would do it silently.
export function envOf(pid, read = readFileSync) {
  const raw = read(`/proc/${pid}/environ`, 'utf8');
  return Object.fromEntries(
    raw.split('\0').filter(Boolean).map((kv) => {
      const eq = kv.indexOf('=');
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    }),
  );
}

function hasConsistentBindingEvidence(prev, priorIntent) {
  return prev !== null
    && priorIntent !== null
    && priorIntent.sessionId === prev.sessionId
    && priorIntent.pid === prev.pid
    && priorIntent.state === prev.state;
}

// `transmitSprite: false` means only tint and bell bytes go out.
export function emit({
  prev, next, priorIntent, intent, readSprite = (p) => readFileSync(p), transmitSprite = true,
  loadAnimation = loadAnimationRefSync,
  plan = planAnimation,
  encode = encodeKittyProgram,
  readFrame = readSprite,
  readEnviron = readFileSync,
  open = openSync, write = writeSync, close = closeSync, checkTty = isatty,
}) {
  // An unreadable environ degrades to no sprite; tint and bell remain usable.
  let capability = GRAPHICS_CAPABILITY.NONE;
  let env;
  try {
    env = envOf(intent.pid, readEnviron);
    capability = graphicsCapability(env);
  } catch { /* no environ -> no graphics. The rest of the transition still goes out. */ }

  // BOTH env AND capability. The answer is already computed and must not be recomputed
  // from a different environment; the environment itself is still needed, because whether we are
  // inside tmux decides how the escapes are FRAMED, not whether they are sent.
  const prevState = prev?.state ?? null;
  const nextState = next?.state ?? null;
  const presentation = renderTransition({
    prev: prevState,
    next: nextState,
    intent,
    readSprite,
    env,
    capability: GRAPHICS_CAPABILITY.NONE,
  });

  const processChanged = prev !== null && next !== null
    && (prev.pid !== next.pid || prev.starttime !== next.starttime);
  const bindingIntent = hasConsistentBindingEvidence(prev, priorIntent)
    ? priorIntent
    : null;
  const graphicalTransition = next !== null && (
    prev === null
    || bindingIntent === null
    || processChanged
    || bindingIntent.state !== intent.state
    || bindingIntent.motionPolicy !== intent.motionPolicy
    || JSON.stringify(bindingIntent.animation) !== JSON.stringify(intent.animation)
    || bindingIntent.sprite?.terminal !== intent.sprite.terminal
    || bindingIntent.sprite?.rows !== intent.sprite.rows
  );

  let graphics = Buffer.alloc(0);
  if (
    transmitSprite
    && graphicalTransition
    && capability !== GRAPHICS_CAPABILITY.NONE
    && intent.motionPolicy !== 'off'
  ) {
    const set = loadAnimation(intent.animation);
    const program = plan({
      set,
      root: intent.sprite.terminal,
      state: intent.state,
      sessionId: intent.sessionId,
      policy: intent.motionPolicy,
      capability,
    });
    if (program.kind === 'none') {
      throw new Error('terminal animation: graphical capability produced no program');
    }

    const frameCache = new Map();
    const readCachedFrame = (path) => {
      if (!frameCache.has(path)) frameCache.set(path, Buffer.from(readFrame(path)));
      return frameCache.get(path);
    };
    const placement = {
      kind: 'virtual',
      ...boxFor(readCachedFrame(intent.sprite.terminal), intent.sprite.rows),
    };
    const lifecycle = capability === GRAPHICS_CAPABILITY.STATIC
      || bindingIntent === null
      || bindingIntent.motionPolicy === 'off'
      || prev === null
      || processChanged
      ? 'create'
      : 'update';
    graphics = encode(program, {
      id: imageIdFor(intent.sessionId),
      placement,
      lifecycle,
      readFrame: readCachedFrame,
    }).bytes;
  }

  // The byte plan is complete before the fd is opened. Asset validation,
  // planning, encoding, and program-limit checks therefore cannot strand a
  // partial image or OSC sequence on the coding agent's terminal.
  const bytes = Buffer.concat([graphics, Buffer.from(presentation)]);

  if (presentation.length === 0 && graphics.length === 0) return false;

  // UNCHANGED BELOW -- and the symmetry is the argument for reading the environ at
  // all. `envOf` reads /proc/<agentPid>/environ; `ttyFdPath` opens
  // /proc/<agentPid>/fd/1. Same process, two facts: what terminal it is, and where
  // its screen is. If the second path is the only one that can reach the user
  // (spike Finding A: /dev/tty failed 1507 of 1507), then the first is the only one
  // that can describe them.
  let fd;
  try {
    fd = open(ttyFdPath(intent.pid), 'a');
  } catch {
    return;   // no such process, or no fd 1 to open — nothing to paint, not an error
  }
  try {
    // open() succeeding is NOT evidence the fd is a terminal: in 370 of 1507
    // spike samples it belonged to a daemon whose stdout is a pipe or a log
    // file. Writing OSC escapes there would inject escape bytes into whatever
    // is reading that stream, silently. isatty() is not a refinement of the
    // path above; it is the actual gate.
    if (!checkTty(fd)) return;
    return writeAllSync(bytes, { fd, write });
  } finally {
    close(fd);
  }
}
