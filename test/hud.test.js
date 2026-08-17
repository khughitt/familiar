// The HUD is four FIXED SLOTS, never four variable lines. textLines() deletes empty lines, so
// a slot that renders as '' does not leave a gap -- it pulls every slot below it up one and
// compose() re-centres the shortened block. These tests exist to make that impossible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hudLines, truncEnd, truncMiddle, CAPS, BUDGET, ABSENT } from '../src/render/term/hud.js';
import { width, strip, fg, BOLD } from '../src/render/term/sgr.js';
import { identityColors } from '../src/theme/ramp.js';
import { STATES } from 'familiar-theme';
import { presentationFor } from '../src/protocol/intent.js';

const FIELDS = {
  project: 'familiar',
  branch: 'main',
  model: 'Opus 4.8 (1M context)',
  usedPercent: 22,
};

const plain = (lines) => lines.map(strip);

test('the HUD is four slots in a fixed order', () => {
  const lines = plain(hudLines({ intent: null, fields: FIELDS }));
  assert.equal(lines.length, 4);
  assert.match(lines[0], /familiar/);
  assert.match(lines[0], /main/);
  assert.match(lines[1], /Opus 4\.8 \(1M context\)/);
  assert.match(lines[2], /22%/);
  assert.match(lines[3], new RegExp(ABSENT));   // no intent means no state to name
});

test('every slot is emitted even when its data is absent — never an empty string', () => {
  const lines = plain(hudLines({
    intent: null,
    fields: { project: 'familiar', branch: null, model: null, usedPercent: null },
  }));
  assert.equal(lines.length, 4);
  for (const line of lines) assert.notEqual(line.trim(), '');
  assert.match(lines[0], /familiar/);
  assert.doesNotMatch(lines[0], /⎇/);     // the ⎇ segment drops, the row stays
  assert.match(lines[1], new RegExp(ABSENT));
  assert.match(lines[2], new RegExp(ABSENT));
});

test('an absent percentage and a null percentage are the same case, byte for byte', () => {
  const absent = hudLines({ intent: null, fields: { ...FIELDS, usedPercent: undefined } });
  const nulled = hudLines({ intent: null, fields: { ...FIELDS, usedPercent: null } });
  assert.deepEqual(absent, nulled);
  assert.match(strip(nulled[2]), new RegExp(ABSENT));
  assert.doesNotMatch(strip(nulled[2]), /0%/);   // the fabrication this forbids
});

test('the bar floors rather than rounds — one filled cell must mean ten percent gone', () => {
  const bar = (pct) => strip(hudLines({ intent: null, fields: { ...FIELDS, usedPercent: pct } })[2]);
  assert.equal((bar(4).match(/▰/g) ?? []).length, 0);
  assert.equal((bar(22).match(/▰/g) ?? []).length, 2);
  assert.equal((bar(99).match(/▰/g) ?? []).length, 9);
  assert.equal((bar(100).match(/▰/g) ?? []).length, 10);
  assert.match(bar(4), /4%/);
});

test('each state gets its own glyph and its own word', () => {
  for (const [state, glyph] of [
    ['idle', '●'], ['working', '⚡'], ['needs-input', '?'],
    ['needs-approval', '!'], ['error', '✕'], ['done', '✓'],
  ]) {
    const lines = plain(hudLines({ intent: { state, urgency: 'none' }, fields: FIELDS }));
    assert.equal(lines[3].includes(glyph), true, `${state} should show ${glyph}`);
    assert.equal(lines[3].includes(state), true, `${state} should be named`);
  }
});

// --- hostile input ---------------------------------------------------------
//
// A directory name may contain a newline. If it reaches the output, hudLines returns four
// strings of which one contains \n, join('\n') makes FIVE lines, and the placeholder cells
// stop lining up with the transmitted image. The four-slot invariant is defeated by a VALUE,
// which is why sanitising is the HUD's job and not the caller's.

test('a newline in a field cannot add a row', () => {
  const lines = hudLines({
    intent: null,
    fields: { project: 'repo\nEXTRA', branch: 'main\nEXTRA', model: 'M\nEXTRA', usedPercent: 5 },
  });
  assert.equal(lines.length, 4);
  assert.equal(lines.join('\n').split('\n').length, 4);
  for (const line of lines) assert.ok(!line.includes('\n'));
  assert.doesNotMatch(strip(lines[0]), /EXTRA/);
});

test('an escape sequence in a field never reaches the terminal', () => {
  const lines = hudLines({
    intent: null,
    fields: {
      project: '\x1b]0;pwned\x07repo',
      branch: 'ma\x1b[31min',
      model: '\x1b[1mBOLD',
      usedPercent: 5,
    },
  });
  for (const line of lines) {
    const painted = line.replace(/\x1b\[[0-9;]*m/g, '');   // the HUD's OWN colour, none here
    assert.ok(!painted.includes('\x1b'), `escape survived in ${JSON.stringify(line)}`);
  }
});

// --- theme heights ---------------------------------------------------------
//
// pack.js allows rows 1..40 and defaults to 12. A HUD that hardcoded four slots would, at
// rows: 3, have its state row replaced by textLines()' overflow message ABOUT the state row.

test('a short theme drops slots in a fixed order: model, then context, then identity', () => {
  const at = (rows) => plain(hudLines({ intent: null, fields: FIELDS, rows }));
  assert.equal(at(3).length, 3);
  assert.doesNotMatch(at(3).join('\n'), /Opus/);          // model goes first
  assert.match(at(3).join('\n'), /familiar/);
  assert.match(at(3).join('\n'), /22%/);

  assert.equal(at(2).length, 2);
  assert.match(at(2)[0], /familiar/);
  assert.doesNotMatch(at(2).join('\n'), /22%/);

  assert.equal(at(1).length, 1);
  assert.match(at(1)[0], new RegExp(ABSENT));             // state alone, unknown here
});

test('a tall theme gets four slots, not filler', () => {
  assert.equal(hudLines({ intent: null, fields: FIELDS, rows: 12 }).length, 4);
  assert.equal(hudLines({ intent: null, fields: FIELDS, rows: 40 }).length, 4);
});

// --- truncation ------------------------------------------------------------

test('truncEnd keeps the head and marks the cut', () => {
  assert.equal(truncEnd('short', 20), 'short');
  assert.equal(truncEnd('x'.repeat(30), 10), `${'x'.repeat(8)}…`);
  assert.ok(width(truncEnd('x'.repeat(30), 10)) <= 10);
});

test('truncMiddle keeps the tail — a branch name ends in its ticket number', () => {
  const long = 'feature/very-long-description-here-ABC-1234';
  const cut = truncMiddle(long, 26);
  assert.ok(width(cut) <= 26);
  assert.match(cut, /^feature/);
  assert.match(cut, /1234$/);
  assert.match(cut, /…/);
  assert.equal(truncMiddle('main', 26), 'main');
});

// --- the invariant ---------------------------------------------------------
//
// ONE LOOP OVER EVERY FIXTURE. This is the assertion that would have caught the omitted-model
// bug the spec records in 3.1a, so it is written as a sweep rather than as a case.

const FIXTURES = [
  { intent: null, fields: FIELDS },
  { intent: null, fields: { project: 'x', branch: null, model: null, usedPercent: null } },
  { intent: { state: 'error', urgency: 'demand' }, fields: FIELDS },
  { intent: { state: 'done', urgency: 'notice' }, fields: FIELDS },
  {
    intent: { state: 'working', urgency: 'none' },
    fields: {
      project: 'p'.repeat(120),
      branch: 'b'.repeat(120),
      model: 'm'.repeat(120),
      usedPercent: 100,
    },
  },
  {
    intent: { state: 'working', urgency: 'none' },
    fields: {
      // Printable Ambiguous values OUTSIDE Familiar's own glyph blocks. A hand-picked width
      // table misses these and can let a line measure 52 while rendering as 104.
      project: 'Ω'.repeat(60),
      branch: '·'.repeat(60),
      model: '…'.repeat(60),
      usedPercent: 50,
    },
  },
  {
    intent: null,
    fields: { project: 'a\nb', branch: '\x1b[31mc', model: '\x00d', usedPercent: 1 },
  },
];

test('every fixture at every height emits exactly min(4, rows) safe lines within budget', () => {
  for (const fixture of FIXTURES) {
    for (const rows of [1, 2, 3, 4, 5, 12, 40]) {
      const lines = hudLines({ ...fixture, rows });
      assert.equal(lines.length, Math.min(4, rows), `rows=${rows}`);
      for (const line of lines) {
        assert.notEqual(strip(line).trim(), '', `rows=${rows}: empty slot`);
        assert.ok(!line.includes('\n'), `rows=${rows}: newline inside a slot`);
        assert.ok(width(line) <= BUDGET, `rows=${rows}: ${width(line)} > ${BUDGET} in ${JSON.stringify(strip(line))}`);
      }
    }
  }
});

test('the caps are the ones the spec budgeted for', () => {
  assert.deepEqual(CAPS, { project: 20, branch: 26, model: 52 });
  assert.equal(BUDGET, 60);
});

// --- colour ----------------------------------------------------------------
//
// IDENTITY OWNS HUE, STATE OWNS URGENCY. src/protocol/intent.js:12-13: "An erroring ginger tabby is still
// ginger." These tests are the enforcement of that sentence on this surface.

const DARK = { mode: 'dark', satScale: 1 };
const LIGHT = { mode: 'light', satScale: 1 };

const intentFor = (state, slot, tone) => ({
  state,
  urgency: presentationFor(state).urgency,
  color: identityColors(slot, tone),
});

test('the hue is the member\'s and does not move when the state does', () => {
  const ember = identityColors(0, DARK);
  const stops = [ember.base, ember.light, ember.highlight].map((hex) => fg(hex));
  for (const state of STATES) {
    const rule = hudLines({ intent: intentFor(state, 0, DARK), fields: FIELDS })[0];
    assert.ok(stops.some((seq) => rule.includes(seq)), `${state}: rule is not in the member ramp`);
  }
});

test('two members with different slots differ in paint but not in text', () => {
  const a = hudLines({ intent: intentFor('working', 0, DARK), fields: FIELDS });
  const b = hudLines({ intent: intentFor('working', 7, DARK), fields: FIELDS });
  assert.notDeepEqual(a, b);
  assert.equal(strip(a.join('\n')), strip(b.join('\n')));
});

test('urgency picks the stop: demand is highlight and bold', () => {
  const ember = identityColors(0, DARK);

  const demand = hudLines({ intent: intentFor('error', 0, DARK), fields: FIELDS });
  assert.ok(demand[0].includes(BOLD), 'demand should embolden the rule');
  assert.ok(demand[0].includes(fg(ember.highlight)));

  const none = hudLines({ intent: intentFor('working', 0, DARK), fields: FIELDS });
  assert.ok(!none[0].includes(BOLD), 'urgency none should not embolden');
  assert.ok(none[0].includes(fg(ember.base)));

  const notice = hudLines({ intent: intentFor('done', 0, DARK), fields: FIELDS });
  assert.ok(notice[3].includes(fg(ember.light)));
});

test('tone changes the stops without changing the text', () => {
  const dark = hudLines({ intent: intentFor('working', 0, DARK), fields: FIELDS });
  const light = hudLines({ intent: intentFor('working', 0, LIGHT), fields: FIELDS });
  assert.notDeepEqual(dark, light);
  assert.equal(strip(dark.join('\n')), strip(light.join('\n')));
});

test('all six states in both tones stay inside the budget once painted', () => {
  for (const tone of [DARK, LIGHT]) {
    for (const state of STATES) {
      const lines = hudLines({ intent: intentFor(state, 0, tone), fields: FIELDS });
      assert.equal(lines.length, 4);
      for (const line of lines) assert.ok(width(line) <= BUDGET, `${state}/${tone.mode}`);
    }
  }
});

test('no intent means no hue — colouring an unknown identity would be a lie', () => {
  const lines = hudLines({ intent: null, fields: FIELDS });
  for (const line of lines) assert.equal(line, strip(line));
});

test('colour never survives sanitisation being skipped', () => {
  const lines = hudLines({
    intent: intentFor('working', 0, DARK),
    fields: { ...FIELDS, project: '\x1b]0;x\x07p' },
  });
  const own = /\x1b\[(?:0|1|38;2;\d+;\d+;\d+)m/g;
  for (const line of lines) {
    assert.ok(!line.replace(own, '').includes('\x1b'), 'a foreign escape survived');
  }
});
