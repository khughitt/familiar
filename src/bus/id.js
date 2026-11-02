// familiar-theme's ID_RE and assertId (its src/theme/pack.js), copied rather than
// imported: the hook path and a SessionEnd teardown must not load the theme contract for
// one pattern (test/bin-familiar.test.js traces a teardown). The family file, the
// FAMILIAR_ROLE reader and the sessions.json validator share this one copy.
export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The one reserved role: the member an agent with no role gets (spec §5.1). A record
// says null for that agent, never the word.
export const RESERVED_ROLE = 'default';

export function assertId(id, what, example) {
  if (typeof id !== 'string' || id === '') throw new Error(`${what} is missing`);
  if (!ID_RE.test(id)) {
    throw new Error(
      `${what} "${id}" is invalid — ids may only contain lowercase letters, digits, `
      + `and hyphens (e.g. "${example}")`,
    );
  }
}
