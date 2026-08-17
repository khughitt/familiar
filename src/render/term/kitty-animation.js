import { planAnimation } from '../../animation/program.js';
import { pngSize, STATES } from 'familiar-theme';

const CHUNK = 4096;
const FRAME_MAX = 128;
const ENCODED_BYTES_MAX = 8 * 1024 * 1024;
const DECODED_BYTES_MAX = 32 * 1024 * 1024;
const UINT32_MAX = 4_294_967_295;
const TRANSPARENT_RGBA = Buffer.alloc(4);
// This fixed seed gives all twenty idle holds five decimal digits. Hold values
// change no frame or payload bytes, so their maximum wire width is the only
// seed-dependent property preflight must exercise.
const PREFLIGHT_SESSION_ID = 'preflight-68';
const PREFLIGHT_PLACEMENT = Object.freeze({
  kind: 'virtual',
  cols: UINT32_MAX,
  rows: UINT32_MAX,
});

export class KittyProgramLimitError extends Error {
  constructor(limit, actual, maximum) {
    super(`kitty animation: ${limit} ${actual} exceeds the program limit ${maximum}`);
    this.name = 'KittyProgramLimitError';
    this.limit = limit;
    this.actual = actual;
    this.maximum = maximum;
  }
}

function assertUint32(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > UINT32_MAX) {
    throw new Error(`kitty animation: ${name} must be an integer in 1..${UINT32_MAX}`);
  }
}

function assertPlacement(placement) {
  if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
    throw new Error('kitty animation: placement must be an object');
  }
  if (placement.kind !== 'virtual' && placement.kind !== 'normal') {
    throw new Error(`kitty animation: unknown placement kind ${JSON.stringify(placement.kind)}`);
  }
  assertUint32(placement.cols, 'placement cols');
  assertUint32(placement.rows, 'placement rows');
}

function assertLifecycle(lifecycle) {
  if (lifecycle !== 'create' && lifecycle !== 'update') {
    throw new Error(`kitty animation: lifecycle must be exactly "create" or "update"; got ${JSON.stringify(lifecycle)}`);
  }
}

function apc(control, payload = null) {
  return Buffer.from(`\x1b_G${control}${payload === null ? '' : `;${payload}`}\x1b\\`);
}

function payloadCommands(payload, { control, continuationAction }) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length === 0) {
    throw new Error('kitty animation: refusing an empty frame payload');
  }
  const encoded = payload.toString('base64');
  const commands = [];
  for (let at = 0; at < encoded.length; at += CHUNK) {
    const slice = encoded.slice(at, at + CHUNK);
    const more = at + CHUNK < encoded.length ? 1 : 0;
    let chunkControl;
    if (at === 0) {
      chunkControl = `${control},q=2,m=${more}`;
    } else if (continuationAction === null) {
      chunkControl = `m=${more}`;
    } else {
      chunkControl = `${continuationAction},m=${more}`;
    }
    commands.push(apc(chunkControl, slice));
  }
  return commands;
}

function frameDecodedBytes(frame, context) {
  const value = frame.decodedBytes;
  if ((typeof value !== 'number' && typeof value !== 'bigint')
    || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1))
    || (typeof value === 'bigint' && value < 1n)) {
    throw new Error(`kitty animation: ${context} decodedBytes must be a positive safe integer or bigint`);
  }
  return BigInt(value);
}

function assertFrame(frame, index) {
  const context = `frame ${index}`;
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error(`kitty animation: ${context} must be an object`);
  }
  if (typeof frame.path !== 'string' || frame.path === '') {
    throw new Error(`kitty animation: ${context} path must be a non-empty string`);
  }
  if (!Number.isInteger(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 600_000) {
    throw new Error(`kitty animation: ${context} durationMs must be an integer in 1..600000`);
  }
  frameDecodedBytes(frame, context);
}

function validatedProgram(program) {
  if (!program || typeof program !== 'object' || Array.isArray(program)) {
    throw new Error('kitty animation: program must be an object');
  }
  if (program.kind === 'static') {
    if (typeof program.root !== 'string' || program.root === '') {
      throw new Error('kitty animation: static program root must be a non-empty path');
    }
    return { kind: 'static', root: program.root, frames: 1 };
  }
  if (program.kind !== 'animation') {
    throw new Error(`kitty animation: program kind must be "static" or "animation"; got ${JSON.stringify(program.kind)}`);
  }
  if (program.playback !== 'loop' && program.playback !== 'once') {
    throw new Error(`kitty animation: playback must be exactly "loop" or "once"; got ${JSON.stringify(program.playback)}`);
  }
  if (!Array.isArray(program.frames) || program.frames.length === 0) {
    throw new Error('kitty animation: animated program requires at least its root frame');
  }
  if (program.frames.length > FRAME_MAX) {
    throw new KittyProgramLimitError('frames', program.frames.length, FRAME_MAX);
  }
  program.frames.forEach(assertFrame);
  const root = program.frames[0];
  if (root.ref !== 'root' || root.path !== program.root) {
    throw new Error('kitty animation: first frame must be the program root path');
  }
  const final = program.frames.at(-1);
  if (program.playback === 'once' && (final.ref !== 'root' || final.path !== program.root)) {
    throw new Error('kitty animation: one-shot must stop on its final root frame');
  }
  return { kind: 'animation', root: program.root, frames: program.frames.length };
}

function toNumber(value, name) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`kitty animation: ${name} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function errorMetric(value) {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
}

function decodedStatic(bytes) {
  let size;
  try {
    size = pngSize(bytes);
  } catch (error) {
    throw new Error(`kitty animation: static root is not a complete PNG: ${error.message}`);
  }
  return BigInt(size.w) * BigInt(size.h) * 4n;
}

export function encodeKittyProgram(program, { id, placement, lifecycle, readFrame } = {}) {
  assertLifecycle(lifecycle);
  assertUint32(id, 'image id');
  assertPlacement(placement);
  if (typeof readFrame !== 'function') {
    throw new Error('kitty animation: readFrame must be a function');
  }
  const shape = validatedProgram(program);
  const cache = new Map();
  function read(path) {
    if (cache.has(path)) return cache.get(path);
    let bytes;
    try {
      bytes = Buffer.from(readFrame(path));
    } catch (error) {
      throw new Error(`kitty animation: cannot read frame ${path}: ${error.message}`);
    }
    if (bytes.length === 0) throw new Error(`kitty animation: frame ${path} is empty`);
    cache.set(path, bytes);
    return bytes;
  }

  const commands = [];
  const fullFramesByPath = new Map();
  let decodedBytes = 0n;
  let rootDecoded;

  if (shape.kind === 'animation') {
    rootDecoded = frameDecodedBytes(program.frames[0], 'root frame');
  }
  const rootBytes = read(shape.root);
  if (shape.kind === 'static') rootDecoded = decodedStatic(rootBytes);

  if (lifecycle === 'create') {
    const placementControl = placement.kind === 'virtual'
      ? `a=T,U=1,f=100,i=${id},c=${placement.cols},r=${placement.rows}`
      : `a=t,f=100,i=${id}`;
    commands.push(...payloadCommands(rootBytes, {
      control: placementControl,
      continuationAction: null,
    }));
  } else {
    commands.push(apc(`a=a,i=${id},s=1,q=2`));
    for (let frameNumber = FRAME_MAX; frameNumber >= 2; frameNumber -= 1) {
      commands.push(apc(`a=d,d=f,i=${id},r=${frameNumber},q=2`));
    }
    const gap = shape.kind === 'animation' ? `,z=${program.frames[0].durationMs}` : '';
    commands.push(...payloadCommands(rootBytes, {
      control: `a=f,f=100,i=${id}${gap}`,
      continuationAction: 'a=f',
    }));
    commands.push(apc(`a=c,i=${id},r=2,c=1,C=1,q=2`));
    commands.push(apc(`a=d,d=f,i=${id},r=2,q=2`));
  }
  decodedBytes += rootDecoded;
  fullFramesByPath.set(shape.root, Object.freeze({ frameNumber: 1, decodedBytes: rootDecoded }));

  if (shape.kind === 'animation') {
    commands.push(apc(`a=a,i=${id},r=1,z=${program.frames[0].durationMs},q=2`));
    for (let index = 1; index < program.frames.length; index += 1) {
      const frame = program.frames[index];
      const decoded = frameDecodedBytes(frame, `frame ${index}`);
      const base = fullFramesByPath.get(frame.path);
      if (base) {
        if (base.decodedBytes !== decoded) {
          throw new Error(`kitty animation: repeated path ${frame.path} changed decodedBytes metadata`);
        }
        commands.push(...payloadCommands(TRANSPARENT_RGBA, {
          control: `a=f,f=32,i=${id},s=1,v=1,c=${base.frameNumber},z=${frame.durationMs}`,
          continuationAction: 'a=f',
        }));
        decodedBytes += BigInt(TRANSPARENT_RGBA.length);
      } else {
        const bytes = read(frame.path);
        commands.push(...payloadCommands(bytes, {
          control: `a=f,f=100,i=${id},z=${frame.durationMs}`,
          continuationAction: 'a=f',
        }));
        decodedBytes += decoded;
        fullFramesByPath.set(frame.path, Object.freeze({
          frameNumber: index + 1,
          decodedBytes: decoded,
        }));
      }
    }
    const loops = program.playback === 'loop' ? 1 : 2;
    commands.push(apc(`a=a,i=${id},s=3,v=${loops},q=2`));
  }

  if (decodedBytes > BigInt(DECODED_BYTES_MAX)) {
    throw new KittyProgramLimitError(
      'decodedBytes',
      errorMetric(decodedBytes),
      DECODED_BYTES_MAX,
    );
  }
  const bytes = Buffer.concat(commands);
  if (bytes.length > ENCODED_BYTES_MAX) {
    throw new KittyProgramLimitError('encodedBytes', bytes.length, ENCODED_BYTES_MAX);
  }
  return {
    bytes,
    metrics: {
      encodedBytes: bytes.length,
      decodedBytes: toNumber(decodedBytes, 'decodedBytes'),
      commands: commands.length,
      frames: shape.frames,
    },
  };
}

function mergeWorst(worst, metrics) {
  return {
    encodedBytes: Math.max(worst.encodedBytes, metrics.encodedBytes),
    decodedBytes: Math.max(worst.decodedBytes, metrics.decodedBytes),
    commands: Math.max(worst.commands, metrics.commands),
    frames: Math.max(worst.frames, metrics.frames),
  };
}

export function preflightKittyPrograms(set, { memberId, roots, readFrame } = {}) {
  if (typeof memberId !== 'string' || memberId === '') {
    throw new Error('kitty animation preflight: memberId must be a non-empty string');
  }
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    throw new Error(`kitty animation preflight: member "${memberId}" roots must be an object`);
  }
  if (typeof readFrame !== 'function') {
    throw new Error(`kitty animation preflight: member "${memberId}" readFrame must be a function`);
  }

  const programs = new Map();
  let worst = { encodedBytes: 0, decodedBytes: 0, commands: 0, frames: 0 };
  for (const state of STATES) {
    const root = roots[state];
    if (typeof root !== 'string' || root === '') {
      throw new Error(`kitty animation preflight: member "${memberId}" is missing root for state "${state}"`);
    }
    const program = planAnimation({
      set,
      root,
      state,
      sessionId: PREFLIGHT_SESSION_ID,
      policy: 'full',
      capability: 'kitty-animation',
    });
    programs.set(state, program);
    for (const lifecycle of ['create', 'update']) {
      const encoded = encodeKittyProgram(program, {
        id: UINT32_MAX,
        placement: PREFLIGHT_PLACEMENT,
        lifecycle,
        readFrame,
      });
      worst = mergeWorst(worst, encoded.metrics);
    }
  }
  return { programs, worst };
}
