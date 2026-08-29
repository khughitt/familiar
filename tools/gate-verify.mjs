#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Offline check of a returned §11 trace against the evidence contract in
// docs/specs/2026-08-22-macos-support-design.md §11.1. Every check is internal to one
// record: the emitter's own expectation travels with the bytes it produced, so this
// never has to reconstruct intent from the byte stream or correlate two records.

// The ringing states, taken from the DESIGN (§11.2), not from emit.js. If this list and
// emit.js's RINGS ever disagree, the gate fails -- which is the entire point of not
// letting the code under test tell us what it was supposed to do.
const RINGING = new Set(['needs-input', 'needs-approval', 'error']);

// APC control keys are `k=v` pairs. Anything else is malformed, whatever it decodes to.
const KEYS = /^[A-Za-z]=[^,]*(,[A-Za-z]=[^,]*)*$/;

// The only cursor control the OpenCode placement envelope may contain: an absolute move
// with a row and a column (integrations/opencode/sprite.js placeAt).
const CUP = /^\d+;\d+$/;

// The envelope contract is a SEQUENCE with fixed contents: save, exactly one absolute
// move, exactly one `a=p` placement, restore -- which is precisely what placeAt() emits.
// Counting saves against restores accepts `ESC8, CSI, APC, ESC7`, which balances perfectly
// and leaves the cursor exactly where the sprite put it: the visible bug. Accepting any
// APC in the placement slot accepts `ESC7, CSI, a=d, ESC8`, which deletes from inside an
// envelope built to place. Bare APCs OUTSIDE an envelope are correct and expected:
// hidePlacement and freeImage are unwrapped (integrations/opencode/sprite-runtime.js).
export function envelopeProblems(escapes) {
  const problems = [];
  let state = 'outside';
  let envelopes = 0, placed = 0;
  const save = (e) => e.k === 'ESC' && e.code === '7';
  const restore = (e) => e.k === 'ESC' && e.code === '8';
  const move = (e) => e.k === 'CSI';
  const isPlacement = (e) => /(^|,)a=p(,|$)/.test(e.keys);

  const close = () => {
    if (placed !== 1) {
      problems.push(`placement envelope carried ${placed} placement commands, expected exactly one`);
    }
    state = 'outside';
  };

  for (const escape of escapes) {
    if (state === 'outside') {
      if (save(escape)) { state = 'saved'; envelopes += 1; placed = 0; continue; }
      if (move(escape)) { problems.push('cursor move outside a placement envelope'); continue; }
      if (restore(escape)) { problems.push('cursor restore with no matching save'); continue; }
      continue;   // bare APCs out here are hidePlacement and freeImage, which are unwrapped
    }
    if (save(escape)) { problems.push('nested placement envelope'); continue; }

    if (state === 'saved') {
      if (move(escape)) { state = 'moved'; continue; }
      if (restore(escape)) { problems.push('placement envelope contained no cursor move'); close(); continue; }
      problems.push('placement envelope wrote before moving the cursor');
      state = 'placing';
      if (escape.k === 'APC') { placed += 1; if (!isPlacement(escape)) problems.push(`placement envelope carries a non-placement command ${JSON.stringify(escape.keys)}`); }
      continue;
    }
    if (state === 'moved') {
      if (move(escape)) { problems.push('placement envelope moved the cursor twice'); continue; }
      if (restore(escape)) { close(); continue; }
      if (escape.k === 'APC') {
        state = 'placing';
        placed += 1;
        // placeAt() emits `a=p` and nothing else. An `a=d` here would delete inside an
        // envelope built to place, which is not a thing this renderer does.
        if (!isPlacement(escape)) {
          problems.push(`placement envelope carries a non-placement command ${JSON.stringify(escape.keys)}`);
        }
        continue;
      }
      problems.push(`unexpected ${escape.k} inside a placement envelope`);
      continue;
    }
    if (move(escape)) { problems.push('placement envelope moved the cursor after placing'); continue; }
    if (restore(escape)) { close(); continue; }
    if (escape.k === 'APC') {
      placed += 1;
      if (!isPlacement(escape)) {
        problems.push(`placement envelope carries a non-placement command ${JSON.stringify(escape.keys)}`);
      }
      continue;
    }
    problems.push(`unexpected ${escape.k} inside a placement envelope`);
  }
  if (state !== 'outside') problems.push('placement envelope was never closed');
  // sprite-runtime.js calls writeTerminal once per builder: one placeAt, or one
  // hidePlacement, or one freeImage. Two envelopes in one write is not a shape it produces.
  if (envelopes > 1) problems.push(`${envelopes} placement envelopes in one write, expected one`);
  return problems;
}

// One malformed line must not cost the whole cell. The OpenCode cells have TWO processes
// appending to one file (the hook and the in-process sprite renderer), so a torn line is a
// shape this format can actually produce -- and aborting on it would throw away every
// record that parsed, including the ones before the tear. Each unparseable line becomes a
// violation naming its line number, so the cell still fails, with the rest of its evidence
// checked. The line's own text is never printed: it is the one thing here not known to be
// free of a path or a payload.
export function parseTrace(text) {
  const records = [];
  const problems = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '') continue;
    try {
      records.push(JSON.parse(lines[index]));
    } catch (error) {
      problems.push(`line ${index + 1} (${lines[index].length} bytes) is not JSON: ${error.message}`);
    }
  }
  return { records, problems };
}

export function verifyTrace(records, {
  expectRdev = null, expectCapability = null, requireRestore = true,
} = {}) {
  const violations = [];
  const agents = new Set();
  let writes = 0, apcChunks = 0, bells = 0, restores = 0;

  for (const record of records) {
    if (record.agent) agents.add(record.agent);
    if (record.kind !== 'write') { violations.push(`unknown record kind ${record.kind}`); continue; }
    writes += 1;

    const expect = record.expect;
    const where = `${record.agent ?? 'unknown'}/${record.event ?? expect?.source ?? '?'}`;
    if (expect === null || expect === undefined) {
      violations.push(`${where}: a write reached a terminal with no expectation attached`);
      continue;
    }
    const sprite = expect.source === 'opencode-sprite';

    // --- capability, asserted from OUTSIDE. Without this the negative control would be
    // --- checking the classifier against itself: a broken marker scrub classifies as
    // --- graphics-capable, emits graphics, and agrees with its own expectation.
    if (expectCapability !== null && expect.capability !== expectCapability) {
      violations.push(
        `${where}: classified as ${JSON.stringify(expect.capability)}, but this run was ` +
        `required to classify as ${JSON.stringify(expectCapability)}`,
      );
    }

    // --- device identity. Two nulls are not a match, and the externally captured device
    // --- constrains EVERY write: target === fd only proves emit wrote to what it opened,
    // --- which a resolver that picked the wrong tty also satisfies.
    if (record.fdRdev === null || record.fdRdev === undefined) {
      violations.push(`${where}: the written fd has no device identity`);
    } else {
      if (record.target !== null && record.target !== undefined) {
        if (record.targetRdev === null || record.targetRdev === undefined) {
          violations.push(`${where}: target ${record.target} could not be identified`);
        } else if (record.targetRdev !== record.fdRdev) {
          violations.push(
            `${where}: wrote to rdev ${record.fdRdev}, but opened ${record.target} ` +
            `(rdev ${record.targetRdev})`,
          );
        }
      }
      if (expectRdev !== null && record.fdRdev !== expectRdev) {
        violations.push(
          `${where}: reached rdev ${record.fdRdev}, but this run's terminal is ${expectRdev}`,
        );
      }
    }

    // --- decompose what actually went out ---
    let firstAction = null, apcCount = 0, bel = 0;
    let osc11 = null, osc12 = null, has111 = false, has112 = false;
    const ids = new Set();
    for (const escape of record.escapes) {
      if (escape.k === 'BEL') { bel += 1; continue; }
      if (escape.k === 'OTHER') { violations.push(`${where}: out-of-vocabulary bytes ${escape.hex}`); continue; }
      if (escape.k === 'UNTERMINATED') { violations.push(`${where}: unterminated escape ${escape.hex}`); continue; }

      if (escape.k === 'ESC' || escape.k === 'CSI') {
        // The placement envelope belongs to opencode's renderer alone. The hook's emit()
        // never moves the cursor, and a cursor move appearing there would be a real defect.
        if (!sprite) {
          violations.push(`${where}: cursor control from a non-sprite writer`);
          continue;
        }
        const known = (escape.k === 'ESC' && (escape.code === '7' || escape.code === '8'))
          || (escape.k === 'CSI' && escape.final === 'H' && CUP.test(escape.params));
        if (!known) {
          violations.push(
            `${where}: ${escape.k} ${JSON.stringify(escape.code ?? `${escape.params}${escape.final}`)} ` +
            'is not part of the placement envelope',
          );
        }
        continue;   // ORDER is checked separately, below; counting these proves nothing.
      }

      if (escape.k === 'APC') {
        apcCount += 1;
        if (!KEYS.test(escape.keys)) {
          violations.push(`${where}: malformed graphics keys ${JSON.stringify(escape.keys)}`);
        }
        const id = /(^|,)i=(\d+)(,|$)/.exec(escape.keys);
        if (id) ids.add(Number(id[2]));
        if (firstAction === null && /(^|,)a=/.test(escape.keys)) firstAction = escape.keys;
        continue;
      }

      if (escape.k === 'OSC') {
        if (escape.code === '11') osc11 = escape.payload;
        else if (escape.code === '12') osc12 = escape.payload;
        else if (escape.code === '111') has111 = true;
        else if (escape.code === '112') has112 = true;
        else violations.push(`${where}: OSC ${escape.code} is outside the closed vocabulary`);
        continue;
      }
      violations.push(`${where}: unknown escape kind ${escape.k}`);
    }
    apcChunks += apcCount;
    bells += bel;

    // --- the envelope must occur in ORDER, not merely in equal numbers ---
    if (sprite) {
      for (const problem of envelopeProblems(record.escapes)) {
        violations.push(`${where}: ${problem}`);
      }
    }

    // --- graphics against the plan ---
    // `imageId === null` is exactly `graphics.length === 0` in emit.js, which is what
    // every Codex and OpenCode hook write is, and what a Claude Code write is whenever the
    // transition was not graphical. Those writes are graphics-capable, so `capability
    // none` does not cover them: without the third branch a stray transmission there --
    // the sprite reappearing on a terminal that was only meant to be tinted -- is checked
    // by nothing at all.
    if (expect.capability === 'none') {
      if (apcCount > 0) violations.push(`${where}: graphics emitted under capability none`);
    } else if (expect.imageId === null || expect.imageId === undefined) {
      if (apcCount > 0) {
        violations.push(`${where}: ${apcCount} graphics chunks reached the terminal, none were planned`);
      }
    } else {
      if (apcCount === 0) {
        violations.push(`${where}: expected graphics for image ${expect.imageId}, none transmitted`);
      } else if (firstAction === null) {
        violations.push(`${where}: graphics carried no action chunk to name the image`);
      }
      // At least one chunk must NAME the image. `a=t` alone is well-formed, sets
      // firstAction, and leaves the id set empty -- so a transmission addressed to no
      // image would otherwise pass every other check.
      if (apcCount > 0 && ids.size === 0) {
        violations.push(`${where}: no graphics chunk carried an image id, expected ${expect.imageId}`);
      }
      // EVERY id, not just the first: a later chunk addressing another image would place
      // or delete something that is not ours.
      for (const id of ids) {
        if (id !== expect.imageId) {
          violations.push(`${where}: graphics chunk addresses image ${id}, expected ${expect.imageId}`);
        }
      }
      if (expect.commands !== null && expect.commands !== undefined && apcCount !== expect.commands) {
        // Byte integrity between encoder and terminal, not an independent check of the
        // encoder: `commands` is the encoder's own count.
        violations.push(`${where}: ${apcCount} graphics chunks reached the terminal, encoder produced ${expect.commands}`);
      }
      // Placement comes from boxFor(sprite, theme rows) -- neither the encoder nor the
      // trace produced it -- so this IS independent of the code that wrote the bytes.
      if (expect.placement && firstAction !== null && /(^|,)a=[tT](,|$)/.test(firstAction)) {
        const cols = /(^|,)c=(\d+)(,|$)/.exec(firstAction);
        const rows = /(^|,)r=(\d+)(,|$)/.exec(firstAction);
        if (!cols || !rows) {
          violations.push(`${where}: transmit chunk "${firstAction}" carries no placement box`);
        } else if (Number(cols[2]) !== expect.placement.cols || Number(rows[2]) !== expect.placement.rows) {
          violations.push(
            `${where}: placed ${cols[2]}x${rows[2]} cells, the sprite box is ` +
            `${expect.placement.cols}x${expect.placement.rows}`,
          );
        }
      }
    }

    // --- tint and bell ---
    // `presented: false` says the writer produced NO presentation bytes for this write --
    // a same-state transition, where emit.js's renderTransition returns '' and only
    // graphics go out (and every opencode-sprite write, which never tints or rings). The
    // recorded state and colours still describe the session, so checking them against the
    // bytes would report a missing colour and a missing bell that were never sent. What
    // this branch checks instead is that those bytes are genuinely absent; it is a
    // narrower claim than the writer's, not a weaker one, because `presented` says only
    // whether renderTransition returned bytes, never which bytes.
    if (expect.presented === false) {
      if (osc11 !== null) violations.push(`${where}: OSC 11 ${osc11} from a write that sends no tint`);
      if (osc12 !== null) violations.push(`${where}: OSC 12 ${osc12} from a write that sends no tint`);
      if (bel !== 0) violations.push(`${where}: ${bel} bells from a write that rings none`);
    } else {
      // the exact colours the theme chose
      if (expect.backdrop !== null && expect.backdrop !== undefined && osc11 !== expect.backdrop) {
        violations.push(`${where}: OSC 11 was ${osc11 === null ? 'null' : osc11}, expected ${expect.backdrop}`);
      }
      if (expect.base !== null && expect.base !== undefined && osc12 !== expect.base) {
        violations.push(`${where}: OSC 12 was ${osc12 === null ? 'null' : osc12}, expected ${expect.base}`);
      }
      // the bell is decided HERE from the recorded state, never from a flag the writer set
      if (!sprite) {
        const wanted = expect.state !== null && RINGING.has(expect.state) ? 1 : 0;
        if (bel !== wanted) {
          violations.push(
            `${where}: ${bel} bells for state ${JSON.stringify(expect.state ?? null)}, expected ${wanted}`,
          );
        }
      }
    }

    // --- restore: both halves, and only at a session end ---
    if (expect.reset) {
      if (has111 && has112) restores += 1;
      else violations.push(`${where}: session end must restore both, saw 111=${has111} 112=${has112}`);
    } else if (has111 || has112) {
      violations.push(`${where}: colour restore outside a session-end transition`);
    }
  }

  if (requireRestore && writes > 0 && restores === 0) {
    violations.push('this cell never restored colours: no session-end write is present');
  }

  return { violations, summary: { agents: [...agents], writes, apcChunks, bells, restores } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    process.stderr.write(
      'usage: gate-verify.mjs <trace.jsonl> [--expect-rdev N] ' +
      '[--expect-capability none|static-graphics|kitty-animation] [--no-require-restore]\n',
    );
    process.exit(2);
  }
  const rdevAt = args.indexOf('--expect-rdev');
  const capAt = args.indexOf('--expect-capability');
  const { records, problems } = parseTrace(readFileSync(file, 'utf8'));
  const { violations, summary } = verifyTrace(records, {
    expectRdev: rdevAt === -1 ? null : Number(args[rdevAt + 1]),
    expectCapability: capAt === -1 ? null : args[capAt + 1],
    requireRestore: !args.includes('--no-require-restore'),
  });
  const all = [...problems.map((problem) => `${file}: ${problem}`), ...violations];
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  for (const violation of all) process.stdout.write(`VIOLATION ${violation}\n`);
  process.exit(all.length === 0 ? 0 : 1);
}
