.pragma library

// The popup is a consumer of shared attention episodes: it plays a moment only for an
// episode the coordinator made eligible and this consumer reserved, and it infers no
// lifecycle of its own. QML JavaScript cannot import the portable ES modules, so the
// few rules it needs are restated here and bound to them by logic.test.mjs.

// Mirrors STATES from familiar-theme (bound by the Node test).
var STATES = {
  idle: true,
  working: true,
  'needs-input': true,
  'needs-approval': true,
  error: true,
  done: true,
};
var KINDS = { 'needs-input': true, 'needs-approval': true, error: true, completion: true };
var DELIVERY = {
  pending: true, eligible: true, reserved: true, delivered: true,
  failed: true, suppressed: true, interrupted: true, uncertain: true,
};
var POLICIES = { full: true, reduced: true, off: true };
var PRIORITY = { error: 0, 'needs-approval': 1, 'needs-input': 2, completion: 3 };
var HEALTH_STALE_MS = 10000;
var BATCH = 512;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function parseAttention(text) {
  if (typeof text !== 'string' || text.trim() === '') return { snapshot: null, error: 'attention.json: empty' };
  var data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { snapshot: null, error: 'attention.json: invalid json' };
  }
  if (!isObject(data) || data.schema !== 1) return { snapshot: null, error: 'attention.json: expected schema 1' };
  if (!isObject(data.episodes) || !isObject(data.desktop) || !isObject(data.diagnostics)) {
    return { snapshot: null, error: 'attention.json: missing episodes, diagnostics or desktop' };
  }
  var ids = Object.keys(data.episodes);
  for (var i = 0; i < ids.length; i++) {
    var episode = data.episodes[ids[i]];
    if (!isObject(episode) || episode.id !== ids[i] || !KINDS[episode.kind]
        || typeof episode.seen !== 'boolean' || typeof episode.dismissed !== 'boolean'
        || typeof episode.closed !== 'boolean') {
      return { snapshot: null, error: 'attention.json: episode "' + ids[i] + '" has an invalid id, kind or disposition' };
    }
    if (!isObject(episode.delivery) || !isObject(episode.delivery.popup) || !isObject(episode.delivery.toast)
        || !DELIVERY[episode.delivery.popup.status] || !DELIVERY[episode.delivery.toast.status]) {
      return { snapshot: null, error: 'attention.json: episode "' + ids[i] + '" has an invalid delivery' };
    }
  }
  if (['on', 'off', 'unknown'].indexOf(data.desktop.dnd) === -1
      || ['known', 'unknown', 'disconnected'].indexOf(data.desktop.status) === -1) {
    return { snapshot: null, error: 'attention.json: desktop has an invalid status or dnd' };
  }
  return { snapshot: data, error: null };
}

// The same rule as healthStatus in src/attention/store.js. A live identity that cannot
// be read is unknown and never matches a saved one.
function validHealth(value) {
  var keys = ['schema', 'instanceId', 'epoch', 'owner', 'writtenAt', 'stopped', 'crashedAt'];
  if (!isObject(value) || Object.keys(value).length !== keys.length) return false;
  for (var i = 0; i < keys.length; i++) if (!Object.prototype.hasOwnProperty.call(value, keys[i])) return false;
  var epoch = value.epoch;
  var owner = value.owner;
  var crashed = value.crashedAt;
  if (!Array.isArray(crashed) || crashed.length > 8 || typeof value.stopped !== 'boolean') return false;
  if (!(Number.isSafeInteger(value.writtenAt) && value.writtenAt >= 0)) return false;
  for (var j = 0; j < crashed.length; j++) {
    if (!Number.isSafeInteger(crashed[j]) || crashed[j] < 0 || crashed[j] > value.writtenAt
        || crashed[j] < value.writtenAt - 600000 || (j > 0 && crashed[j] < crashed[j - 1])) return false;
  }
  return value.schema === 2 && isText(value.instanceId) && value.instanceId.length <= 128
    && isObject(epoch) && Object.keys(epoch).length === 2
    && (epoch.bootId === null || isText(epoch.bootId))
    && (epoch.desktopSession === null || isText(epoch.desktopSession))
    && isObject(owner) && Object.keys(owner).length === 2 && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.start === 'string' && /^(0|[1-9][0-9]*)$/.test(owner.start)
    && Number.isSafeInteger(value.writtenAt) && value.writtenAt >= 0;
}

function healthStatus(health, live) {
  if (health === null || health === undefined) return 'missing';
  if (!validHealth(health) || health.writtenAt > live.now) return 'invalid';
  if (!isText(live.bootId) || !isText(live.desktopSession) || health.epoch.bootId !== live.bootId
      || health.epoch.desktopSession !== live.desktopSession
      || (live.instanceId !== undefined && health.instanceId !== live.instanceId)) return 'mismatched';
  return live.now - health.writtenAt > HEALTH_STALE_MS ? 'stale' : 'healthy';
}

// The attention state plus health, judged against this boot and this desktop session.
function viewOf(state, healthText, live) {
  var status;
  if (typeof healthText !== 'string' || healthText.trim() === '') {
    status = 'missing';
  } else {
    var record = null;
    try {
      record = JSON.parse(healthText);
    } catch (error) {
      record = undefined;
    }
    var options = { now: live.now, bootId: live.bootId, desktopSession: live.desktopSession };
    if (state.desktop.instanceId !== null) options.instanceId = state.desktop.instanceId;
    status = record === undefined ? 'invalid' : healthStatus(record, options);
  }
  var view = {};
  var keys = Object.keys(state);
  for (var i = 0; i < keys.length; i++) view[keys[i]] = state[keys[i]];
  view.health = { status: status };
  return view;
}

// What this consumer attached to is history: suppress it, at most BATCH IDs a request.
function initialBatches(snapshot) {
  var ids = [];
  var keys = Object.keys(snapshot.episodes);
  for (var i = 0; i < keys.length; i++) {
    var status = snapshot.episodes[keys[i]].delivery.popup.status;
    if (status === 'pending' || status === 'eligible') ids.push(keys[i]);
  }
  var batches = [];
  for (var j = 0; j < ids.length; j += BATCH) batches.push(ids.slice(j, j + BATCH));
  return batches;
}

function interruptible(snapshot) {
  return snapshot.health.status === 'healthy' && snapshot.desktop.status === 'known' && snapshot.desktop.dnd === 'off';
}

function eligibleEpisodes(snapshot) {
  var found = [];
  var keys = Object.keys(snapshot.episodes);
  for (var i = 0; i < keys.length; i++) {
    var episode = snapshot.episodes[keys[i]];
    if (!episode.closed && !episode.dismissed && episode.delivery.popup.status === 'eligible') found.push(episode);
  }
  found.sort(function(a, b) { return PRIORITY[a.kind] - PRIORITY[b.kind] || a.order - b.order; });
  return found;
}

// `activeJob` is undefined before this consumer attached, null while idle, and the
// claimed job (with its token and seen-at-claim) while a moment plays.
function nextMoment(snapshot, activeJob) {
  if (activeJob === undefined) return { action: 'initialise', episodeId: null };
  var ready = interruptible(snapshot);
  var eligible = ready ? eligibleEpisodes(snapshot) : [];
  if (activeJob === null) {
    return eligible.length > 0 ? { action: 'claim', episodeId: null } : { action: 'none', episodeId: null };
  }
  var episode = Object.prototype.hasOwnProperty.call(snapshot.episodes, activeJob.episodeId)
    ? snapshot.episodes[activeJob.episodeId] : null;
  // Gone, dismissed, superseded by its source, quietened, or visited after the claim.
  // An episode already seen when claimed keeps its one finite arrival.
  if (!ready || episode === null || episode.closed || episode.dismissed || (episode.seen && !activeJob.seen)) {
    return { action: 'cancel', episodeId: activeJob.episodeId };
  }
  if (activeJob.kind !== 'error' && eligible.length > 0 && eligible[0].kind === 'error') {
    return { action: 'preempt', episodeId: eligible[0].id };
  }
  return { action: 'none', episodeId: null };
}

// How one claimed job plays. Missing art is a failed popup, never another state's image.
function playbackFor(job) {
  var presentation = job.presentation;
  var mode = isObject(presentation) && POLICIES[presentation.motionPolicy] ? presentation.motionPolicy : 'full';
  var choreography = job.kind === 'completion' ? 'done' : job.kind === 'error' ? 'error' : 'peek';
  if (!isObject(presentation) || !isText(presentation.sprite)) {
    return { draw: false, mode: mode, choreography: choreography, sprite: null, error: 'art unavailable for episode ' + job.episodeId };
  }
  return { draw: mode !== 'off', mode: mode, choreography: choreography, sprite: presentation.sprite, error: null };
}

// A finish reply only releases the job whose token it names.
function jobAfterFinish(activeJob, token) {
  if (activeJob === null || activeJob === undefined) return null;
  return activeJob.token === token ? null : activeJob;
}

function encodeRequest(request) {
  return JSON.stringify(request) + '\n';
}

function parseReply(text, op) {
  if (typeof text !== 'string' || text.trim() === '') return { reply: null, error: op + ' reply: empty' };
  var data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { reply: null, error: op + ' reply: invalid json' };
  }
  var valid = isObject(data);
  if (valid && op === 'claim') {
    valid = (data.token === null && data.job === null)
      || (isText(data.token) && isObject(data.job) && isText(data.job.episodeId) && KINDS[data.job.kind] === true
        && STATES[data.job.pose] === true && typeof data.job.seen === 'boolean');
  } else if (valid && op === 'initialise') {
    valid = Array.isArray(data.suppressedIds);
  } else if (valid && op === 'finish') {
    valid = Array.isArray(data.finishedIds);
  } else {
    valid = false;
  }
  return valid ? { reply: data, error: null } : { reply: null, error: op + ' reply: unexpected shape' };
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
