// The status line: the one surface in claude-code whose cells its layout engine knows about.
//
// This is the half that DRAWS NOTHING. It prints placeholder characters -- ordinary text -- and
// the image the hook already transmitted appears in them. Two processes, one image id, and no
// channel between them except the id itself (see box.js for why they must agree on the box).
//
// WHY THE STATUS LINE CANNOT TRANSMIT THE IMAGE. It would be the obvious place: it knows the
// state, it runs often enough. But the hook is already writing chunked graphics escapes to the
// agent's fd 1, and two processes interleaving 4096-byte chunks into one fd produce a corrupt
// escape stream -- a garbled screen, intermittently, under load. ONE WRITER. The hook transmits;
// this prints. That is also why this file imports nothing that can write to a terminal.
import { readFileSync } from 'node:fs';
import { placeholderLines, imageIdFor } from './placeholder.js';
import { boxFor } from './box.js';

// Lay the cat's cells beside whatever the wrapped command printed.
//
// The text is vertically centred against the cat rather than parked on the first row: a
// one-line status line beside a four-row cat looks like a caption on the cat's ear otherwise.
export function compose({ id, cols, rows, text = [], gap = 2 }) {
  const cells = placeholderLines({ id, cols, rows });
  const pad = ' '.repeat(gap);
  const top = Math.max(0, Math.floor((rows - text.length) / 2));

  return cells.map((cell, i) => {
    const line = text[i - top];
    return line === undefined ? cell : cell + pad + line;
  });
}

// The wrapped command's output, as lines.
//
// EMPTY IS A VALID ANSWER, and it is not an error: `familiar statusline` with no --with prints
// the cat alone. A command that fails, though, is NOT the same as a command that printed
// nothing, and the difference must not be swallowed -- the status line is the one place where a
// silent failure looks exactly like a working configuration.
export function textLines(stdout, rows) {
  const lines = String(stdout).replace(/\n$/, '').split('\n').filter((l) => l.length > 0);
  if (lines.length > rows) {
    // More lines than the cat is tall. Keep the first `rows` and say so, rather than silently
    // dropping the tail: a status line that quietly truncates is a status line that lies.
    return [...lines.slice(0, rows - 1), `… ${lines.length - rows + 1} more line(s) than the cat is tall`];
  }
  return lines;
}

// THE STATUS-LINE RENDER, as a function so its height source is testable. It lived inline in
// bin/familiar, where nothing could see that it sized the cat from a constant instead of the
// theme — which is exactly how the drift survived. It reads the sprite's bytes only to size
// the box (boxFor reads the IHDR); it TRANSMITS NOTHING (the hook did that), so it keeps this
// file's one-writer rule.
export function composeForIntent({ intent, sessionId, rawOutput, readSprite = (p) => readFileSync(p) }) {
  if (intent.motionPolicy === 'off') {
    return rawOutput == null ? [] : textLines(rawOutput, Infinity);
  }
  const png = readSprite(intent.sprite.terminal);
  const box = boxFor(png, intent.sprite.rows);
  // NOW the text is fitted — to the cat's ACTUAL height, the theme's number. A command
  // printing more lines than the cat is tall says so (textLines), rather than silently lying.
  const text = rawOutput == null ? [] : textLines(rawOutput, box.rows);
  return compose({ id: imageIdFor(sessionId), ...box, text });
}
