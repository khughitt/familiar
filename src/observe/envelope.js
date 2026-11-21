import { adapterFor } from 'relay';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireField = (valid, message) => {
  if (!valid) throw new Error(`observe: ${message}`);
};

function projectHookEvent(event) {
  requireField(event.schema === 2, 'expected event schema 2');
  const { kind, harness, nativeEvent, cwd, identity, facts } = event;
  requireField(typeof nativeEvent === 'string', 'event.nativeEvent must be a string');
  requireField(identity?.status === 'valid' && object(identity.value), 'event.identity must be a valid Fact');
  const { agentId, sessionId, root } = identity.value;
  const adapter = adapterFor(harness);
  // Codex child hooks publish worker rows with the registry's start and end-of-turn kinds.
  const projected = { kind: adapter.events[nativeEvent]?.kind ?? kind, harness, nativeEvent, cwd, agentId, sessionId };
  if (Object.hasOwn(identity.value, 'root')) projected.root = root;
  const stop = facts?.stopHookActive;
  const execution = facts?.executionNum;
  if (harness === 'agy' && execution?.status === 'valid' && Number.isSafeInteger(execution.value) && execution.value >= 0) {
    projected.stopHookActive = execution.value > 0;
  } else if (stop?.status === 'valid' && typeof stop.value === 'boolean') {
    projected.stopHookActive = stop.value;
  }
  const background = event.private?.backgroundTasks;
  if (background?.status === 'valid') {
    projected.background = adapter.backgroundOf?.({ background_tasks: background.value }, nativeEvent);
  } else if (background?.status === 'invalid') {
    projected.background = null;
  }
  return projected;
}

export function parseEnvelope(text) {
  requireField(text.trim() !== '', 'empty input (expected one relay observer envelope)');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('observe: invalid JSON (expected one relay observer envelope)');
  }
  requireField(object(value), 'expected an observer envelope object');
  requireField(value.schema === 1 || value.schema === 2, 'expected schema 1 or 2');
  requireField(['event', 'reconcile'].includes(value.type), 'type must be event or reconcile');
  requireField(typeof value.subscriber === 'string', 'subscriber must be a string');
  const schema2 = value.schema === 2;
  if (value.type === 'event') {
    requireField(object(value.event), 'event must be an object');
    if (schema2) value.event = projectHookEvent(value.event);
    for (const key of ['kind', 'harness', 'agentId', 'sessionId', 'cwd']) {
      requireField(typeof value.event[key] === 'string', `event.${key} must be a string`);
    }
    if (Object.hasOwn(value.event, 'root')) {
      requireField(typeof value.event.root === 'string', 'event.root must be a string');
    }
  } else {
    if (schema2) {
      requireField(!Object.hasOwn(value, 'event'), 'schema-2 reconcile must omit event');
      value.event = null;
    } else {
      requireField(value.event === null, 'reconcile event must be null');
    }
  }
  requireField(object(value.registry), 'registry must be an object');
  if (schema2) {
    const { status, generation, revision, code } = value.registry;
    if (status === 'ready') {
      requireField(typeof generation === 'string' && Number.isSafeInteger(revision) && revision >= 0,
        'registry.ready requires a generation and revision');
    } else {
      requireField(status === 'unavailable' && typeof code === 'string', 'registry must describe snapshot access');
      value.registry = { generation: null, revision: null };
    }
  } else {
    requireField(value.registry.generation === null || typeof value.registry.generation === 'string', 'registry.generation must be a string or null');
    requireField(value.registry.revision === null || Number.isFinite(value.registry.revision), 'registry.revision must be a number or null');
    requireField(typeof value.changed === 'boolean', 'changed must be a boolean');
  }
  if (!schema2 || value.type === 'reconcile') {
    requireField(Array.isArray(value.reaped) && value.reaped.every((id) => typeof id === 'string'), 'reaped must be a string array');
  }
  return value;
}
