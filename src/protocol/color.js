export const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function assertHexColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new Error(`not a #rrggbb colour: ${JSON.stringify(value)}`);
  }
  return value;
}

function rgbChannels(hex) {
  assertHexColor(hex);
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
}

export function hexToHsl(hex) {
  const [r, g, b] = rgbChannels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };

  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: delta / (1 - Math.abs(2 * l - 1)) * 100, l: l * 100 };
}

export function oklchChroma(hex) {
  const [r, g, b] = rgbChannels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  // Björn Ottosson's linear sRGB → OKLab matrices; chroma is hypot(a, b).
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return Math.hypot(a, labB);
}
