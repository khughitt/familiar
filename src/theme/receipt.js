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
const ISO8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIso8601(value) {
  const match = ISO8601.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  return hour <= 23 && minute <= 59 && second <= 59;
}

function invalidReason(data, id) {
  if (typeof data !== 'object' || data === null) return 'not an object';
  if (data.id !== id) return `embedded id ${JSON.stringify(data.id)} does not match the filename`;
  const { source } = data;
  if (typeof source !== 'object' || source === null) return 'source is not an object';
  if (source.kind === 'https') {
    let url;
    try { url = new URL(source.url); } catch {}
    if (typeof source.url !== 'string' || !url || url.protocol !== 'https:') return 'source.url is not an https URL';
    if (typeof source.commit !== 'string' || !HEX40.test(source.commit)) return 'source.commit is not a 40-hex sha';
  } else if (source.kind === 'local') {
    if (typeof source.path !== 'string' || !isAbsolute(source.path)) return 'source.path is not an absolute path';
  } else {
    return `unknown source.kind ${JSON.stringify(source.kind)}`;
  }
  if (typeof data.installedAt !== 'string' || !isIso8601(data.installedAt)) {
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
