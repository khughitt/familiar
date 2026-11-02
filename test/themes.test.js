import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRgba } from 'familiar-theme';
import { loadThemePackSync, STATES } from 'familiar-theme';

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

// Shipped themes are whatever directories exist; each must validate, none is
// required by name.
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
}
