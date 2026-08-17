import { fileURLToPath, pathToFileURL } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/familiar', import.meta.url));
const forwardedArgs = process.argv.slice(2);
Object.defineProperty(process.stdout, 'isTTY', { value: true });
process.argv = [process.argv[0], bin, ...forwardedArgs];
await import(pathToFileURL(bin).href);
