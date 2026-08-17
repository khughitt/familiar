// The record/decay controller. Owns which pose is displayed and when a transient state
// decays, with all timing injected so the supersession logic is tested against a fake
// clock rather than a copy embedded in the .tsx shell. It NEVER writes to the terminal:
// it records a pending CHANGE and calls requestRender(); the frame does the writing.
import { displayedIntent } from '../../src/protocol/intent.js';
import { programIdentityOf, recordForPid } from './sprite.js';

export function createSpriteState(pid, {
  now, setTimer, clearTimer, requestRender, onPoseChange, capability,
}) {
  if (typeof onPoseChange !== 'function') {
    throw new TypeError('sprite-state: onPoseChange must be a function');
  }

  let record = null;        // raw IntentRecord { current, expiresAt, after } or null
  let committedProgramIdentity = null;
  let committedPlacement = 'hidden';
  let pending = null;       // null or { record, programIdentity, placement }
  let timer = null;
  let generation = 0;       // bumped on every apply/dispose/decay; guards async timer callbacks
  let failedGen = -1;       // the generation whose pending change last FAILED to write (-1 = none)
  let expiryHandled = false;

  function currentPose() {
    return displayedIntent(record, now());
  }

  function cancelTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  function decay(gen) {
    if (gen !== generation || expiryHandled) return;
    expiryHandled = true;
    cancelTimer();
    generation++;           // decay is a new event, regardless of which path observes it
    evaluate();
  }

  function armTimer() {
    if (!record || record.expiresAt == null) return; // == null: both null and undefined
    const gen = generation;
    const delay = Math.max(0, record.expiresAt - now());
    timer = setTimer(() => decay(gen), delay);
  }

  function desiredState(pose) {
    const visible = pose !== null && capability !== 'none' && pose.motionPolicy !== 'off';
    return {
      record: pose,
      programIdentity: visible ? programIdentityOf(pose, capability) : null,
      placement: visible ? 'visible' : 'hidden',
    };
  }

  // Compare desired state with the program and placement that a frame actually
  // committed. Callbacks only queue this compact record; they never load assets,
  // encode protocol bytes, or write to the terminal.
  function evaluate() {
    const pose = currentPose();
    const desired = desiredState(pose);
    onPoseChange(desired.placement === 'visible' ? pose : null);
    if (
      desired.programIdentity === committedProgramIdentity
      && desired.placement === committedPlacement
    ) {
      pending = null;
      return;
    }
    pending = desired;
    requestRender();
  }

  // Apply a freshly-read intent map (or null). Cancels the old timer FIRST, then bumps
  // the generation so any already-scheduled callback becomes inert.
  function apply(intent) {
    cancelTimer();
    generation++;
    record = recordForPid(intent, pid);
    expiryHandled = false;
    armTimer();
    evaluate();
  }

  function observeExpiry() {
    if (!record || record.expiresAt == null || now() < record.expiresAt) return;
    decay(generation);
  }

  // The pending change, WITHOUT consuming it — or null if nothing is pending OR the pending
  // change already FAILED to write at the current generation. That gate is the whole of the
  // "retry on the next watch event" contract (design §6): a persistent failure (a missing PNG)
  // is offered once per generation, and generation only advances on a real event (apply / decay),
  // so the frame never re-reads a broken file and floods the log at 60fps. It stays idempotent
  // within a generation, so a transient failure is still retried on the next event.
  function peekChange() {
    if (pending === null || failedGen === generation) return null;
    return pending;
  }

  // Acknowledge the peeked change as rendered. Called by the frame only after
  // the terminal write succeeds, so queued state cannot outrun the writer.
  function commitChange() {
    if (pending === null) return;
    committedProgramIdentity = pending.programIdentity;
    committedPlacement = pending.placement;
    pending = null;
  }

  // The frame calls this when the change's terminal write threw. Mark this generation's change
  // failed so peekChange stops offering it until the next apply()/decay advances the generation.
  function failChange() {
    failedGen = generation;
  }

  // A recovery hide is separate from the pending desired pose change. Clear what is confirmed
  // to be on screen, then re-evaluate in case an intervening apply cancelled work against the
  // formerly-visible program. failedGen remains untouched, so the same failed successor stays gated.
  function markPlacementHidden() {
    committedProgramIdentity = null;
    committedPlacement = 'hidden';
    evaluate();
  }

  function dispose() {
    cancelTimer();
    generation++;
    record = null;
    pending = null;
  }

  return {
    apply,
    observeExpiry,
    peekChange,
    commitChange,
    failChange,
    markPlacementHidden,
    currentPose,
    dispose,
    get programIdentity() { return committedProgramIdentity; },
  };
}
