import { createSpriteState } from './sprite-state.js';
import { placeAt, hidePlacement, freeImage, cellBox } from './sprite.js';
import { loadAnimationRefSync } from 'familiar-theme';
import { planAnimation } from '../../src/animation/program.js';
import { encodeKittyProgram } from '../../src/render/term/kitty-animation.js';
import { GRAPHICS_CAPABILITY } from '../../src/render/term/capability.js';

export function createSpriteRuntime({
  pid, stateDir, intentPath, imageId, placementId, maxRows, capability,
  now, setTimer, clearTimer,
  ensureDirectory, watchDirectory, readIntent, readPng, sizePng,
  loadAnimation = loadAnimationRefSync,
  plan = planAnimation,
  encode = encodeKittyProgram,
  writeTerminal, renderer, onPoseChange, logError,
}) {
  for (const [name, value] of Object.entries({
    now, setTimer, clearTimer, ensureDirectory, watchDirectory, readIntent,
    readPng, sizePng, loadAnimation, plan, encode, writeTerminal, onPoseChange, logError,
  })) {
    if (typeof value !== 'function') throw new TypeError(`sprite-runtime: ${name} must be a function`);
  }
  if (!renderer || typeof renderer.requestRender !== 'function' || typeof renderer.once !== 'function') {
    throw new TypeError('sprite-runtime: renderer must provide requestRender and once');
  }
  const removeRendererListener = renderer.off ?? renderer.removeListener;
  if (typeof removeRendererListener !== 'function') {
    throw new TypeError('sprite-runtime: renderer must provide off or removeListener');
  }
  if (!Object.values(GRAPHICS_CAPABILITY).includes(capability)) {
    throw new TypeError(`sprite-runtime: unknown graphics capability ${JSON.stringify(capability)}`);
  }

  let disposing = false;
  let started = false;
  let refreshing = false;
  let refreshAgain = false;
  let watcher = null;
  let boxX = 0, boxY = 0, boxW = 0, boxH = 0;
  let renderedThisFrame = false;
  let poseW = 0, poseH = 0;
  let placeC = 0, placeR = 0, sizedForBox = '';
  let recoveryHidePending = false;
  let successfulImage = false;
  let outputFailureLatched = false;
  let cleanupPending = false;
  let settleCleanup = null;
  let disposePromise = null;

  const state = createSpriteState(pid, {
    now, setTimer, clearTimer, capability,
    requestRender: () => renderer.requestRender(),
    onPoseChange: (pose) => onPoseChange(pose ? Math.min(pose.sprite.rows, maxRows) : 0),
  });

  const message = (prefix, error) => logError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);

  function writeSucceeded(output) {
    writeTerminal(output);
    outputFailureLatched = false;
  }

  function writeNormal(output) {
    try {
      writeSucceeded(output);
      return true;
    } catch (error) {
      if (!outputFailureLatched) message('sprite frame', error);
      outputFailureLatched = true;
      return false;
    }
  }

  async function refresh() {
    if (disposing) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      const intent = (await readIntent(intentPath)) ?? {};
      if (!disposing) state.apply(intent);
    } catch (error) {
      message('sprite refresh', error);
    } finally {
      refreshing = false;
      const again = refreshAgain;
      refreshAgain = false;
      if (again && !disposing) void refresh();
    }
  }

  function attachWatch() {
    if (disposing) return;
    try {
      ensureDirectory(stateDir);
      const next = watchDirectory(stateDir, (_event, filename) => {
        if (filename === 'intent.json') void refresh();
      });
      let replaced = false;
      const replace = () => {
        if (replaced) return;
        replaced = true;
        if (watcher === next) watcher = null;
        if (disposing) return;
        attachWatch();
        void refresh();
      };
      next.on('error', (error) => {
        message('sprite watch error', error);
        try { next.close(); } catch (closeError) { message('sprite watch close', closeError); }
        replace();
      });
      next.on('close', replace);
      watcher = next;
    } catch (error) {
      message('sprite watch attach', error);
    }
  }

  async function start() {
    if (started) throw new Error('sprite-runtime: start called more than once');
    started = true;
    attachWatch();                         // attach before the authoritative read
    await refresh();
  }

  function captureBox({ x, y, width, height }) {
    boxX = x; boxY = y; boxW = width; boxH = height;
    renderedThisFrame = true;
  }

  function recoverPlacement() {
    if (!writeNormal(hidePlacement(imageId, placementId))) return false;
    recoveryHidePending = false;
    successfulImage = false;
    state.markPlacementHidden();           // only after terminal hide is confirmed
    return true;
  }

  function installProgram(record) {
    if (boxW < 1 || boxH < 1) return false;

    const set = loadAnimation(record.animation);
    const program = plan({
      set,
      root: record.sprite.terminal,
      state: record.state,
      sessionId: record.sessionId,
      policy: record.motionPolicy,
      capability,
    });
    if (program.kind === 'none') {
      throw new Error('sprite-runtime: visible record produced no animation program');
    }

    const frameCache = new Map();
    const readFrame = (path) => {
      if (!frameCache.has(path)) frameCache.set(path, Buffer.from(readPng(path)));
      return frameCache.get(path);
    };
    const rootBytes = readFrame(record.sprite.terminal);
    const { w, h } = sizePng(rootBytes);
    const box = cellBox(w, h, boxW, boxH);
    const lifecycle = capability === GRAPHICS_CAPABILITY.STATIC || !successfulImage
      ? 'create'
      : 'update';
    const encoded = encode(program, {
      id: imageId,
      placement: { kind: 'normal', cols: box.c, rows: box.r },
      lifecycle,
      readFrame,
    });
    writeSucceeded(encoded.bytes);
    successfulImage = true;
    poseW = w;
    poseH = h;
    placeC = box.c;
    placeR = box.r;
    sizedForBox = `${boxW}x${boxH}`;
    return true;
  }

  function frame() {
    try {
      if (cleanupPending) {
        try { writeSucceeded(freeImage(imageId)); }
        catch (error) { message('sprite cleanup', error); }
        finally { cleanupPending = false; settleCleanup?.(); }
        return;
      }
      if (disposing) return;
      if (recoveryHidePending) {
        recoverPlacement();                // remains pending if this write fails
        return;
      }

      state.observeExpiry();
      const change = state.peekChange();
      if (change) {
        try {
          if (change.placement === 'visible') {
            if (!installProgram(change.record)) return;
          } else {
            writeSucceeded(hidePlacement(imageId, placementId));
            poseW = 0; poseH = 0;
          }
          state.commitChange();             // write before commit
        } catch (error) {
          message('sprite change', error);
          state.failChange();               // once per controller generation
          poseW = 0; poseH = 0; sizedForBox = '';
          if (change.placement === 'visible') {
            recoveryHidePending = true;
            recoverPlacement();             // same frame; persists if the hide fails
          } else {
            recoveryHidePending = true;      // desired hide retries on the next frame
          }
          return;
        }
      }

      const pose = state.currentPose();
      if (!pose || !poseW) return;
      if (!renderedThisFrame) {
        writeNormal(hidePlacement(imageId, placementId));
        return;
      }
      const boxKey = `${boxW}x${boxH}`;
      if (boxKey !== sizedForBox) {
        const box = cellBox(poseW, poseH, boxW, boxH);
        placeC = box.c; placeR = box.r; sizedForBox = boxKey;
      }
      writeNormal(placeAt(boxY + 1, boxX + 1, imageId, placementId, placeC, placeR));
    } catch (error) {
      if (!outputFailureLatched) message('sprite frame', error);
      outputFailureLatched = true;
    } finally {
      renderedThisFrame = false;
    }
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposing = true;
    try { watcher?.close(); } catch (error) { message('sprite watch close', error); }
    watcher = null;
    state.dispose();
    disposePromise = new Promise((resolve) => {
      let settled = false;
      const onDestroy = () => finish();
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          removeRendererListener.call(renderer, 'destroy', onDestroy);
        } catch (error) {
          message('sprite cleanup listener', error);
        } finally {
          cleanupPending = false;
          settleCleanup = null;
          resolve();
        }
      };
      settleCleanup = finish;
      cleanupPending = true;
      if (renderer.isDestroyed) return finish();
      try {
        renderer.once('destroy', onDestroy);
        renderer.requestRender();
      } catch (error) {
        try { message('sprite cleanup request', error); }
        finally { finish(); }
      }
    });
    return disposePromise;
  }

  return { start, captureBox, frame, dispose };
}
