import { slotSpec } from '../protocol/slot-hues.js';

// An identity owns a HUE; the active colorscheme owns TONE. Ember stays
// unmistakably warm-orange under every scheme, but sits *inside* the palette
// rather than pasted on top of it.
const ANCHORS = {
  dark: { shadow: 36, base: 58, light: 73, highlight: 86, backdrop: 10 },
  light: { shadow: 30, base: 46, light: 62, highlight: 76, backdrop: 94 },
};

// The backdrop is the terminal background (OSC 11). It carries the identity hue
// at low saturation and extreme lightness — a tint you can still read text on.
const BACKDROP_SAT_SCALE = 0.35;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function hslToHex(h, s, l) {
  const S = s / 100;
  const L = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const channel = (v) => Math.round(255 * v).toString(16).padStart(2, '0');
  return `#${channel(f(0))}${channel(f(8))}${channel(f(4))}`;
}

export function assertTone(tone) {
  if (!tone || typeof tone !== 'object') {
    throw new Error('missing SchemeTone: an integration must supply { mode, satScale }');
  }
  if (tone.mode !== 'dark' && tone.mode !== 'light') {
    throw new Error(`SchemeTone.mode must be "dark" or "light", got: ${tone.mode}`);
  }
  if (typeof tone.satScale !== 'number' || !(tone.satScale >= 0 && tone.satScale <= 2)) {
    throw new Error(`SchemeTone.satScale must be a number in 0..2, got: ${tone.satScale}`);
  }
  return tone;
}

export function ramp(hue, sat, tone) {
  assertTone(tone);
  const anchors = ANCHORS[tone.mode];
  const s = clamp(sat * tone.satScale, 0, 100);
  return {
    shadow: hslToHex(hue, s, anchors.shadow),
    base: hslToHex(hue, s, anchors.base),
    light: hslToHex(hue, s, anchors.light),
    highlight: hslToHex(hue, s, anchors.highlight),
    backdrop: hslToHex(hue, clamp(s * BACKDROP_SAT_SCALE, 0, 100), anchors.backdrop),
  };
}

export function identityColors(slot, tone) {
  const spec = slotSpec(slot);
  return ramp(spec.hue, spec.sat, tone);
}
