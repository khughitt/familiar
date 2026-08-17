.pragma library

// QML JavaScript cannot import the portable ES module. This strict validation
// table deliberately mirrors STATES from familiar-theme; the Node test
// binds them so a protocol addition cannot silently strand this reader.
var STATES = {
  idle: true,
  working: true,
  'needs-input': true,
  'needs-approval': true,
  error: true,
  done: true,
};
var POLICIES = { full: true, reduced: true, off: true };
var PRIORITY = { done: 1, error: 2 };

function parseIntent(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { intent: {}, error: 'intent.json: empty' };
  }
  var data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { intent: {}, error: 'intent.json: invalid json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { intent: {}, error: 'intent.json: not an object' };
  }
  var ids = Object.keys(data);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var record = data[id];
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || !record.current || typeof record.current !== 'object'
        || Array.isArray(record.current)) {
      return { intent: {}, error: 'intent.json: session "' + id + '" has no current intent' };
    }
    var current = record.current;
    if (!STATES[current.state]) {
      return { intent: {}, error: 'intent.json: session "' + id + '" has invalid state' };
    }
    if (!POLICIES[current.motionPolicy]) {
      return { intent: {}, error: 'intent.json: session "' + id + '" has invalid motionPolicy' };
    }
    if (!current.sprite || typeof current.sprite !== 'object'
        || typeof current.sprite.terminal !== 'string'
        || current.sprite.terminal === '') {
      return { intent: {}, error: 'intent.json: session "' + id + '" has invalid sprite.terminal' };
    }
  }
  return { intent: data, error: null };
}

function candidateFor(sessionId, current) {
  return {
    sessionId: sessionId,
    state: current.state,
    motionPolicy: current.motionPolicy,
    sprite: current.sprite.terminal,
  };
}

function outranks(left, right) {
  if (right === null) return true;
  if (PRIORITY[left.state] !== PRIORITY[right.state]) {
    return PRIORITY[left.state] > PRIORITY[right.state];
  }
  return left.sessionId < right.sessionId;
}

function observe(intent, previousStates, initialized) {
  var states = {};
  var candidate = null;
  var ids = Object.keys(intent).sort();
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var current = intent[id].current;
    states[id] = current.state;
    if (!initialized || !PRIORITY[current.state] || previousStates[id] === current.state) continue;
    var next = candidateFor(id, current);
    if (outranks(next, candidate)) candidate = next;
  }
  return { states: states, candidate: candidate };
}

function decidePlayback(activeState, candidate) {
  if (candidate === null) return { action: 'none', mode: null };
  if (activeState === null) return { action: 'start', mode: candidate.motionPolicy };
  if (activeState === 'done' && candidate.state === 'error') {
    return { action: 'preempt', mode: candidate.motionPolicy };
  }
  return { action: 'drop', mode: null };
}

function parseFocusedOutput(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { name: null, error: 'focused-output: empty response' };
  }
  var data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { name: null, error: 'focused-output: invalid json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { name: null, error: 'focused-output: not an object' };
  }
  if (typeof data.name !== 'string' || data.name === '') {
    return { name: null, error: 'focused-output: missing name' };
  }
  return { name: data.name, error: null };
}
