// The kitty graphics protocol. https://sw.kovidgoyal.net/kitty/graphics-protocol/
//
// f=100 means "the payload is a PNG" -- so the runtime ships the file's BYTES and
// decodes NOTHING. That single fact is why the indexed codec could be DELETED
// rather than replaced, and why src/ ends this change with less image code than it
// started with.
//
// This is a TERMINAL fact, not a compositor fact -- the same category as "does this
// terminal honour OSC 11". It names no window manager and no bar, so the seam
// (test/seam.test.js) is untouched.

const CHUNK = 4096;   // the protocol's maximum payload per escape

export function transmit(png, { rows }) {
  // FAIL EARLY. The chunk loop below never runs on an empty buffer, so without this
  // an empty PNG transmits as bare newlines -- a silent gap where the cat should be.
  // assetsFor() proves a sprite EXISTS; nothing proves it has BYTES.
  if (png.length === 0) throw new Error('kitty: refusing to transmit an empty PNG — the asset has no bytes');

  const payload = Buffer.from(png).toString('base64');

  // q=2: SUPPRESS THE TERMINAL'S REPLIES. Kitty answers a graphics escape ON STDIN, and
  // the stdin our bytes share is the CODING AGENT's pty, because emit() writes to
  // /proc/<intent.pid>/fd/1 -- so a reply would be typed into the agent's input.
  //
  // THAT CANNOT HAPPEN AS THE CODE STANDS, AND THE EARLIER RATIONALE HERE SAID IT COULD.
  // It claimed the success path was quiet but an ERROR reply (`\x1b_G...;EBAD...\x1b\`)
  // came back regardless. Checked against kitty's own source (finish_command_response):
  // after the quiet test, it returns a response ONLY `if (g->id || g->image_number)` --
  // no id and no number means NO reply, error or not. `transmit()` sends neither `i=` nor
  // `I=`. So kitty emits nothing back either way, with or without q=2, and the failure
  // mode that paragraph warned about does not exist. A comment asserting an unmeasured
  // fact about the environment is this project's signature defect; that was one.
  //
  // KEEP IT ANYWAY, and know why. It is belt-and-braces today and becomes LOAD-BEARING
  // the moment anyone adds an `i=`/`I=` to reuse an image across transitions -- which is
  // the obvious next optimisation here, and would silently turn every transmission into
  // a reply on the agent's stdin. Costing three bytes on the first chunk, it is the
  // cheapest thing in this file. Do not delete it because it currently suppresses
  // nothing: that is the point at which it starts suppressing something.
  //
  // FIRST CHUNK ONLY, and that is the protocol: "Subsequent chunks must have only the m
  // and optionally q keys." The suppression applies to the transmission, so repeating it
  // on every chunk would be noise.
  //
  // C=1: the image does not move the cursor. We advance it by hand, exactly `rows`
  // newlines, so the sprite occupies a known number of scrollback lines and nothing
  // below it is overprinted. Letting kitty move the cursor also works and leaves the
  // column wherever the image happened to end -- a guess we do not have to make.
  // EVERY chunk carries m, and the LAST one carries m=0 -- including when it is also
  // the first. There is no separate terminator, and adding one is a protocol
  // violation: kitty takes the second m=0 as a second (empty) image.
  //
  // An earlier draft appended `\x1b_Gm=0;\x1b\\` whenever `payload.length % CHUNK === 0`,
  // borrowed from the other common idiom -- mark every chunk m=1, then close with a
  // bare m=0. That idiom NEEDS the terminator because no chunk ever says it is last.
  // This loop already computes `more` from the remaining bytes, so its final chunk
  // says so itself, and the extra escape was pure double-emission. Two idioms, half
  // of each.
  const out = [];
  for (let at = 0; at < payload.length; at += CHUNK) {
    const slice = payload.slice(at, at + CHUNK);
    const more = at + CHUNK < payload.length ? 1 : 0;
    const control = at === 0 ? `a=T,f=100,q=2,r=${rows},C=1,m=${more}` : `m=${more}`;
    out.push(`\x1b_G${control};${slice}\x1b\\`);
  }

  return out.join('') + '\n'.repeat(rows);
}
