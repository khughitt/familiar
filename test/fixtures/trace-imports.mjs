// Preloaded with `node --import`: appends the URL of every file module the process loads
// to $FAMILIAR_TRACE_IMPORTS, one per line, so a test can assert what a command imported.
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';

const out = process.env.FAMILIAR_TRACE_IMPORTS;
if (!out) throw new Error('trace-imports: FAMILIAR_TRACE_IMPORTS must name the trace file');
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) appendFileSync(out, `${url}\n`);
    return nextLoad(url, context);
  },
});
