import { fileURLToPath, pathToFileURL } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/familiar', import.meta.url));
const forwardedArgs = process.argv.slice(2);
Object.defineProperty(process.stdout, 'isTTY', { value: true });
// A pretend terminal has a pretend width; tests set it to pin the column count.
if (process.env.TTY_COLUMNS !== undefined) {
  Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.TTY_COLUMNS) });
}

process.argv = [process.argv[0], bin, ...forwardedArgs];
await import(pathToFileURL(bin).href);
