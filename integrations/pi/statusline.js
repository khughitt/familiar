// PI'S FOOTER AS FAMILIAR'S STATUS LINE. pi has no status-line command: an extension replaces
// the footer with a component pi redraws on every frame. So the footer never runs familiar
// from render(); it keeps the last lines `familiar statusline` printed and refreshes them on
// pi's events and a slow poll. Everything but the pi-tui helpers lives here, so the wiring is
// tested against a fake pi; index.ts only hands those helpers in.
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

// pi's events that can change a field the line shows.
export const REFRESH_EVENTS = Object.freeze([
  'agent_start', 'agent_end', 'turn_end', 'tool_execution_end', 'model_select',
  'thinking_level_select', 'session_compact', 'session_tree',
]);

export function commandFrom(env) {
  return env.FAMILIAR_BIN || 'familiar';
}

// pi's own footer names the model by id and adds the thinking level for a reasoning model,
// reading an unset level as off; the HUD's model slot keeps that wording.
export function modelLabel(model, thinkingLevel) {
  if (!model) return null;
  if (!model.reasoning) return model.id;
  const level = thinkingLevel || 'off';
  return `${model.id} • ${level === 'off' ? 'thinking off' : level}`;
}

// What pi's footer does to another extension's setStatus text: one line, single-spaced.
export function sanitizeStatus(text) {
  return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
}

// The session id is pi's own, bare: the key of the session's bus record, whose relay agent id
// is `pi:<id>`. `product` is how claimSession names that agent id to tasks.
export function statuslinePayload({ sessionId, cwd, model, thinkingLevel, contextUsage }) {
  return {
    session_id: sessionId,
    product: 'pi',
    cwd,
    workspace: { current_dir: cwd },
    model: { display_name: modelLabel(model, thinkingLevel) },
    context_window: { used_percentage: contextUsage?.percent ?? null },
  };
}

const lastLine = (text) => text.trim().split('\n').at(-1) ?? '';

// One `familiar statusline` run: { lines } or { fault }. Exit 0 with stderr beside a line is
// a warning (a tasks lookup that timed out, a visual fault); Claude Code shows the line and
// drops the warning, and so does this. Exit 0 with NOTHING on stdout is not a line: familiar
// reports its own errors under `statusline` that way (a cosmetic command, bin/familiar.js),
// and the HUD without --with always prints its rows.
export function runStatusline({ command, args = ['statusline'], payload, env, timeoutMs = TIMEOUT_MS, signal }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
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
    timer.unref();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      if (error.name === 'AbortError') resolve({ fault: 'aborted' });
      else resolve({ fault: `${command}: ${error.code === 'ENOENT' ? 'not found on PATH' : error.message}` });
    });
    child.on('close', (code, signalName) => {
      clearTimeout(timer);
      if (signal?.aborted) resolve({ fault: 'aborted' });
      else if (timedOut) resolve({ fault: `timed out after ${timeoutMs}ms` });
      else if (code !== 0) {
        const detail = lastLine(stderr);
        resolve({ fault: `exited ${code ?? signalName}${detail ? `: ${detail}` : ''}` });
      } else if (stdout === '') resolve({ fault: lastLine(stderr) || 'no output' });
      else resolve({ lines: stdout.replace(/\n$/, '').split('\n') });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// At most one run at a time, and at most one queued behind it: a burst of pi events while
// familiar runs collapses into a single follow-up that sees the latest state. A task that
// throws rejects its caller and leaves the next call free to run.
export function singleFlight(task) {
  let running = null;
  let queued = false;
  const loop = async () => {
    try {
      do {
        queued = false;
        await task();
      } while (queued);
    } finally {
      running = null;
    }
  };
  return () => {
    if (running) queued = true;
    else running = loop();
    return running;
  };
}

const every = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

// THE EXTENSION. Only a terminal session gets the footer: pi sets hasUI in RPC mode too, where
// setFooter does nothing, so `mode` is the gate. One session at a time owns the state below;
// stop() ends it on shutdown or when another extension replaces this footer, aborts a run in
// flight, and makes any result still arriving land nowhere.
export function installStatusline(pi, {
  truncateToWidth, command, env, run = runStatusline, schedule = every, pollMs = POLL_MS,
}) {
  let session = null;

  const stop = () => {
    if (!session) return;
    session.cancelPoll?.();
    session.abort?.abort();
    session = null;
  };

  const refresh = singleFlight(async () => {
    const current = session;
    if (!current) return;
    const abort = new AbortController();
    current.abort = abort;
    let result;
    try {
      const ctx = current.ctx;
      const payload = statuslinePayload({
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        contextUsage: ctx.getContextUsage(),
      });
      result = await run({ command, payload, env, signal: abort.signal });
    } catch (error) {
      result = { fault: error.message };
    } finally {
      current.abort = undefined;
    }
    if (session !== current) return;
    if ('lines' in result) {
      current.lines = result.lines;
      current.fault = null;
    } else {
      current.fault = result.fault;
    }
    current.requestRender?.();
  });
  const kick = () => { refresh().catch(() => {}); };

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    stop();
    const current = { ctx, lines: [], fault: null, requestRender: undefined, cancelPoll: undefined, abort: undefined };
    ctx.ui.setFooter((tui, theme, footerData) => {
      current.requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(kick);
      return {
        dispose() {
          unsubscribe();
          current.requestRender = undefined;
          if (session === current) stop();
        },
        invalidate() {},
        render(width) {
          const out = current.lines.map((line) => truncateToWidth(line, width));
          if (current.fault !== null) out.push(truncateToWidth(theme.fg('error', `familiar statusline: ${current.fault}`), width));
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const text = [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => sanitizeStatus(s)).join(' ');
            out.push(truncateToWidth(text, width, theme.fg('dim', '...')));
          }
          return out;
        },
      };
    });
    session = current;
    current.cancelPoll = schedule(kick, pollMs);
    kick();
  });

  // Not awaited: a familiar run must never hold up pi's event loop.
  for (const event of REFRESH_EVENTS) {
    pi.on(event, async (_event, ctx) => {
      if (!session) return;
      session.ctx = ctx;
      kick();
    });
  }

  pi.on('session_shutdown', async () => stop());
}
