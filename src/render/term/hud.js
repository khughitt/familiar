// THE HUD: four fixed slots beside the familiar, as a PURE function.
//
// Pure is not an aesthetic choice here. It is what lets test/hud.test.js sweep every state,
// every tone and every theme height with no filesystem and no git -- and that sweep is the
// only thing standing between this file and the failure modes below.
//
// WHY SLOTS ARE FIXED. textLines() (statusline.js) FILTERS EMPTY LINES. So a slot that
// renders as '' does not leave a gap: it pulls every slot below it up one, and compose()
// then re-centres a three-line block against a four-row cat. A missing model would silently
// move the context bar and the state row. Absent data therefore renders as ABSENT -- a
// visible em dash -- and NEVER as an empty string.
//
// WHY EVERY FIELD IS SANITISED HERE. The other half of the same invariant, and the half a
// caller cannot be trusted to remember. A directory name containing a newline would make one
// of these four strings two lines, and no assertion about the ARRAY's length can catch a
// newline inside an element. So sanitize() runs on the way in, unconditionally.
import { sanitize, width, fg, BOLD, RESET } from './sgr.js';

export const RULE = '▎';    // ▎ the gutter
export const ABSENT = '—';  // — this slot's data does not exist
const ELLIPSIS = '…';
const BRANCH = '⎇';         // ⎇
const BAR_FULL = '▰';       // ▰
const BAR_EMPTY = '▱';      // ▱

// Slot 0 is the identity, slot 3 the state. THE ORDER NEVER CHANGES.
export const SLOTS = ['identity', 'model', 'context', 'state'];

// Which slot goes first when the theme is shorter than four rows. pack.js allows rows 1..40
// and DEFAULTS to 12, so "the theme is four rows" is the cats theme's fact, not the system's.
// The model leads because it is the least volatile field; state is last because a one-row
// familiar exists to tell you what it is doing. Stated ONCE, here, rather than implied by the
// order of four ifs.
export const DROP_ORDER = ['model', 'context', 'identity'];

export const GLYPHS = Object.freeze({
  idle: '●',
  working: '⚡',
  'needs-input': '?',
  // UNREACHABLE ON THIS SURFACE. surfaces.md:120 measured the status line disappearing while
  // a permission dialog is up, and the docs say the same. Kept for the other surfaces, and so
  // that GLYPHS covers STATES exactly rather than five of six.
  'needs-approval': '!',
  error: '✕',
  done: '✓',
});

export const CAPS = Object.freeze({ project: 20, branch: 26, model: 52 });
export const BUDGET = 60;
export const BAR_CELLS = 10;

export function truncEnd(text, cap) {
  const s = String(text);
  if (width(s) <= cap) return s;
  let out = '';
  for (const ch of s) {
    if (width(out) + width(ch) + width(ELLIPSIS) > cap) break;
    out += ch;
  }
  return out + ELLIPSIS;
}

// A branch name's TAIL is where the ticket number lives, so a long one loses its MIDDLE.
// Grows from both ends alternately so an odd budget favours the head, which is where the
// `feature/` prefix that tells you what kind of branch it is lives.
export function truncMiddle(text, cap) {
  const s = String(text);
  if (width(s) <= cap) return s;
  const chars = [...s];
  let head = '';
  let tail = '';
  let i = 0;
  let j = chars.length - 1;
  for (let turn = 0; i <= j; turn++) {
    const ch = turn % 2 === 0 ? chars[i] : chars[j];
    if (width(head) + width(tail) + width(ch) + width(ELLIPSIS) > cap) break;
    if (turn % 2 === 0) { head += ch; i++; } else { tail = ch + tail; j--; }
  }
  return head + ELLIPSIS + tail;
}

// IDENTITY OWNS HUE, STATE OWNS URGENCY -- src/protocol/intent.js:12-13, and the reason the ramp is indexed
// by the member's slot while only the STOP is chosen by urgency. A null ramp paints nothing:
// no identity means no hue, and inventing one would be a lie about which project this is.
function penFor(color, urgency) {
  if (!color) {
    return { rule: RULE, project: (s) => s, dim: (s) => s, base: (s) => s, state: (s) => s };
  }
  const wrap = (stop) => (s) => fg(color[stop]) + s + RESET;
  return {
    rule: (urgency === 'demand' ? BOLD + fg(color.highlight) : fg(color.base)) + RULE + RESET,
    project: wrap('light'),
    dim: wrap('shadow'),
    base: wrap('base'),
    state: (s) => (urgency === 'demand'
      ? BOLD + fg(color.highlight) + s + RESET
      : fg(urgency === 'notice' ? color.light : color.base) + s + RESET),
  };
}

function slotBuilders(pen, fields, state) {
  const project = sanitize(fields.project) || ABSENT;
  const branch = sanitize(fields.branch);
  const model = sanitize(fields.model);

  return {
    identity: () => {
      const head = pen.project(truncEnd(project, CAPS.project));
      if (!branch) return `${pen.rule} ${head}`;
      return `${pen.rule} ${head}  ${pen.dim(`${BRANCH} ${truncMiddle(branch, CAPS.branch)}`)}`;
    },

    model: () => `${pen.rule} ${pen.dim(model ? truncEnd(model, CAPS.model) : ABSENT)}`,

    context: () => {
      const pct = fields.usedPercent;
      // ABSENT AND null ARE ONE CASE. The docs say used_percentage "may be null early in the
      // session", so an existence check alone lets null through -- and null formatted naively
      // is the fabricated 0% the spec forbids. The official examples all write `// 0`, which
      // IS that fabrication.
      if (typeof pct !== 'number' || !Number.isFinite(pct)) {
        return `${pen.rule} ${pen.dim(ABSENT)}`;
      }
      const clamped = Math.max(0, Math.min(100, pct));
      // FLOORS, never rounds: one filled cell at 4% would overstate how much room is gone.
      const filled = Math.min(BAR_CELLS, Math.floor((clamped * BAR_CELLS) / 100));
      const bar = pen.base(BAR_FULL.repeat(filled)) + pen.dim(BAR_EMPTY.repeat(BAR_CELLS - filled));
      return `${pen.rule} ${bar}  ${pen.dim(`${Math.floor(clamped)}%`)}`;
    },

    state: () => (state
      ? `${pen.rule} ${pen.state(`${GLYPHS[state]} ${state}`)}`
      : `${pen.rule} ${pen.dim(ABSENT)}`),
  };
}

export function hudLines({ intent, fields, rows = 4 }) {
  const pen = penFor(intent?.color ?? null, intent?.urgency ?? null);
  const build = slotBuilders(pen, fields, intent?.state ?? null);

  const keep = new Set(SLOTS);
  for (const name of DROP_ORDER) {
    if (keep.size <= rows) break;
    keep.delete(name);
  }
  return SLOTS.filter((name) => keep.has(name)).map((name) => build[name]());
}
