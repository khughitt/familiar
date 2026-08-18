import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { writeJsonAtomic } from '../bus/store.js';

export function receiptPath(paths, id) {
  return join(paths.themeReceiptsDir, `${id}.json`);
}

export async function writeReceipt(paths, receipt) {
  await writeJsonAtomic(receiptPath(paths, receipt.id), receipt);
}

const HEX40 = /^[0-9a-f]{40}$/;

function invalidReason(data, id) {
  if (typeof data !== 'object' || data === null) return 'not an object';
  if (data.id !== id) return `embedded id ${JSON.stringify(data.id)} does not match the filename`;
  const { source } = data;
  if (typeof source !== 'object' || source === null) return 'source is not an object';
  if (source.kind === 'https') {
    if (typeof source.url !== 'string' || !source.url.startsWith('https://')) return 'source.url is not an https URL';
    if (typeof source.commit !== 'string' || !HEX40.test(source.commit)) return 'source.commit is not a 40-hex sha';
  } else if (source.kind === 'local') {
    if (typeof source.path !== 'string' || !isAbsolute(source.path)) return 'source.path is not an absolute path';
  } else {
    return `unknown source.kind ${JSON.stringify(source.kind)}`;
  }
  if (typeof data.installedAt !== 'string' || Number.isNaN(Date.parse(data.installedAt))) {
    return 'installedAt is not an ISO-8601 date';
  }
  return null;
}

export function readReceipt(paths, id, { readFile = readFileSync } = {}) {
  let text;
  try {
    text = readFile(receiptPath(paths, id), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { verdict: 'absent' };
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { verdict: 'invalid', reason: `unparseable JSON: ${error.message}` };
  }
  const reason = invalidReason(data, id);
  if (reason !== null) return { verdict: 'invalid', reason };
  return { verdict: 'validated', receipt: data };
}
