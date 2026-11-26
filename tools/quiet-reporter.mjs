// node:test's spec reporter with passing tests left out, so a green run costs an agent a
// few lines of context instead of one per test. Everything else reaches spec unchanged:
// failures in full and their closing recap, skips and todos, what the tests print, and
// the closing totals (`ℹ tests N`) that tools/tt counts.
import { Readable } from 'node:stream';
import { spec } from 'node:test/reporters';

// spec prints a header for every test that started and has not finished, so a test's start
// is left out too; a failure still names its file and line in the closing recap.
export const isQuiet = (event) => event.type === 'test:start'
  || (event.type === 'test:pass' && !event.data.skip && !event.data.todo);

async function* withoutPasses(source) {
  for await (const event of source) {
    if (!isQuiet(event)) yield event;
  }
}

export default async function* quiet(source) {
  yield* Readable.from(withoutPasses(source)).pipe(new spec());
}
