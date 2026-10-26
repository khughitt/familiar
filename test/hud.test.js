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
  color: identityColors({ slot, projectColor: null }, tone),
});

test('the hue is the member\'s and does not move when the state does', () => {
  const ember = identityColors({ slot: 0, projectColor: null }, DARK);
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
  const ember = identityColors({ slot: 0, projectColor: null }, DARK);

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

test('the project name is painted with the project stop, not the light stop', () => {
  const color = identityColors({ slot: 3, projectColor: '#317d01' }, DARK);
  const [identity] = hudLines({ intent: { color, urgency: 'none', state: 'idle' },
    fields: { project: 'ns', branch: null, model: null, usedPercent: null }, rows: 4 });
  assert.ok(identity.includes(fg('#317d01') + 'ns'));
  assert.ok(!identity.includes(fg(color.light) + 'ns'));
});

// --- the claimed task -------------------------------------------------------
//
// `project (id +N)` in the identity slot. The id is NEVER truncated: it is there to be copied
// into `tasks show`, and a cut id names nothing. The branch takes what is left.

const LONG_BRANCH = 'feature/very-long-description-here-ABC-1234';

// Captured from the renderer BEFORE the claim existed. With no claim the line must not move by
// one byte, colour included.
test('with no claim the identity line is byte-identical to the claim-less renderer', () => {
  const fields = { ...FIELDS, branch: LONG_BRANCH };
  const color = identityColors({ slot: 3, projectColor: '#317d01' }, DARK);
  for (const claim of [undefined, null]) {
    assert.deepEqual(hudLines({ intent: null, fields: { ...fields, claim } }), [
      '▎ familiar  ⎇ feature/very…ere-ABC-1234', '▎ Opus 4.8 (1M context)', '▎ ▰▰▱▱▱▱▱▱▱▱  22%', '▎ —',
    ]);
    assert.equal(
      hudLines({ intent: { color, urgency: 'notice', state: 'done' }, fields: { ...fields, claim } })[0],
      '\x1b[38;2;139;189;107m▎\x1b[0m \x1b[38;2;49;125;1mfamiliar\x1b[0m  '
        + '\x1b[38;2;84;127;57m⎇ feature/very…ere-ABC-1234\x1b[0m',
    );
  }
});

test('one claim reads as `project (id)` before the branch', () => {
  const [identity] = plain(hudLines({ intent: null, fields: { ...FIELDS, claim: { id: 'fam-ff5351', others: 0 } } }));
  assert.equal(identity, '▎ familiar (fam-ff5351)  ⎇ main');
});

test('further claims are counted, not listed', () => {
  const [identity] = plain(hudLines({ intent: null, fields: { ...FIELDS, claim: { id: 'fam-ff5351', others: 2 } } }));
  assert.equal(identity, '▎ familiar (fam-ff5351 +2)  ⎇ main');
});

test('the claim shows with no branch at all', () => {
  const [identity] = plain(hudLines({
    intent: null, fields: { ...FIELDS, branch: null, claim: { id: 'fam-ff5351', others: 0 } },
  }));
  assert.equal(identity, '▎ familiar (fam-ff5351)');
});

test('the branch gets the room the line has left, and the id survives whole', () => {
  const claim = { id: 'autonomy-c6c847', others: 2 };
  const [identity] = plain(hudLines({
    intent: null, fields: { project: 'p'.repeat(40), branch: 'b'.repeat(26), model: null, usedPercent: null, claim },
  }));
  assert.ok(identity.includes('(autonomy-c6c847 +2)'), identity);
  assert.equal(width(identity), BUDGET, `the branch should fill the line to ${BUDGET}`);
});

// A short project leaves room the claim-less line never used: a branch that fits stays whole.
test('a branch that fits beside a short project and its claim is not cut', () => {
  const [identity] = plain(hudLines({
    intent: null,
    fields: { ...FIELDS, branch: 'fam-ff5351-statusline-task', claim: { id: 'fam-ff5351', others: 0 } },
  }));
  assert.equal(identity, '▎ familiar (fam-ff5351)  ⎇ fam-ff5351-statusline-task');
});

test('the branch never exceeds its own cap, claim or not', () => {
  const [identity] = plain(hudLines({
    intent: null, fields: { ...FIELDS, project: 'p', branch: 'b'.repeat(60), claim: { id: 'p-abcdef', others: 0 } },
  }));
  assert.equal(width(identity.slice(identity.indexOf('⎇ ') + 2)), CAPS.branch);
});

test('an id too wide to leave the branch any room drops the branch, never the id', () => {
  const id = `${'x'.repeat(30)}-abcdef`;
  const [identity] = plain(hudLines({
    intent: null, fields: { ...FIELDS, project: 'p'.repeat(40), claim: { id, others: 12 } },
  }));
  assert.ok(identity.includes(`(${id} +12)`), identity);
  assert.doesNotMatch(identity, /⎇/);
  assert.ok(width(identity) <= BUDGET, `${width(identity)} > ${BUDGET}`);
});

// The ellipsis is two cells wide, so four is the narrowest branch that keeps a character on
// each side of it. Below that the branch drops rather than printing a head and no tail.
test('the branch shows at four cells and drops at three', () => {
  const identityAt = (idLength) => strip(hudLines({
    intent: null, fields: { ...FIELDS, project: 'p', branch: 'b'.repeat(60), claim: { id: 'x'.repeat(idLength), others: 0 } },
  })[0]);
  // lead 3 + project 1 + ` (id)` + `  ⎇ ` 5 + branch = 60
  assert.equal(identityAt(44).slice(identityAt(44).indexOf('⎇ ') + 2), 'b…b');
  assert.doesNotMatch(identityAt(45), /⎇/);
});

test('the claim is sanitised like every other field', () => {
  const lines = hudLines({
    intent: null, fields: { ...FIELDS, claim: { id: 'fam-\x1b]0;x\x07ff\n5351', others: 0 } },
  });
  assert.equal(lines.length, 4);
  assert.ok(!lines[0].includes('\x1b') && !lines[0].includes('\n'), JSON.stringify(lines[0]));
});

test('the task id takes the project stop; its frame is dim', () => {
  const color = identityColors({ slot: 3, projectColor: '#317d01' }, DARK);
  const [identity] = hudLines({
    intent: { color, urgency: 'none', state: 'idle' },
    fields: { ...FIELDS, claim: { id: 'fam-ff5351', others: 1 } },
  });
  assert.ok(identity.includes(fg('#317d01') + 'fam-ff5351'), JSON.stringify(identity));
  assert.ok(identity.includes(fg(color.shadow) + ' +1)'), JSON.stringify(identity));
});

// THE SWEEP, AGAIN, WITH A CLAIM PRESENT. The longest prefix registered today is eight
// characters (`autonomy`), against a branch at its full 26-cell cap, with `+N`: the widest
// identity line real data produces. Every state, both tones, every height.
test('with a claim, every state, tone and height stays inside the budget', () => {
  const fields = {
    project: 'p'.repeat(40), branch: 'b'.repeat(26), model: 'm'.repeat(120), usedPercent: 100,
    claim: { id: 'autonomy-c6c847', others: 9 },
  };
  const fixtures = [
    { intent: null, fields },
    ...[DARK, LIGHT].flatMap((tone) => STATES.map((state) => ({ intent: intentFor(state, 0, tone), fields }))),
  ];
  for (const fixture of fixtures) {
    for (const rows of [1, 2, 3, 4, 5, 12, 40]) {
      const lines = hudLines({ ...fixture, rows });
      assert.equal(lines.length, Math.min(4, rows), `rows=${rows}`);
      for (const line of lines) {
        assert.notEqual(strip(line).trim(), '', `rows=${rows}: empty slot`);
        assert.ok(!line.includes('\n'), `rows=${rows}: newline inside a slot`);
        assert.ok(width(line) <= BUDGET, `rows=${rows}: ${width(line)} > ${BUDGET} in ${JSON.stringify(strip(line))}`);
      }
      if (rows >= 2) assert.ok(strip(lines[0]).includes('(autonomy-c6c847 +9)'), `rows=${rows}`);
    }
  }
});
