// Codex owns pet rendering, timing, placement, and turn-state selection. Familiar's
// integration is therefore an offline compiler: canonical theme animation becomes one
// native spritesheet and an explicit manifest, with no terminal escape output here.

// Measured against Codex 0.144.5. Other geometries fail silently, so this is a contract,
// not a tunable default.
export const FRAME = Object.freeze({ width: 192, height: 208, columns: 8, rows: 9 });
export const SPRITESHEET_PATH = 'assets/sheet.png';

const OCCUPIED = Object.freeze({
  idle: Object.freeze([0, 1, 2, 3, 4, 5]),
  running: 6,
  waiting: 7,
  review: Object.freeze([8, 9, 10, 11, 12, 13]),
  failed: Object.freeze([14, 15, 16, 17, 18, 19]),
});

function totalDuration(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('codex pets: timeline must contain at least one frame');
  }
  let total = 0;
  for (const [index, frame] of frames.entries()) {
    if (!Number.isInteger(frame?.durationMs) || frame.durationMs <= 0) {
      throw new Error(`codex pets: timeline frame ${index} has invalid duration ${String(frame?.durationMs)}`);
    }
    total += frame.durationMs;
  }
  return total;
}

function frameAt(frames, instant, duration = totalDuration(frames)) {
  if (!Number.isFinite(instant) || instant < 0 || instant > duration) {
    throw new Error(`codex pets: sample instant ${String(instant)} is outside 0..${duration}`);
  }
  if (instant === duration) return frames.at(-1);
  let end = 0;
  for (const frame of frames) {
    end += frame.durationMs;
    if (instant < end) return frame;
  }
  throw new Error('codex pets: timeline sampling did not select a frame');
}

// Duration-weighted sampling, independent of how many frames the author supplied. Endpoints
// preserve the required root -> motion -> root contract; internal sampling is also exposed for
// native surfaces that own a fixed number of non-endpoint cells.
export function sampleTimeline(frames, count, { includeEndpoints } = { includeEndpoints: true }) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`codex pets: sample count must be a positive integer (found ${String(count)})`);
  }
  if (includeEndpoints !== true && includeEndpoints !== false) {
    throw new Error('codex pets: includeEndpoints must be a boolean');
  }
  if (includeEndpoints && count < 2) {
    throw new Error('codex pets: endpoint sampling requires at least two samples');
  }
  const duration = totalDuration(frames);
  return Array.from({ length: count }, (_, index) => {
    const instant = includeEndpoints
      ? index * duration / (count - 1)
      : (index + 1) * duration / (count + 1);
    return frameAt(frames, instant, duration);
  });
}

// Box-filter fit, aspect preserved, centred horizontally, anchored to the floor. Alpha remains
// binary so the resample cannot add a halo against Codex's unknown terminal background.
export function fitFrame({ w, h, buf }, { width, height }) {
  const scale = Math.max(w / width, h / height);
  const dw = Math.max(1, Math.round(w / scale));
  const dh = Math.max(1, Math.round(h / scale));
  const ox = (width - dw) >> 1;
  const oy = height - dh;
  const out = new Uint8Array(width * height * 4);

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
      const y0 = Math.floor(y * scale);
      const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * scale)));

      let r = 0, g = 0, b = 0, alpha = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) * 4;
          n++;
          if (buf[i + 3] === 0) continue;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; alpha += buf[i + 3];
        }
      }
      if (!n) continue;
      const covered = alpha / 255;
      if (covered < n * 0.5) continue;

      const d = ((y + oy) * width + (x + ox)) * 4;
      out[d] = Math.round(r / covered);
      out[d + 1] = Math.round(g / covered);
      out[d + 2] = Math.round(b / covered);
      out[d + 3] = 255;
    }
  }
  return out;
}

function clipFor(animationSet, role) {
  const clip = animationSet.clips?.get(role);
  if (!clip) throw new Error(`codex pets: clips animation set is missing role "${role}"`);
  return clip;
}

function requiredRoots(roots) {
  const states = ['idle', 'working', 'done', 'error'];
  const missing = states.filter((state) => !roots?.[state]);
  if (missing.length) {
    throw new Error(`codex pets: no sprite for ${missing.join(', ')} — every occupied state needs a root`);
  }
}

function sampledFrames({ animationSet, roots, motionPolicy, readFrame }) {
  requiredRoots(roots);
  if (motionPolicy !== 'full' && motionPolicy !== 'reduced') {
    throw new Error(`codex pets: motionPolicy must be full or reduced (found ${JSON.stringify(motionPolicy)})`);
  }
  if (animationSet?.kind !== 'static' && animationSet?.kind !== 'clips') {
    throw new Error(`codex pets: animation set kind must be static or clips (found ${JSON.stringify(animationSet?.kind)})`);
  }

  if (animationSet.kind === 'static' || motionPolicy === 'reduced') {
    return [
      ...Array(6).fill(roots.idle),
      roots.working,
      roots.working,
      ...Array(6).fill(roots.done),
      ...Array(6).fill(roots.error),
    ];
  }
  if (typeof readFrame !== 'function') {
    throw new Error('codex pets: full clips compilation requires readFrame(path)');
  }

  const idle = clipFor(animationSet, 'idle-ambient');
  const working = clipFor(animationSet, 'working-loop');
  const done = clipFor(animationSet, 'done-enter');
  const error = clipFor(animationSet, 'error-enter');
  const workingFrames = working.frames.slice(0, -1);
  const workingDuration = totalDuration(workingFrames);
  const selected = [
    ...sampleTimeline(idle.frames, 6, { includeEndpoints: true }).map((frame) => [idle, frame]),
    [working, frameAt(workingFrames, workingDuration / 4, workingDuration)],
    [working, frameAt(workingFrames, workingDuration * 3 / 4, workingDuration)],
    ...sampleTimeline(done.frames, 6, { includeEndpoints: true }).map((frame) => [done, frame]),
    ...sampleTimeline(error.frames, 6, { includeEndpoints: true }).map((frame) => [error, frame]),
  ];

  const cache = new Map();
  return selected.map(([clip, frame]) => {
    if (frame.ref === 'root') return roots[clip.state];
    if (!cache.has(frame.path)) {
      const decoded = readFrame(frame.path);
      if (!decoded) throw new Error(`codex pets: animation frame is unreadable at ${frame.path}`);
      cache.set(frame.path, decoded);
    }
    return cache.get(frame.path);
  });
}

// Pure sheet compiler. Cells 20..71 remain zero-filled by construction.
export function spritesheet(input, frame = FRAME) {
  const cells = sampledFrames(input);
  const { width, height, columns, rows } = frame;
  const w = columns * width;
  const h = rows * height;
  const buf = new Uint8Array(w * h * 4);

  cells.forEach((image, index) => {
    const cell = fitFrame(image, frame);
    const ox = (index % columns) * width;
    const oy = ((index / columns) | 0) * height;
    for (let y = 0; y < height; y++) {
      const source = y * width * 4;
      const target = ((y + oy) * w + ox) * 4;
      buf.set(cell.subarray(source, source + width * 4), target);
    }
  });
  return { w, h, buf };
}

// Codex overlays custom declarations onto built-ins, so omission is not a safe fallback. Every
// currently reachable semantic track is explicit, including one-frame holds for one-shots.
export function petFile({ id, displayName, description }, frame = FRAME) {
  return {
    id,
    displayName,
    description,
    spritesheetPath: SPRITESHEET_PATH,
    frame: { ...frame },
    animations: {
      idle: { frames: [...OCCUPIED.idle], fps: 1, loop: true },
      running: { frames: [OCCUPIED.running], fps: 1, loop: true },
      waiting: { frames: [OCCUPIED.waiting], fps: 1, loop: true },
      review: {
        frames: [...OCCUPIED.review], fps: 8, loop: false, fallback: 'review-root-hold',
      },
      'review-root-hold': { frames: [OCCUPIED.review.at(-1)], fps: 1, loop: true },
      failed: {
        frames: [...OCCUPIED.failed], fps: 8, loop: false, fallback: 'failed-root-hold',
      },
      'failed-root-hold': { frames: [OCCUPIED.failed.at(-1)], fps: 1, loop: true },
    },
  };
}
