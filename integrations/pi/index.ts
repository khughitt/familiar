// familiar's status line in pi's footer. pi loads this directory as an extension
// (index.ts entry point); docs/surfaces.md#pi says how to install it. The child run, payload
// and refresh policy live in statusline.js, which runs and is tested without pi.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { POLL_MS, runStatusline, singleFlight, statuslinePayload } from "./statusline.js";

export default function familiarStatusline(pi: ExtensionAPI) {
  // FAMILIAR_BIN names the familiar to run (a worktree's bin/familiar, say); otherwise PATH's.
  const command = process.env.FAMILIAR_BIN ?? "familiar";
  // Set only while a session with a terminal UI is up: print and RPC modes get no footer and
  // never run familiar.
  let ctx: ExtensionContext | undefined;
  let lines: string[] = [];
  let fault: string | null = null;
  let requestRender: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  const refresh = singleFlight(async () => {
    if (!ctx) return;
    const payload = statuslinePayload({
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      model: ctx.model,
      thinkingLevel: pi.getThinkingLevel(),
      contextUsage: ctx.getContextUsage(),
    });
    const result = await runStatusline({ command, payload, env: process.env });
    if ("lines" in result) {
      lines = result.lines;
      fault = null;
    } else {
      fault = result.fault;
    }
    requestRender?.();
  });

  pi.on("session_start", async (_event, context) => {
    if (!context.hasUI) return;
    ctx = context;
    context.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => void refresh());
      return {
        dispose() {
          unsubscribe();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const out = lines.map((line) => truncateToWidth(line, width));
          if (fault !== null) out.push(truncateToWidth(theme.fg("error", `familiar statusline: ${fault}`), width));
          // Other extensions' setStatus texts, as pi's own footer shows them.
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const text = [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s).join(" ");
            out.push(truncateToWidth(text, width, theme.fg("dim", "...")));
          }
          return out;
        },
      };
    });
    clearInterval(poll);
    poll = setInterval(() => void refresh(), POLL_MS);
    void refresh();
  });

  // Not awaited: a familiar run must never hold up pi's event loop.
  const onChange = async (_event: unknown, context: ExtensionContext) => {
    if (!ctx) return;
    ctx = context;
    void refresh();
  };
  for (const event of ["agent_start", "agent_end", "turn_end", "tool_execution_end", "model_select",
    "thinking_level_select", "session_compact"] as const) {
    pi.on(event, onChange);
  }

  pi.on("session_shutdown", async () => {
    clearInterval(poll);
    poll = undefined;
    ctx = undefined;
  });
}
