import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeAllSync } from '../src/render/term/io.js';

test('writeAllSync returns the bytes accepted by one complete write', () => {
  const calls = [];
  const written = writeAllSync(Buffer.from('abcd'), {
    fd: 7,
    write: (fd, bytes, offset, length) => {
      calls.push({ fd, bytes: bytes.toString(), offset, length });
      return length;
    },
  });
  assert.equal(written, 4);
  assert.deepEqual(calls, [{ fd: 7, bytes: 'abcd', offset: 0, length: 4 }]);
});

test('writeAllSync drains forced short writes without slicing or skipping bytes', () => {
  const chunks = [];
  const accepts = [2, 1, 99];
  const written = writeAllSync(Buffer.from('abcdef'), {
    write: (_fd, bytes, offset, length) => {
      const accepted = Math.min(accepts.shift(), length);
      chunks.push(bytes.subarray(offset, offset + accepted).toString());
      return accepted;
    },
  });
  assert.equal(written, 6);
  assert.deepEqual(chunks, ['ab', 'c', 'def']);
});

test('writeAllSync retries only EINTR at the same offset', () => {
  let calls = 0;
  const written = writeAllSync(Buffer.from('xy'), {
    write: (_fd, _bytes, offset, length) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
      assert.equal(offset, 0);
      return length;
    },
  });
  assert.equal(written, 2);
  assert.equal(calls, 2);
});

test('writeAllSync rejects zero progress and an overrun', () => {
  assert.throws(
    () => writeAllSync(Buffer.from('x'), { write: () => 0 }),
    /zero progress/,
  );
  assert.throws(
    () => writeAllSync(Buffer.from('x'), { write: () => 2 }),
    /overrun/,
  );
});

test('writeAllSync propagates a non-EINTR write error without retrying', () => {
  let calls = 0;
  const fault = Object.assign(new Error('disk departed'), { code: 'EIO' });
  assert.throws(
    () => writeAllSync(Buffer.from('x'), {
      write: () => { calls += 1; throw fault; },
    }),
    fault,
  );
  assert.equal(calls, 1);
});
