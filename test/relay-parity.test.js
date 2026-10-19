import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATES as relaySTATES } from 'relay';
import {
  STATES as themeSTATES, assetsFor, defaultMemberForSlot, loadThemePack,
} from 'familiar-theme';

test("relay's observation states are exactly familiar-theme's", () => {
  assert.deepEqual([...relaySTATES].sort(), [...themeSTATES].sort());
});

test('every relay state resolves assets in the committed theme fixture', async () => {
  const themeFixture = fileURLToPath(new URL('fixtures/theme-pack', import.meta.url));
  const pack = await loadThemePack(themeFixture);
  const assets = assetsFor(pack, defaultMemberForSlot(pack, 0), 'dark');
  for (const state of relaySTATES) {
    assert.ok(existsSync(assets[state].terminal), `${state} has a terminal asset`);
  }
});
