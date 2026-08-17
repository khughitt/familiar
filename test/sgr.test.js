// Two halves of one question: what a string DOES to a terminal, and how wide it LANDS. Both
// live here because the HUD writes untrusted text -- directory names, branch names -- into a
// control plane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fg, BOLD, RESET, strip, width, sanitize } from '../src/render/term/sgr.js';

test('fg turns a ramp hex into a truecolor SGR sequence', () => {
  assert.equal(fg('#c8703a'), '\x1b[38;2;200;112;58m');
  assert.equal(fg('#000000'), '\x1b[38;2;0;0;0m');
  assert.equal(fg('#ffffff'), '\x1b[38;2;255;255;255m');
});

test('fg rejects anything that is not #rrggbb rather than emitting a broken escape', () => {
  assert.throws(() => fg('c8703a'), /sgr: fg expects #rrggbb/);
  assert.throws(() => fg('#c8703'), /sgr: fg expects #rrggbb/);
  assert.throws(() => fg('red'), /sgr: fg expects #rrggbb/);
  assert.throws(() => fg(undefined), /sgr: fg expects #rrggbb/);
});

test('strip removes SGR sequences and leaves the text', () => {
  assert.equal(strip(`${fg('#c8703a')}main${RESET}`), 'main');
  assert.equal(strip(`${BOLD}${fg('#c8703a')}error${RESET}`), 'error');
  assert.equal(strip('plain'), 'plain');
});

test('width counts columns, not bytes, and ignores colour entirely', () => {
  assert.equal(width('main'), 4);
  assert.equal(width(`${fg('#c8703a')}main${RESET}`), 4);
  assert.equal(width(''), 0);
});

test('width counts the glyphs the HUD draws as two columns — the pessimistic reading', () => {
  for (const glyph of ['▎', '⎇', '▰', '▱', '●', '⚡', '✕', '✓']) {
    assert.equal(width(glyph), 2, `${glyph} should measure 2`);
  }
});

test('width uses the hard bound: ASCII is one column, every non-ASCII scalar is two', () => {
  assert.equal(width('…'), 2);
  assert.equal(width('Ω'), 2);   // East-Asian-Ambiguous and outside the HUD's own glyph blocks
  assert.equal(width('Ω'.repeat(52)), 104);
  assert.equal(width("don't"), 5);
});

test('width counts CJK as two columns', () => {
  assert.equal(width('你好'), 4);
  assert.equal(width('a你b'), 4);
});

// --- sanitize --------------------------------------------------------------
//
// A directory name may contain a newline and an ESC. Both reach the HUD through
// basename(cwd). The newline is the CORRECTNESS bug -- it adds a row and the placeholder
// cells stop lining up with the transmitted image -- and the ESC is the security one.

test('sanitize keeps only the first line — a newline in a name must not add a row', () => {
  assert.equal(sanitize('repo\nEXTRA'), 'repo');
  assert.equal(sanitize('repo\r\nEXTRA'), 'repo');
  assert.equal(sanitize('a\nb\nc'), 'a');
});

test('sanitize replaces control bytes rather than passing them to the terminal', () => {
  assert.equal(sanitize('re\x1bpo'), 're?po');
  assert.equal(sanitize('\x1b]0;pwned\x07repo'), '?]0;pwned?repo');
  assert.equal(sanitize('re\x00po'), 're?po');
  assert.equal(sanitize('re\x7fpo'), 're?po');
  assert.equal(sanitize('re\x9bpo'), 're?po');
  assert.equal(sanitize('re\tpo'), 're?po');
});

// THE REPLACEMENT IS ASCII so one hostile byte becomes exactly one visible, one-column
// character before truncation.
test('a field of nothing but control bytes measures exactly what it renders', () => {
  const hostile = '\x1b'.repeat(52);
  const clean = sanitize(hostile);
  assert.equal(clean, '?'.repeat(52));
  assert.equal(width(clean), 52);
  assert.equal(width(clean), [...clean].length);
});

test('sanitize leaves ordinary text, including the HUD glyphs, untouched', () => {
  assert.equal(sanitize('familiar'), 'familiar');
  assert.equal(sanitize('feature/ABC-1234'), 'feature/ABC-1234');
  assert.equal(sanitize('Opus 4.8 (1M context)'), 'Opus 4.8 (1M context)');
  assert.equal(sanitize('▎⎇▰▱'), '▎⎇▰▱');
  assert.equal(sanitize('你好'), '你好');
});

test('sanitize handles the absent cases without inventing a string', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(sanitize(''), '');
});

test('a sanitized string contains nothing width() would measure as zero', () => {
  const hostile = '\x1b]0;title\x07repo\nmore';
  const clean = sanitize(hostile);
  assert.ok(!clean.includes('\x1b'));
  assert.ok(!clean.includes('\n'));
  assert.equal(width(clean), clean.length);   // no hidden escapes left to strip
});
