import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateThemePack, SLOT_COUNT } from 'familiar-theme';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const catsThemeDir = join(REPO, 'themes', 'cats');

// The shipped theme and the gate agree — the happy-path proof. Fast suite on
// purpose: ~1.3s of measured decode does not demote shipped-theme conformance
// to the slow flow (spec §6).
//
// GUARDED, not converted to the engine fixture: the whole point of this test
// is proving the REAL cats pack conforms, which a synthetic pack cannot
// stand in for. Post-split the engine repo ships no themes/, so this skips
// there — the real-pack proof relocates to the cats conformance gate (spec
// §4), which validates the exported pack against the real engine.
test(
  'themes/cats passes the full conformance gate',
  { skip: existsSync(catsThemeDir) ? false : 'themes/cats is not present in this checkout' },
  async () => {
    const pack = await validateThemePack(catsThemeDir);
    assert.equal(pack.id, 'cats');
    assert.equal(pack.bySlot.size, SLOT_COUNT);
  },
);
