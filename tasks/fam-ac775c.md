---
id: fam-ac775c
title: "Codex 0.160 hooks run under the app-server daemon, so no Codex session reaches the bus"
status: done
priority: 1
size: s
complexity: mid
process: direct
owner: main
created: 2026-10-07T10:25:46Z
updated: 2026-10-07T11:57:06Z
started: 2026-10-07T11:55:31Z
completed: 2026-10-07T11:57:06Z
depends: []
tags: [codex, bug, identity]
model: claude-opus-5-5
agent: claude-code/claude-opus-5-5
---

Symptom: Codex terminals show no project hue (status-bar text, niri-material ring falls back to default dark blue); Claude Code in the same repo shows its slot hue.

Evidence (2026-10-07, Codex 0.160.1):
- agents.json holds no Codex records at all, though ~/.codex/hooks.json runs `familiar hook --agent codex …` for every event.
- A live hook's ancestry: node -> codex app-server --managed-daemon (tty 0) -> codex daemon pid-update-loop -> systemd. The TUI (`codex` on pts/N) is not an ancestor; it talks to the daemon over /tmp/codex-daemon-1000/*.sock.
- src/adapters/codex.js resolveAgentPid requires an ancestor with comm=codex AND a tty, finds none, throws; the top-level boundary turns that into exit 0 + one stderr line, so the failure is silent.
- The hook's environment is the daemon's (PWD, KITTY_WINDOW_ID, KITTY_PID of the terminal that first started the daemon), so env-based terminal facts would be wrong, not just missing.
- `codex features list` shows daemon_auto_start (stable, true). Untested: whether daemon_auto_start=false puts hooks back under the TUI (a pty pilot stalled before its first turn, likely on the directory-trust prompt).

Open: map a hook's session_id/cwd to the owning TUI pid (and its terminal) without the ancestry chain, or require the in-process app server and fail loudly when hooks arrive from the daemon.

## Notes

- 2026-10-07T11:37:00Z (main): pilot 2026-10-07 (codex 0.160.1, tmux pty, trusted non-repo dir): -c features.daemon_auto_start=false does NOT help -- the TUI attaches to the already-running daemon and SessionStart/UserPromptSubmit/Stop all run under it (tty 0), bus stays empty. `codex --no-daemon` ("run without the shared background server, even if it is already running") DOES: hooks' parent is the TUI codex (tty set), resolveAgentPid succeeds, the bus gets a record (pid = TUI) and intent resolves a slot colour. So option 2 = launch codex with --no-daemon; familiar still needs to detect the daemon ancestry and say so loudly instead of exiting silently.
- 2026-10-07T11:55:31Z (main): started
  provenance: {"harness_session":"claude-code:606ce4e5-bf4b-4762-8cf0-a7aa91f09c3a","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-07T11:55:38Z (main): scope: launching with --no-daemon is the user's dotfiles fix; this task makes the codex adapter recognise a daemon-hosted hook and report it naming --no-daemon, instead of the generic 'could not find the codex process' line. Mapping a daemon hook to its TUI (option 1) stays out of scope.
- 2026-10-07T11:57:06Z (fix/codex-daemon-hook): done
  provenance: {"harness_session":"claude-code:606ce4e5-bf4b-4762-8cf0-a7aa91f09c3a","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-07T11:57:06Z (fix/codex-daemon-hook): codex adapter now reports a daemon-hosted hook (Codex 0.160+) with a --no-daemon fix instead of the generic not-found error; launching with --no-daemon is the user-side fix
  provenance: {"harness_session":"claude-code:606ce4e5-bf4b-4762-8cf0-a7aa91f09c3a","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
