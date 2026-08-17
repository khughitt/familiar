import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRgba } from 'familiar-theme';
import { loadThemePackSync, STATES, SLOT_COUNT } from 'familiar-theme';

// Two sources: the real shipped roster (present only in the monolith, before
// projection — themes/cats does not travel with the engine) and the
// committed engine fixture (always present, so this file always proves at
// least one theme). Guarded, not required: post-split the engine repo ships
// no themes/, and the real-cats proof relocates to the cats conformance gate
// (spec §4).
const REPO = fileURLToPath(new URL('..', import.meta.url));
const shippedThemesDir = join(REPO, 'themes');
const shippedThemes = existsSync(shippedThemesDir) ? readdirSync(shippedThemesDir) : [];
const fixtureDir = join(REPO, 'test', 'fixtures', 'theme-pack');

const packs = [
  ...shippedThemes.map((id) => ({ id, dir: join(shippedThemesDir, id) })),
  { id: 'fixture', dir: fixtureDir },
];

test('at least one theme ships', () => {
  assert.ok(shippedThemes.length === 0 || shippedThemes.includes('cats'));
});

for (const { id, dir } of packs) {
  const load = () => loadThemePackSync(dir);

  test(`theme "${id}" validates`, () => {
    const pack = load();
    const visited = [];

    // UNCHANGED by the art pipeline, and deliberately kept: the pack's id, and the
    // persona each member is drawn from. Neither is about pixels, so neither moves.
    // Only the asset assertions between them are new.
    assert.equal(pack.id, id);

    for (const [memberId, member] of pack.members) {
      visited.push(memberId);
      assert.deepEqual(
        member.animation,
        { kind: 'static' },
        `${memberId}: every member in the shipped static slice must declare exactly { kind: static }`,
      );

      for (const state of STATES) {
        const master = decodeRgba(readFileSync(join(dir, member.assetRoot, `${state}.png`)));
        assert.ok(master.w > 0 && master.h > 0, `${memberId}/${state}: master has no pixels`);

        let opaque = 0;
        let clear = 0;
        for (let i = 0; i < master.w * master.h; i++) {
          if (master.buf[i * 4 + 3]) opaque++;
          else clear++;
        }
        // BOTH directions, and neither is theoretical. "Some alpha is 0" alone passes a
        // blank file. "Some alpha is 255" alone passes the opaque painted checkerboard
        // that EVERY model tested actually returns when asked for transparency.
        assert.ok(opaque > 0, `${memberId}/${state}: master is entirely transparent — there is no cat`);
        assert.ok(clear > 0, `${memberId}/${state}: master is fully opaque — the background was never keyed`);
      }

      assert.ok(member.persona.length > 20, `${memberId}'s persona is too thin to draw from`);
    }
    // STRUCTURAL, not a hardcoded roster size: every member the descriptor
    // declares must actually be visited, in order, whether that theme has
    // one member (the engine fixture) or a full roster (cats).
    assert.equal(visited.length, pack.members.size, `theme "${id}" did not visit every descriptor member`);
    assert.deepEqual(visited, [...pack.members.keys()]);
  });

  // THIS REPLACES AN ASSERTION THAT COULD NOT FAIL. It read:
  //
  //     for (const [slot, ids] of pack.bySlot) assert.ok(ids.length > 0, ...)
  //
  // `bySlot` is BUILT by pushing member ids into it (familiar-theme's pack.js), so a slot only
  // appears there at all if some member declared it. `ids.length > 0` was true by
  // construction, for every possible theme, including a theme with ONE member and eleven
  // empty slots -- the exact condition it appeared to be guarding. It agreed with its author
  // instead of testing him.
  //
  // The real question is the one it was named after and never asked: does every slot a
  // project can HASH TO have a member? A project hashes to any of the twelve; a gap is a repo
  // that renders nothing but an exception on every tool call, and per the spec must never
  // silently borrow another member's sprite. Until the roster landed this could not be
  // asserted, because the theme was deliberately partial. It can now, so it is.
  //
  // KILLS: deleting any member from theme.yaml. Verified by doing exactly that -- dropping
  // `witches-familiar` (slot 11) turns this RED and nothing else in the suite notices.
  test(`theme "${id}" populates every one of the ${SLOT_COUNT} slots a project can hash to`, () => {
    const pack = load();
    const missing = [...Array(SLOT_COUNT).keys()].filter((slot) => !pack.bySlot.has(slot));
    assert.deepEqual(missing, [], `slots with no member: ${missing.join(', ')}`);
  });
}
