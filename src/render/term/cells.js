// Multi-line cells laid into columns, as a PURE function: cells and a width in,
// lines out. `familiar projects` is the consumer; every cell there is one
// project's identity, and the point of a grid is that a screen of forty
// checkouts reads in a glance instead of a scroll.
//
// One box for every cell, sized to the widest line anywhere. Cells of different
// widths would make columns that do not line up, and columns that do not line
// up defeat the point of reading down one (contact.js makes the same call for
// the pixel sheet). Widths are measured through sgr's printedWidth(), not its
// pessimistic width(): a bound that overcounts `·` on one line and not the next
// would skew the very columns this exists to align.
import { printedWidth as width } from './sgr.js';

// Columns is the terminal width, or undefined when there is no terminal to ask —
// a pipe gets one column, never a guess at eighty.
export function layoutCells(cells, { width: columns, gutter }) {
  if (cells.length === 0) return [];
  const cellWidth = Math.max(...cells.flatMap((lines) => lines.map(width)));
  const perColumn = cellWidth + gutter;
  const fit = columns === undefined ? 1 : Math.floor((columns + gutter) / perColumn);
  const perRow = Math.max(1, fit);
  const height = Math.max(...cells.map((lines) => lines.length));

  const out = [];
  for (let start = 0; start < cells.length; start += perRow) {
    if (start > 0) out.push('');
    const row = cells.slice(start, start + perRow);
    for (let line = 0; line < height; line += 1) {
      const parts = row.map((lines, index) => {
        const text = lines[line] ?? '';
        // The last column is never padded: trailing spaces are invisible until a
        // terminal wraps them, and then they are a blank line.
        if (index === row.length - 1) return text;
        return text + ' '.repeat(cellWidth - width(text) + gutter);
      });
      out.push(parts.join(''));
    }
  }
  return out;
}
