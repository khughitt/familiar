import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { writeAtomicSync } from '../src/install/atomic.js';

test('writeAtomicSync: default suffixes are unique and stay beside the destination', () => {
  const temps = [];
  const deps = {
    write: (path) => { temps.push(path); },
    rename: () => {},
    remove: () => {},
  };

  writeAtomicSync('/cfg/opencode.json', 'first', deps);
  writeAtomicSync('/cfg/opencode.json', 'second', deps);

  assert.equal(dirname(temps[0]), '/cfg');
  assert.equal(dirname(temps[1]), '/cfg');
  assert.notEqual(temps[0], temps[1]);
});

test('writeAtomicSync: rename failure removes the exact deterministic temporary path', () => {
  const renameError = new Error('rename blocked');
  const calls = [];

  assert.throws(() => writeAtomicSync('/cfg/opencode.json', 'text', {
    suffix: () => 'fixed-suffix',
    write: (path, text) => { calls.push(['write', path, text]); },
    rename: (from, to) => { calls.push(['rename', from, to]); throw renameError; },
    remove: (path) => { calls.push(['remove', path]); },
  }), (error) => error === renameError);

  assert.deepEqual(calls, [
    ['write', '/cfg/opencode.json.tmp.fixed-suffix', 'text'],
    ['rename', '/cfg/opencode.json.tmp.fixed-suffix', '/cfg/opencode.json'],
    ['remove', '/cfg/opencode.json.tmp.fixed-suffix'],
  ]);
});

test('writeAtomicSync: write failure removes its temporary path before rethrowing', () => {
  const writeError = new Error('write blocked');
  const removed = [];

  assert.throws(() => writeAtomicSync('/cfg/tui.json', 'text', {
    suffix: () => 'partial',
    write: () => { throw writeError; },
    rename: () => assert.fail('rename must not run after a failed write'),
    remove: (path) => { removed.push(path); },
  }), (error) => error === writeError);

  assert.deepEqual(removed, ['/cfg/tui.json.tmp.partial']);
});

test('writeAtomicSync: cleanup ignores ENOENT but exposes every other removal failure', () => {
  const renameError = new Error('rename blocked');
  const enoent = Object.assign(new Error('already absent'), { code: 'ENOENT' });
  assert.throws(() => writeAtomicSync('/cfg/tui.json', 'text', {
    suffix: () => 'gone',
    write: () => {},
    rename: () => { throw renameError; },
    remove: () => { throw enoent; },
  }), (error) => error === renameError);

  const cleanupError = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
  assert.throws(() => writeAtomicSync('/cfg/tui.json', 'text', {
    suffix: () => 'stuck',
    write: () => {},
    rename: () => { throw renameError; },
    remove: () => { throw cleanupError; },
  }), (error) => (
    error instanceof AggregateError
    && error.errors.includes(renameError)
    && error.errors.includes(cleanupError)
    && error.message.includes('/cfg/tui.json.tmp.stuck')
  ));
});
