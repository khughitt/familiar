import { readFile } from 'node:fs/promises';
import { STATES } from 'relay';
import { writeJsonAtomic } from './store.js';

export const EMPTY_SESSIONS = { schema: 1, registry: null, sessions: {}, ended: {} };

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const nullableText = (value) => value === null || text(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const pid = (value) => integer(value) && value > 0 && value <= 0xffffffff;
const harness = (value) => ['claude-code', 'codex', 'opencode'].includes(value);

function validHandle(value) {
  return object(value) && ['linux', 'darwin'].includes(value.platform)
    && text(value.host) && nullableText(value.bootId) && pid(value.pid)
    && typeof value.start === 'string' && /^(0|[1-9][0-9]*)$/.test(value.start)
    && BigInt(value.start) <= 0xffffffffffffffffn
    && (value.platform !== 'darwin' || value.bootId === null);
}

function validEnded(value, key) {
  return object(value) && text(value.sessionId) && value.sessionId === key
    && harness(value.harness) && text(value.project) && pid(value.pid)
    && integer(value.starttime) && integer(value.seq);
}

function validSession(value, key) {
  return validEnded(value, key) && value.agentId === `${value.harness}:${key}`
    && object(value.basis) && text(value.basis.generation)
    && value.basis.agentId === value.agentId && text(value.basis.cwd)
    && (value.basis.process === null || validHandle(value.basis.process))
    && text(value.cwd) && value.cwd === value.basis.cwd && text(value.projectKey)
    && nullableText(value.remote) && nullableText(value.repoRoot)
    && nullableText(value.repositoryRoot) && nullableText(value.projectColor)
    && STATES.includes(value.state) && integer(value.updatedAt);
}

export async function readSessions(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(EMPTY_SESSIONS);
    throw error;
  }
  try {
    const value = JSON.parse(contents);
    if (!object(value) || value.schema !== 1) throw new Error('expected schema 1');
    if (value.registry !== null && !(object(value.registry)
      && text(value.registry.generation) && integer(value.registry.revision))) {
      throw new Error('malformed registry');
    }
    for (const [name, validate] of [['sessions', validSession], ['ended', validEnded]]) {
      if (!object(value[name])) throw new Error(`malformed ${name}`);
      for (const [key, record] of Object.entries(value[name])) {
        if (!validate(record, key)) throw new Error(`malformed ${name} entry ${key}`);
      }
    }
    return value;
  } catch (error) {
    throw new Error(`invalid sessions file at ${path}: ${error.message}`);
  }
}

export async function writeSessions(path, value) {
  await writeJsonAtomic(path, value);
}

export function sameBasis(a, b) {
  return a.generation === b.generation && a.agentId === b.agentId && a.cwd === b.cwd
    && a.process !== null && b.process !== null
    && ['platform', 'host', 'bootId', 'pid', 'start'].every((key) => a.process[key] === b.process[key]);
}

export const sessionIdOf = (agentId) => agentId.slice(agentId.indexOf(':') + 1);
