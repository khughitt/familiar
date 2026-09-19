// `familiar projects` lays multi-line cells into as many columns as the terminal
// is wide. The layout is pure: cells and a width in, lines out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutCells } from '../src/render/term/cells.js';
import { fg, RESET, strip } from '../src/render/term/sgr.js';

const cell = (name, detail) => [name, `  ${detail}`];

test('columns come from the width and the widest line', () => {
  const cells = [cell('alpha', 'one'), cell('beta', 'two'), cell('gamma', 'three'), cell('delta', 'four')];
  // widest line is 'gamma' / '  three' = 7; gutter 3 -> 10 per column, last without gutter.
  const lines = layoutCells(cells, { width: 24, gutter: 3 });
  assert.deepEqual(lines, [
    'alpha     beta',
    '  one       two',
    '',
    'gamma     delta',
    '  three     four',
  ]);
});

test('an unknown width means one column', () => {
  const cells = [cell('alpha', 'one'), cell('beta', 'two')];
  assert.deepEqual(layoutCells(cells, { width: undefined, gutter: 3 }), [
    'alpha', '  one', '', 'beta', '  two',
  ]);
});

test('a width narrower than one cell still yields one column', () => {
  const cells = [cell('a-very-long-project-name', 'x'), cell('b', 'y')];
  const lines = layoutCells(cells, { width: 5, gutter: 3 });
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'a-very-long-project-name');
});

test('an uneven last row is not padded with phantom cells', () => {
  const cells = [cell('a', '1'), cell('b', '2'), cell('c', '3')];
  const lines = layoutCells(cells, { width: 80, gutter: 3 });
  assert.deepEqual(lines, ['a     b     c', '  1     2     3']);
  const five = layoutCells([...cells, cell('d', '4'), cell('e', '5')], { width: 9, gutter: 3 });
  assert.deepEqual(five, ['a     b', '  1     2', '', 'c     d', '  3     4', '', 'e', '  5']);
});

test('one-column glyphs outside ASCII do not skew the columns', () => {
  const cells = [['aaaa', '  x · y'], ['bb', '  z']];
  const lines = layoutCells(cells, { width: 40, gutter: 2 });
  assert.deepEqual(lines, ['aaaa     bb', '  x · y    z']);
});

test('SGR sequences do not count toward a column width', () => {
  const swatch = `${fg('#ff0000')}███${RESET}`;
  const cells = [[`${swatch} alpha`, '  one'], [`${swatch} beta`, '  two']];
  const lines = layoutCells(cells, { width: 30, gutter: 2 });
  assert.equal(lines.length, 2);
  assert.equal(strip(lines[0]), '███ alpha  ███ beta');
  assert.match(lines[0], /\x1b\[/);
});

test('no cells lays out to no lines', () => {
  assert.deepEqual(layoutCells([], { width: 80, gutter: 3 }), []);
});
