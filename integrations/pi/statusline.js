// PI'S FOOTER AS FAMILIAR'S STATUS LINE. pi has no status-line command: an extension replaces
// the footer with a component pi redraws on every frame. So the extension never runs familiar
// from render(); it keeps the last lines `familiar statusline` printed and refreshes them on
// pi's events and a slow poll. This file is the part that runs without pi: the payload, the
// child run and the single-flight refresh. index.ts wires it to pi.
//
// THE PAYLOAD IS CLAUDE-SHAPED, as agy's is (docs/surfaces.md#terminal-and-statusline): the
// fields readFields (src/render/term/statusfields.js) reads, and nothing else.
import { spawn } from 'node:child_process';

// A refresh runs familiar once. Claude Code cancels a status line past its interval; here the
// deadline is ours, and past it the footer says so rather than keeping stale lines silently.
export const TIMEOUT_MS = 2_000;
// Events cover what pi changes. The poll covers what pi does not see: a task claimed or
// released from a shell, a stage gate recorded by another session.
export const POLL_MS = 10_000;

// pi's own footer names the model by id and adds the thinking level for a reasoning model;
// the HUD's model slot keeps that wording so the two read the same.
export function modelLabel(model, thinkingLevel) {
  if (!model) return null;
  if (!model.reasoning) return model.id;
  return `${model.id} • ${thinkingLevel === 'off' ? 'thinking off' : thinkingLevel}`;
}

// `pi:<session id>` is the key relay's planned pi adapter names pi sessions by. Until
// that adapter exists no bus record carries it, so the HUD renders uncoloured with no image;
// the render cache is still keyed per session.
export function statuslinePayload({ sessionId, cwd, model, thinkingLevel, contextUsage }) {
  return {
    session_id: `pi:${sessionId}`,
    cwd,
    workspace: { current_dir: cwd },
    model: { display_name: modelLabel(model, thinkingLevel) },
    context_window: { used_percentage: contextUsage?.percent ?? null },
  };
}

// One `familiar statusline` run: { lines } on exit 0, { fault } otherwise. Exit 0 with stderr
// is a line plus a warning (a tasks lookup that timed out, a visual fault); Claude Code shows
// the line and drops the warning, and so does this.
export function runStatusline({ command, args = ['statusline'], payload, env, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ fault: `${command}: ${error.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ fault: `${command}: ${error.code === 'ENOENT' ? 'not found on PATH' : error.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ fault: `timed out after ${timeoutMs}ms` });
      else if (code !== 0) {
        const detail = stderr.trim().split('\n').at(-1) ?? '';
        resolve({ fault: `exited ${code ?? signal}${detail ? `: ${detail}` : ''}` });
      } else resolve({ lines: stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n') });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// At most one run at a time, and at most one queued behind it: a burst of pi events while
// familiar runs collapses into a single follow-up that sees the latest state.
export function singleFlight(task) {
  let running = null;
  let queued = false;
  const loop = async () => {
    do {
      queued = false;
      await task();
    } while (queued);
    running = null;
  };
  return () => {
    if (running) queued = true;
    else running = loop();
    return running;
  };
}
