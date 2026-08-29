# SOURCE this, do not execute:   source gate-tools/gate-cell.sh <agent>
# Opens a §5 cell: exports the two per-cell variables, runs the runbook's
# fresh-trace stop-check, and prints the driving checklist for that agent.
# Never calls exit — sourcing a script that exits would close your shell.

_gc_agent="$1"
case "$_gc_agent" in
  claude-code|codex|opencode) ;;
  *) printf 'usage: source gate-tools/gate-cell.sh <claude-code|codex|opencode>\n' >&2; return 2 2>/dev/null || exit 2 ;;
esac
if [ -z "$FAMILIAR_GATE_DIR" ] || [ -z "$FAMILIAR_TERMINAL" ]; then
  printf 'STOP: run §2 first (FAMILIAR_GATE_DIR / FAMILIAR_TERMINAL unset)\n' >&2
  return 2 2>/dev/null || exit 2
fi

# --- WINDOW GUARD: refuse to open a cell from a tab that is not the one whose device
# --- versions-<terminal>.txt recorded. Two cells were lost to exactly this.
_gc_tty="$(tty)"
case "$_gc_tty" in
  /dev/*)
    _gc_rdev="$(node -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).rdev))' "$_gc_tty" 2>/dev/null)"
    if [ -n "$FAMILIAR_GATE_RDEV" ] && [ "$_gc_rdev" != "$FAMILIAR_GATE_RDEV" ]; then
      echo "STOP: wrong window." >&2
      echo "  this tab is $_gc_tty (rdev $_gc_rdev)" >&2
      echo "  the cell device is rdev $FAMILIAR_GATE_RDEV" >&2
      echo "  Driving a cell here writes records that fail --expect-rdev with the" >&2
      echo "  wrong-target message. Move to the gate window and source this again." >&2
      unset _gc_agent _gc_tty _gc_rdev
      return 2 2>/dev/null || exit 2
    fi
    echo "ok: gate window $_gc_tty (rdev $_gc_rdev)"
    ;;
  *)
    echo "STOP: no controlling tty ($_gc_tty) - source this in the gate window" >&2
    unset _gc_agent _gc_tty
    return 2 2>/dev/null || exit 2
    ;;
esac

export FAMILIAR_GATE_AGENT="$_gc_agent"
# optional 2nd arg overrides the trace basename (used by the Node spot-check)
if [ -n "$2" ]; then
  export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/$2"
else
  export FAMILIAR_GATE_TRACE="$FAMILIAR_GATE_DIR/$FAMILIAR_TERMINAL-$FAMILIAR_GATE_AGENT.jsonl"
fi

if [ -e "$FAMILIAR_GATE_TRACE" ]; then
  printf 'STOP: this cell already has a trace: %s\n' "$FAMILIAR_GATE_TRACE" >&2
  printf '      move it aside under a new name; do not delete it, do not append.\n' >&2
else
  printf 'ok: fresh trace for %s\n' "$FAMILIAR_GATE_TRACE"
fi

printf '\n--- cell %s / %s ---\n' "$FAMILIAR_TERMINAL" "$FAMILIAR_GATE_AGENT"
case "$_gc_agent" in
  claude-code)
    cat <<'TXT'
Drive all SIX states, then exit normally. Exact triggers (src/adapters/claude-code.js):
  idle            SessionStart          fires on launch — nothing to do
  working         UserPromptSubmit      submit any prompt (PreToolUse also maps here)
  needs-approval  Notification:permission_prompt
                  a permission prompt must actually be SHOWN on screen.
                  LAUNCH IN DEFAULT MODE — under --dangerously-skip-permissions,
                  or Shift-Tab'd into bypass/auto-accept, this state CANNOT fire.
  done            Stop                  let a turn finish
  needs-input     Notification:idle_prompt
                  leave it idle after a turn until the idle notification fires
  error           StopFailure           a turn that ends in failure; interrupting a
                  turn mid-tool-call is the usual inducer. If you cannot induce it,
                  record it as unreached in notes.md — that is a result, not a miss.
BY EYE, this cell only: confirm the status-line sprite is VISIBLE — the placeholder
cells sit under the pet's placement. This is the two-process rendezvous (hook
transmits the image, statusline prints the cells, no channel between them).
Exit normally (/exit) — SessionEnd is the ONLY trigger for the colour restore.
TXT
    ;;
  codex)
    cat <<'TXT'
Drive FOUR states, then exit normally:
  working        submit any prompt
  needs-approval a tool call that needs approval
  done           let a turn finish
  idle           the resting state
Expected, not a failure: SessionStart fires at the FIRST TURN, not at window open.
An opened-but-unspoken-to Codex window showing nothing is correct.
Codex draws its own sprite (from `install pets`); Familiar sends tint + bell only.
Exit normally.
TXT
    ;;
  opencode)
    cat <<'TXT'
Drive FIVE states (no needs-input), then exit normally:
  working        from session.busy
  needs-approval a tool call that needs approval
  done           the idle-after-active path
  error          provoke a failing tool call
  idle           the resting state
Expected, not failures:
  - No PreToolUse-shaped signal exists for OpenCode. Do not look for one.
  - The trace will be ENORMOUS (tens of thousands of lines, several MB): the sprite
    renderer writes one placement per rendered frame. Size is the frame rate, not a
    runaway write.
Exit normally.
TXT
    ;;
esac
printf '\nWhen the session has exited:  gate-tools/gate-verify-cell.sh\n'
printf 'Then relaunch the agent, drive it to any state, leave it running, and:\n'
printf '                              gate-tools/gate-reap.sh\n\n'
unset _gc_agent _gc_tty _gc_rdev
