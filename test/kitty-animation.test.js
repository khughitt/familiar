import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { STATES, crc32 } from 'familiar-theme';
import {
  KittyProgramLimitError,
  encodeKittyProgram,
  preflightKittyPrograms,
} from '../src/render/term/kitty-animation.js';

const ID = 15_825_425;
const VIRTUAL = Object.freeze({ kind: 'virtual', cols: 4, rows: 12 });
const NORMAL = Object.freeze({ kind: 'normal', cols: 4, rows: 12 });
const MAX_PLACEMENT = Object.freeze({ kind: 'virtual', cols: 4_294_967_295, rows: 4_294_967_295 });

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function tinyPng(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function frame(ref, path, durationMs, decodedBytes = 16) {
  return Object.freeze({ ref, path, durationMs, width: 2, height: 2, decodedBytes });
}

function animationProgram(playback = 'loop') {
  return Object.freeze({
    kind: 'animation',
    state: playback === 'loop' ? 'working' : 'done',
    playback,
    root: '/root.png',
    frames: Object.freeze([
      frame('root', '/root.png', 100),
      frame('motion', '/motion.png', 120),
      frame('root', '/root.png', 140),
    ]),
  });
}

function staticProgram(root = '/root.png') {
  return Object.freeze({ kind: 'static', state: 'needs-input', root });
}

function reader(entries = {}) {
  const values = new Map(Object.entries({
    '/root.png': Buffer.from([0xfb, 0xff, 0xbf, 0x01, 0x02]),
    '/motion.png': Buffer.from([0x03, 0xfb, 0xff, 0xbf]),
    ...entries,
  }));
  const calls = [];
  const readFrame = (path) => {
    calls.push(path);
    if (!values.has(path)) throw new Error(`missing test frame ${path}`);
    return values.get(path);
  };
  return { readFrame, calls };
}

function commandsOf(bytes) {
  const wire = Buffer.from(bytes).toString('ascii');
  const commands = [];
  let at = 0;
  while (at < wire.length) {
    assert.equal(wire.slice(at, at + 3), '\x1b_G', `non-APC bytes at ${at}`);
    const end = wire.indexOf('\x1b\\', at + 3);
    assert.notEqual(end, -1, `unterminated APC at ${at}`);
    const body = wire.slice(at + 3, end);
    const separator = body.indexOf(';');
    commands.push({
      control: separator === -1 ? body : body.slice(0, separator),
      payload: separator === -1 ? null : body.slice(separator + 1),
    });
    at = end + 2;
  }
  return commands;
}

function keys(control) {
  return Object.fromEntries(control.split(',').map((field) => {
    const separator = field.indexOf('=');
    return [field.slice(0, separator), field.slice(separator + 1)];
  }));
}

function encode(program, overrides = {}) {
  const source = overrides.source ?? reader();
  return {
    source,
    result: encodeKittyProgram(program, {
      id: ID,
      placement: VIRTUAL,
      lifecycle: 'create',
      readFrame: source.readFrame,
      ...overrides,
      source: undefined,
    }),
  };
}

test('create freezes the accepted virtual root/frame/start bytes and exact metrics', () => {
  const { source, result } = encode(animationProgram('loop'));
  const commands = commandsOf(result.bytes);

  assert.deepEqual(commands.map(({ control }) => control), [
    `a=T,U=1,f=100,i=${ID},c=4,r=12,q=2,m=0`,
    `a=a,i=${ID},r=1,z=100,q=2`,
    `a=f,f=100,i=${ID},z=120,q=2,m=0`,
    `a=f,f=32,i=${ID},s=1,v=1,c=1,z=140,q=2,m=0`,
    `a=a,i=${ID},s=3,v=1,q=2`,
  ]);
  assert.deepEqual(commands.map(({ payload }) => payload), [
    Buffer.from([0xfb, 0xff, 0xbf, 0x01, 0x02]).toString('base64'),
    null,
    Buffer.from([0x03, 0xfb, 0xff, 0xbf]).toString('base64'),
    Buffer.alloc(4).toString('base64'),
    null,
  ]);
  assert.deepEqual(source.calls, ['/root.png', '/motion.png']);
  assert.deepEqual(result.metrics, {
    encodedBytes: 226,
    decodedBytes: 36,
    commands: 5,
    frames: 3,
  });
});

test('update preserves the image and placement while staging the root before new frames', () => {
  const { result } = encode(animationProgram('loop'), { lifecycle: 'update', placement: NORMAL });
  const commands = commandsOf(result.bytes);
  const controls = commands.map(({ control }) => control);

  assert.equal(controls[0], `a=a,i=${ID},s=1,q=2`);
  assert.deepEqual(
    controls.slice(1, 128),
    Array.from({ length: 127 }, (_, index) => `a=d,d=f,i=${ID},r=${128 - index},q=2`),
  );
  assert.equal(controls[128], `a=f,f=100,i=${ID},z=100,q=2,m=0`);
  assert.equal(controls[129], `a=c,i=${ID},r=2,c=1,C=1,q=2`);
  assert.equal(controls[130], `a=d,d=f,i=${ID},r=2,q=2`);
  assert.deepEqual(controls.slice(131), [
    `a=a,i=${ID},r=1,z=100,q=2`,
    `a=f,f=100,i=${ID},z=120,q=2,m=0`,
    `a=f,f=32,i=${ID},s=1,v=1,c=1,z=140,q=2,m=0`,
    `a=a,i=${ID},s=3,v=1,q=2`,
  ]);
  assert.equal(controls.length, 135);
  assert.ok(controls.every((control) => !control.startsWith('a=T')));
  assert.ok(controls.every((control) => !control.includes('d=F')));
  assert.deepEqual(result.metrics, {
    encodedBytes: 4_397,
    decodedBytes: 36,
    commands: 135,
    frames: 3,
  });
});

test('normal creation stores only; virtual creation owns its placeholder placement', () => {
  const source = () => reader({ '/root.png': tinyPng() });
  const virtual = commandsOf(encode(staticProgram(), { source: source() }).result.bytes);
  const normal = commandsOf(encode(staticProgram(), { placement: NORMAL, source: source() }).result.bytes);

  assert.equal(virtual[0].control, `a=T,U=1,f=100,i=${ID},c=4,r=12,q=2,m=0`);
  assert.equal(normal[0].control, `a=t,f=100,i=${ID},q=2,m=0`);
  assert.deepEqual(keys(normal[0].control), {
    a: 't', f: '100', i: String(ID), q: '2', m: '0',
  });
  assert.equal(virtual[0].payload, normal[0].payload);

  for (const placement of [VIRTUAL, NORMAL]) {
    const controls = commandsOf(encode(staticProgram(), {
      lifecycle: 'update', placement, source: source(),
    }).result.bytes)
      .map(({ control }) => control);
    assert.ok(controls.every((control) => !control.startsWith('a=T')));
    assert.ok(controls.every((control) => !control.includes('U=1')));
    assert.ok(controls.every((control) => !control.includes(',c=4,r=12')));
  }
});

test('one-shot retains its final root and uses the measured stop-on-last-frame count', () => {
  const controls = commandsOf(encode(animationProgram('once')).result.bytes)
    .map(({ control }) => control);
  assert.ok(controls.includes(`a=f,f=32,i=${ID},s=1,v=1,c=1,z=140,q=2,m=0`));
  assert.equal(controls.at(-1), `a=a,i=${ID},s=3,v=2,q=2`);
  assert.ok(controls.every((control) => !control.includes('v=0')));

  for (const playback of [0, 'zero', 'infinite']) {
    assert.throws(
      () => encode({ ...animationProgram(), playback }),
      /playback/i,
    );
  }
});

test('one-shot refuses to stop on anything except its final root', () => {
  const program = animationProgram('once');
  assert.throws(
    () => encode({
      ...program,
      frames: [...program.frames.slice(0, -1), frame('motion', '/motion.png', 140)],
    }),
    /one-shot.*final root/i,
  );
});

test('each distinct path is read and transferred once; every repeat directly references its full frame', () => {
  const program = {
    ...animationProgram(),
    frames: [
      frame('root', '/root.png', 10),
      frame('motion', '/motion.png', 11),
      frame('root', '/root.png', 12),
      frame('motion', '/motion.png', 13),
      frame('root', '/root.png', 14),
    ],
  };
  const { source, result } = encode(program);
  const frameControls = commandsOf(result.bytes)
    .filter(({ control }) => control.startsWith('a=f'))
    .map(({ control, payload }) => ({ control, payload }));

  assert.deepEqual(source.calls, ['/root.png', '/motion.png']);
  assert.match(frameControls[0].control, /f=100.*z=11/);
  assert.deepEqual(frameControls.slice(1).map(({ control }) => control), [
    `a=f,f=32,i=${ID},s=1,v=1,c=1,z=12,q=2,m=0`,
    `a=f,f=32,i=${ID},s=1,v=1,c=2,z=13,q=2,m=0`,
    `a=f,f=32,i=${ID},s=1,v=1,c=1,z=14,q=2,m=0`,
  ]);
  assert.ok(frameControls.slice(1).every(({ payload }) => payload === Buffer.alloc(4).toString('base64')));
  assert.ok(frameControls.every(({ control }) => !/c=3|c=4/.test(control)), 'a reuse referenced another reuse');
});

test('chunk controls match Kitty 0.47.4 and every base64 slice is bounded', () => {
  const large = Buffer.alloc(5_000, 0xfb);
  const source = reader({ '/root.png': large, '/motion.png': large });
  const commands = commandsOf(encode(animationProgram(), { source }).result.bytes);
  const payloadCommands = commands.filter(({ payload }) => payload !== null);

  assert.ok(payloadCommands.every(({ payload }) => payload.length <= 4096));
  assert.match(payloadCommands[0].control, /q=2,m=1$/);
  assert.equal(payloadCommands[1].control, 'm=0');
  const fullFrame = payloadCommands.findIndex(({ control }) => control.startsWith('a=f,f=100'));
  assert.notEqual(fullFrame, -1);
  assert.match(payloadCommands[fullFrame].control, /q=2,m=1$/);
  assert.equal(payloadCommands[fullFrame + 1].control, 'a=f,m=0');
  for (const { control } of commands) {
    if (control === 'm=0' || control === 'm=1' || control === 'a=f,m=0' || control === 'a=f,m=1') {
      assert.doesNotMatch(control, /q=/);
    } else {
      assert.match(control, /(?:^|,)q=2(?:,|$)/);
    }
  }
});

test('every control that identifies an image uses the same stable id', () => {
  for (const lifecycle of ['create', 'update']) {
    const controls = commandsOf(encode(animationProgram(), { lifecycle }).result.bytes)
      .map(({ control }) => control)
      .filter((control) => !['m=0', 'm=1', 'a=f,m=0', 'a=f,m=1'].includes(control));
    assert.ok(controls.length > 0);
    assert.ok(controls.every((control) => keys(control).i === String(ID)));
  }
});

test('rejects missing bytes and malformed boundary inputs instead of emitting partial plans', () => {
  assert.throws(
    () => encode(staticProgram(), { source: reader({ '/root.png': Buffer.alloc(0) }) }),
    /empty/i,
  );
  for (const lifecycle of [undefined, 'replace', '']) {
    assert.throws(
      () => encodeKittyProgram(staticProgram(), {
        id: ID,
        placement: VIRTUAL,
        lifecycle,
        readFrame: reader().readFrame,
      }),
      /lifecycle/i,
    );
  }
});

test('128 frames and exactly 32 MiB decoded pass; one frame or decoded byte over fails by name', () => {
  const decodedAtLimit = 32 * 1024 * 1024;
  const rootDecoded = decodedAtLimit - 127 * 4;
  const repeats = Array.from(
    { length: 127 },
    (_, index) => frame('root', '/root.png', index + 1, rootDecoded),
  );
  const atLimit = {
    ...animationProgram(),
    frames: [frame('root', '/root.png', 1, rootDecoded), ...repeats],
  };
  const accepted = encode(atLimit).result;
  assert.equal(accepted.metrics.frames, 128);
  assert.equal(accepted.metrics.decodedBytes, decodedAtLimit);

  const overFrames = { ...atLimit, frames: [...atLimit.frames, frame('root', '/root.png', 1)] };
  const source = reader();
  assert.throws(
    () => encode(overFrames, { source }),
    (error) => error instanceof KittyProgramLimitError && error.limit === 'frames',
  );
  assert.deepEqual(source.calls, [], 'frame-count failure read bytes before rejecting the program');

  const overDecoded = {
    ...atLimit,
    frames: [
      frame('root', '/root.png', 1, rootDecoded + 1),
      ...repeats.map((current) => ({ ...current, decodedBytes: rootDecoded + 1 })),
    ],
  };
  assert.throws(
    () => encode(overDecoded),
    (error) => error instanceof KittyProgramLimitError && error.limit === 'decodedBytes',
  );
});

test('decoded sizes beyond Number.MAX_SAFE_INTEGER remain a named limit error with bigint actual', () => {
  const source = reader({ '/root.png': tinyPng(4_294_967_295, 4_294_967_295) });
  assert.throws(
    () => encode(staticProgram(), { source }),
    (error) => error instanceof KittyProgramLimitError
      && error.limit === 'decodedBytes'
      && typeof error.actual === 'bigint'
      && error.actual === 4_294_967_295n * 4_294_967_295n * 4n,
  );
});

function encodedBoundaryProgram(rootBytes, rootDecodedBytes = 16) {
  return {
    ...animationProgram(),
    root: '/boundary.png',
    frames: [
      frame('root', '/boundary.png', 10, rootDecodedBytes),
      frame('root', '/boundary.png', 10, rootDecodedBytes),
    ],
    source: reader({ '/boundary.png': rootBytes }),
  };
}

test('exactly 8 MiB encoded passes and the next reachable byte over fails before bytes return', () => {
  // With two 10ms root occurrences, maximum decimal controls, and the accepted
  // 4096-byte chunking, this raw size lands on exactly 8 MiB of APC bytes.
  const at = encodedBoundaryProgram(Buffer.alloc(6_277_519));
  const accepted = encode(at, {
    source: at.source,
    id: 4_294_967_295,
    placement: MAX_PLACEMENT,
  }).result;
  assert.equal(accepted.metrics.encodedBytes, 8_388_608);

  const over = {
    ...animationProgram(),
    root: '/boundary.png',
    frames: [frame('root', '/boundary.png', 100)],
    source: reader({ '/boundary.png': Buffer.alloc(6_277_564) }),
  };
  assert.throws(
    () => encode(over, {
      source: over.source,
      id: 4_294_967_295,
      placement: MAX_PLACEMENT,
    }),
    (error) => error instanceof KittyProgramLimitError
      && error.limit === 'encodedBytes'
      && error.actual === 8_388_609,
  );
});

function preflightSet() {
  const root = (state) => `/sprites/${state}.png`;
  const shot = (state, role) => Object.freeze({
    state,
    playback: 'once',
    frames: Object.freeze([
      frame('root', root(state), 100),
      frame(`${role}-motion`, `/animation/${role}.png`, 120),
      frame('root', root(state), 100),
    ]),
  });
  return Object.freeze({
    kind: 'clips',
    clips: new Map([
      ['idle-ambient', shot('idle', 'idle-ambient')],
      ['working-loop', Object.freeze({
        state: 'working',
        playback: 'loop',
        frames: Object.freeze([
          frame('root', root('working'), 100),
          frame('working-motion', '/animation/working-loop.png', 120),
          frame('root', root('working'), 100),
        ]),
      })],
      ['done-enter', shot('done', 'done-enter')],
      ['error-enter', shot('error', 'error-enter')],
      ['idle-special', shot('idle', 'idle-special')],
    ]),
  });
}

test('preflight plans all six flagship states and proves create plus update with worst metadata', () => {
  const set = preflightSet();
  const roots = Object.fromEntries(STATES.map((state) => [state, `/sprites/${state}.png`]));
  const calls = [];
  const result = preflightKittyPrograms(set, {
    memberId: 'ginger-tabby',
    roots,
    readFrame(path) {
      calls.push(path);
      return tinyPng();
    },
  });

  assert.ok(result.programs instanceof Map);
  assert.deepEqual([...result.programs.keys()], STATES);
  assert.equal(result.programs.get('needs-input').kind, 'static');
  assert.equal(result.programs.get('needs-approval').kind, 'static');
  assert.equal(result.programs.get('idle').kind, 'animation');

  const authoredFrames = new Set(
    [...set.clips.values()].flatMap((clip) => clip.frames),
  );
  const holds = result.programs.get('idle').frames.filter((current) => !authoredFrames.has(current));
  assert.equal(holds.length, 20);
  assert.ok(holds.every(({ durationMs }) => durationMs >= 10_000 && durationMs <= 20_000));

  let independentWorst = { encodedBytes: 0, decodedBytes: 0, commands: 0, frames: 0 };
  for (const program of result.programs.values()) {
    for (const lifecycle of ['create', 'update']) {
      const { metrics } = encodeKittyProgram(program, {
        id: 4_294_967_295,
        placement: MAX_PLACEMENT,
        lifecycle,
        readFrame: () => tinyPng(),
      });
      independentWorst = Object.fromEntries(
        Object.keys(independentWorst).map((key) => [
          key,
          Math.max(independentWorst[key], metrics[key]),
        ]),
      );
    }
  }
  assert.deepEqual(result.worst, independentWorst);
  for (const state of STATES) {
    assert.ok(calls.filter((path) => path === roots[state]).length >= 2, `${state} was not encoded for both lifecycles`);
  }
});
