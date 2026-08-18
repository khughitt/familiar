import {
  createReadStream, createWriteStream, lstatSync, mkdirSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { stripVTControlCharacters } from 'node:util';

// Transport rule (spec §1): HTTPS URLs and local directories, nothing else.
// Credentialed URLs are refused because the given URL is persisted in the
// receipt and printed by `theme list` — accepting one stores and displays a
// secret. Private repos use a local clone plus `theme add ./dir`.
export function classifySource(raw, { stat = statSync } = {}) {
  if (raw.startsWith('https://')) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(
        `theme add: sources are HTTPS URLs or local directories — got ${JSON.stringify(raw)}`
      );
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error(
        'theme add: credentials in the URL would be stored in the receipt and shown by `theme list` — use a credential-free HTTPS URL, or clone privately and add the local directory'
      );
    }
    return { kind: 'https', url: raw };
  }
  if ((/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw))
    || /^[^/\s:@]+@[^/\s:]+:/.test(raw)) {
    throw new Error(
      `theme add: sources are HTTPS URLs or local directories — got ${JSON.stringify(raw)}`
    );
  }
  const path = resolve(raw);
  let st;
  try {
    st = stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`theme add: no directory at ${path}`);
    throw error;
  }
  if (!st.isDirectory()) throw new Error(`theme add: ${path} is not a directory`);
  return { kind: 'local', path };
}

// Remote git diagnostics are untrusted terminal input. ANSI stripping alone
// leaves bare \r (git progress uses it), backspace and BEL live, any of
// which can rewrite the visible line — so after stripping ANSI, CR/LF both
// split lines and every remaining C0/C1 control is replaced (spec §4).
export function collapseStderr(text) {
  return stripVTControlCharacters(String(text))
    .split(/\r\n|\r|\n/)
    .map((line) => line.replaceAll(/\p{Cc}/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .join('; ');
}

// The defensive copy (spec §3). Validation runs only AFTER acquisition, so
// the copy itself must refuse what it cannot safely materialize: it walks
// with lstat and never dereferences — a symlink, FIFO, socket or device is
// rejected by path, never opened, never recreated in staging. `.git` at any
// depth is excluded; git is never invoked on the source. Regular files are
// copied by abortable streaming because fs.copyFile/fs.cp accept no
// AbortSignal, and the wall clock must be able to stop a stalled file.
export async function copySource(sourceDir, dest, { signal } = {}) {
  const sourceReal = realpathSync(sourceDir);
  const destReal = realpathSync(dest);
  if (destReal === sourceReal || destReal.startsWith(sourceReal + sep)) {
    throw new Error(
      `theme add: staging at ${destReal} lies inside the source ${sourceReal} — a self-copy would never terminate`
    );
  }
  await copyTree(sourceReal, destReal, signal);
}

async function copyTree(from, to, signal) {
  const entries = readdirSync(from, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const src = join(from, entry.name);
    const out = join(to, entry.name);
    const st = lstatSync(src);
    if (st.isDirectory()) {
      mkdirSync(out);
      await copyTree(src, out, signal);
    } else if (st.isFile()) {
      try {
        await pipeline(createReadStream(src), createWriteStream(out, { flags: 'wx' }), { signal });
      } catch (error) {
        throw signal?.aborted ? signal.reason : error;
      }
    } else {
      throw new Error(
        `theme add: ${src} is not a regular file or directory — the source must contain only files and directories`
      );
    }
  }
}
