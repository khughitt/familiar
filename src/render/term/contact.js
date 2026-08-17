// COMPOSE, DO NOT PLACE. Six sprites side by side is a layout problem, and kitty.js
// says plainly why it cannot solve it: transmit() sends C=1 and then advances by hand
// with exactly `rows` newlines, so consecutive images always STACK. Putting them in a
// row would need a placement-capable emitter, and writing one to show a contact sheet
// would put cursor arithmetic into the module every live surface depends on.
//
// So the row is built as ONE IMAGE before it reaches the terminal. transmit() is used
// exactly as it already works — one image, stacked — and the horizontal layout is a
// property of the bytes rather than of the cursor. The same composition is what a
// `--out` file wants anyway, so the two paths share it instead of diverging.
//
// PURE, and takes decoded rasters rather than PNG buffers, so the layout can be tested
// without a codec: {w, h, buf} in, {w, h, buf} out. The caller owns decode and encode.

// Bottom-aligned, because every sprite this composes is FLOOR-ANCHORED — compile.mjs
// puts each member's six poses on one canvas sized to the largest, sitting on a shared
// floor. Within a member the frames are therefore identical in size and the alignment
// is a no-op; across members (a grid) it is what keeps the floors on one line instead
// of hanging the short ones from the ceiling.
export function composeStrip(frames, { gap = 0 } = {}) {
  if (!Array.isArray(frames) || !frames.length) {
    throw new Error('contact: a strip needs at least one frame');
  }
  if (!Number.isInteger(gap) || gap < 0) {
    throw new Error(`contact: gap must be a non-negative integer — got ${JSON.stringify(gap)}`);
  }
  const h = Math.max(...frames.map((f) => f.h));
  const w = frames.reduce((sum, f) => sum + f.w, 0) + gap * (frames.length - 1);
  const buf = new Uint8Array(w * h * 4);
  let x0 = 0;
  for (const frame of frames) {
    const dy = h - frame.h;
    for (let y = 0; y < frame.h; y++) {
      for (let x = 0; x < frame.w; x++) {
        const s = (y * frame.w + x) * 4;
        const d = ((y + dy) * w + (x0 + x)) * 4;
        buf[d] = frame.buf[s];
        buf[d + 1] = frame.buf[s + 1];
        buf[d + 2] = frame.buf[s + 2];
        buf[d + 3] = frame.buf[s + 3];
      }
    }
    x0 += frame.w + gap;
  }
  return { w, h, buf };
}

// Rows are LEFT-aligned and the canvas is as wide as the widest row. Centring would
// read better on a poster and worse here: the point of a contact sheet is comparing
// the same state across members, which means column N of every row has to start at the
// same x. Members differ in canvas width, so the columns only line up if the rows all
// start at zero AND every row is built from equal-width frames — which is exactly what
// scaling to a common frame box upstream buys, and why the caller does that.
export function composeGrid(rows, { gap = 0, rowGap = gap } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('contact: a grid needs at least one row');
  }
  const strips = rows.map((frames) => composeStrip(frames, { gap }));
  const w = Math.max(...strips.map((s) => s.w));
  const h = strips.reduce((sum, s) => sum + s.h, 0) + rowGap * (strips.length - 1);
  const buf = new Uint8Array(w * h * 4);
  let y0 = 0;
  for (const strip of strips) {
    for (let y = 0; y < strip.h; y++) {
      const src = y * strip.w * 4;
      const dst = ((y + y0) * w) * 4;
      buf.set(strip.buf.subarray(src, src + strip.w * 4), dst);
    }
    y0 += strip.h + rowGap;
  }
  return { w, h, buf };
}

// NEAREST-NEIGHBOUR, and nothing else will do. This art is drawn on a coarse logical
// grid where one logical pixel is several screen pixels; any smoothing filter averages
// across a block boundary and turns a hard staircase into a gradient — the exact defect
// four rounds of prompt work went into removing. Integer-ratio downscales are the common
// case here and stay exact.
export function scaleTo(frame, { height }) {
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`contact: height must be a positive integer — got ${JSON.stringify(height)}`);
  }
  const w = Math.max(1, Math.round((frame.w * height) / frame.h));
  const buf = new Uint8Array(w * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(frame.h - 1, Math.floor((y * frame.h) / height));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(frame.w - 1, Math.floor((x * frame.w) / w));
      const s = (sy * frame.w + sx) * 4;
      const d = (y * w + x) * 4;
      buf[d] = frame.buf[s];
      buf[d + 1] = frame.buf[s + 1];
      buf[d + 2] = frame.buf[s + 2];
      buf[d + 3] = frame.buf[s + 3];
    }
  }
  return { w, h: height, buf };
}

// One box for every frame on the sheet, so column N lines up down the whole grid. The
// box is the WIDEST scaled frame, not an average: a member cropped wider than its
// neighbours (the persian's flared coat, the meerkat's dig) must not be clipped to make
// the columns tidy. Frames are centred horizontally and sat on the floor.
export function padTo(frame, { width, height }) {
  if (frame.w > width || frame.h > height) {
    throw new Error(`contact: frame ${frame.w}x${frame.h} does not fit a ${width}x${height} box`);
  }
  const buf = new Uint8Array(width * height * 4);
  const dx = Math.floor((width - frame.w) / 2);
  const dy = height - frame.h;
  for (let y = 0; y < frame.h; y++) {
    const src = y * frame.w * 4;
    const dst = ((y + dy) * width + dx) * 4;
    buf.set(frame.buf.subarray(src, src + frame.w * 4), dst);
  }
  return { w: width, h: height, buf };
}
