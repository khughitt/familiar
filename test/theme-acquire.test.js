import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifySource, collapseStderr } from '../src/theme/acquire.js';

test('an https URL classifies as a clone source', () => {
  assert.deepEqual(classifySource('https://example.test/themes/cats'),
    { kind: 'https', url: 'https://example.test/themes/cats' });
});

test('credentials in the URL are rejected before anything runs', () => {
  assert.throws(() => classifySource('https://user:token@example.test/r'), /credential/);
  assert.throws(() => classifySource('https://token@example.test/r'), /credential/);
});

test('an invalid https source gets the named source instruction', () => {
  assert.throws(() => classifySource('https://%'), /HTTPS URLs or local directories/);
});

test('non-https transports are rejected by the stated rule', () => {
  for (const raw of ['http://example.test/r', 'ssh://example.test/r',
    'git://example.test/r', 'file:///tmp/r', 'git@example.test:r.git']) {
    assert.throws(() => classifySource(raw), /HTTPS URLs or local directories/, raw);
  }
});

test('an existing directory classifies as a local source, absolute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  assert.deepEqual(classifySource(dir), { kind: 'local', path: resolve(dir) });
});

test('a missing local path is a named error', () => {
  assert.throws(() => classifySource('/no/such/dir/exists'), /no directory at/);
});

test('a file is not a directory source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  const file = join(dir, 'theme.tar.gz');
  writeFileSync(file, 'x');
  assert.throws(() => classifySource(file), /not a directory/);
});

test('stderr collapses to one sanitized line', () => {
  const raw = "Cloning into 'x'...\nremote: \x1b[31mnope\x1b[0m\r\nfatal: repository not found\n";
  const line = collapseStderr(raw);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('\r'), false);
  assert.match(line, /Cloning into 'x'\.\.\.; remote: nope; fatal: repository not found/);
});

test('bare CR, backspace, and BEL cannot rewrite the message', () => {
  const line = collapseStderr('progress 1%\rprogress 100%\bdone\x07!');
  assert.equal(/[\p{Cc}]/u.test(line), false);
  assert.match(line, /progress 1%; progress 100%/);
});
