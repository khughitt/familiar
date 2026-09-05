import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fnv1a32Bytes } from '../protocol/hash.js';

// PROVENANCE CANNOT ANSWER THIS QUESTION, which is why this file exists rather
// than a copy of the theme receipt. A `local` receipt carries no commit at all
// (../theme/receipt.js validates it as { kind, path }), an absent receipt is
// normal for any other install route, and an `https` receipt is unchanged when
// the installed artwork is edited in place.
//
// AND THE INPUTS CANNOT ANSWER IT EITHER. sampledFrames() in
// ../render/codex/pets.js reads a frame only on a cache MISS, and never reads a
// root frame at all, so the bytes an input hash could observe do not distinguish
// two timings that sample the same files in a different order or a different
// number of times. The compiled sheet does: it is a total function of the art,
// the sampling, the geometry, the motion policy and the anchor. Hash the
// artifact, not the ingredients.
export const STAMP_VERSION = 1;
export const STAMP_FILE = 'familiar-stamp.json';

const HEX8 = /^[0-9a-f]{8}$/;

// The two policies that actually COMPILE a sheet. `off` is a real motion policy
// (see MOTION_POLICIES in ../animation/program.js) but `install pets` refuses to
// run under it, so a stamp claiming it describes a pet that cannot exist.
const STAMP_POLICIES = new Set(['full', 'reduced']);
const STAMP_ANCHORS = new Set(['floor', 'center']);   // parseAnchor's domain, in familiar-theme
const FRAME_FIELDS = ['width', 'height', 'columns', 'rows'];

const positiveInt = (value) => Number.isInteger(value) && value > 0;

// The compiler contract belongs in the stamp alongside the sheet: it is what a
// reader needs to interpret the hash, and hashing it in means a contract change
// invalidates the stamp even if the bytes happened to collide.
export function stampFor({ themeId, memberId, frame, motionPolicy, anchor, sheet }) {
  const contract = new TextEncoder().encode(JSON.stringify({
    version: STAMP_VERSION, themeId, memberId, frame, motionPolicy, anchor,
  }));
  const content = fnv1a32Bytes(sheet, fnv1a32Bytes(contract)).toString(16).padStart(8, '0');
  return { version: STAMP_VERSION, themeId, memberId, frame, motionPolicy, anchor, content };
}

// A HALF-WRITTEN STAMP MUST NOT READ AS A GOOD ONE. `install pets` can be
// interrupted between writes, and a stamp validated on `version` alone would let
// a torn install satisfy the asset gate. Type-checking is not validation either:
// `frame: {}` and `motionPolicy: "bogus"` are the right types and describe a pet
// that could not have been compiled.
//
// Absent, unparseable, foreign and invalid are all one answer -- null -- and the
// caller decides what it means; throwing here would make an old install a crash.
export function readStamp(dir) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  if (data.version !== STAMP_VERSION) return null;
  if (typeof data.themeId !== 'string' || data.themeId === '') return null;
  if (typeof data.memberId !== 'string' || data.memberId === '') return null;
  if (typeof data.content !== 'string' || !HEX8.test(data.content)) return null;
  if (typeof data.frame !== 'object' || data.frame === null) return null;
  if (!FRAME_FIELDS.every((field) => positiveInt(data.frame[field]))) return null;
  if (!STAMP_POLICIES.has(data.motionPolicy)) return null;
  if (!STAMP_ANCHORS.has(data.anchor)) return null;
  return data;
}
