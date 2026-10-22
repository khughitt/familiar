const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireField = (valid, message) => {
  if (!valid) throw new Error(`observe: ${message}`);
};

export function parseEnvelope(text) {
  requireField(text.trim() !== '', 'empty input (expected one relay observer envelope)');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('observe: invalid JSON (expected one relay observer envelope)');
  }
  requireField(object(value), 'expected an observer envelope object');
  requireField(value.schema === 1, 'expected schema 1');
  requireField(['event', 'reconcile'].includes(value.type), 'type must be event or reconcile');
  requireField(typeof value.subscriber === 'string', 'subscriber must be a string');
  if (value.type === 'event') {
    requireField(object(value.event), 'event must be an object');
    for (const key of ['kind', 'harness', 'agentId', 'sessionId', 'cwd']) {
      requireField(typeof value.event[key] === 'string', `event.${key} must be a string`);
    }
    if (Object.hasOwn(value.event, 'root')) {
      requireField(typeof value.event.root === 'string', 'event.root must be a string');
    }
  } else {
    requireField(value.event === null, 'reconcile event must be null');
  }
  requireField(object(value.registry), 'registry must be an object');
  requireField(value.registry.generation === null || typeof value.registry.generation === 'string', 'registry.generation must be a string or null');
  requireField(value.registry.revision === null || Number.isFinite(value.registry.revision), 'registry.revision must be a number or null');
  requireField(typeof value.changed === 'boolean', 'changed must be a boolean');
  requireField(Array.isArray(value.reaped) && value.reaped.every((id) => typeof id === 'string'), 'reaped must be a string array');
  return value;
}
