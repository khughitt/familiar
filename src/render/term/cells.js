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
// a pipe gets one column, never a guess at eighty. minCellWidth is a floor from
// something that is not a line of text: the sprite drawn above a caption.
export function gridPlan(cells, { width: columns, gutter, minCellWidth = 0 }) {
  const widest = Math.max(0, ...cells.flatMap((lines) => lines.map(width)));
  const cellWidth = Math.max(widest, minCellWidth);
  const perColumn = cellWidth + gutter;
  const fit = columns === undefined ? 1 : Math.floor((columns + gutter) / perColumn);
  return { cellWidth, perRow: Math.max(1, fit) };
}

// One row of cells, each padded to cellWidth plus the gutter. The last column is
// never padded: trailing spaces are invisible until a terminal wraps them, and
// then they are a blank line.
export function layoutRow(row, { cellWidth, gutter }) {
  const height = Math.max(...row.map((lines) => lines.length));
  const out = [];
  for (let line = 0; line < height; line += 1) {
    out.push(row.map((lines, index) => {
      const text = lines[line] ?? '';
      if (index === row.length - 1) return text;
      return text + ' '.repeat(cellWidth - width(text) + gutter);
    }).join(''));
  }
  return out;
}

export function layoutCells(cells, options) {
  if (cells.length === 0) return [];
  const { cellWidth, perRow } = gridPlan(cells, options);
  const out = [];
  for (let start = 0; start < cells.length; start += perRow) {
    if (start > 0) out.push('');
    out.push(...layoutRow(cells.slice(start, start + perRow), { cellWidth, gutter: options.gutter }));
  }
  return out;
}
