# SOURCE this in a SECOND tab so you can run gate-reap.sh while the agent is running:
#     source gate-tools/gate-env.sh <claude-code|codex|opencode> [kitty|ghostty]
#
# Sets only the variables gate-reap.sh needs. It deliberately does NOT set
# FAMILIAR_GATE_RDEV or FAMILIAR_GATE_TRACE: those belong to the window that captured
# them, and reap asserts neither. Never source this in the cell's own window.

_ge_agent="$1"; _ge_term="${2:-kitty}"
case "$_ge_agent" in
  claude-code|codex|opencode) ;;
  *) printf 'usage: source gate-tools/gate-env.sh <claude-code|codex|opencode> [kitty|ghostty]\n' >&2
     return 2 2>/dev/null || exit 2 ;;
esac

if [ -n "$FAMILIAR_STATE_DIR" ]; then
  printf 'STOP: FAMILIAR_STATE_DIR is set (%s).\n' "$FAMILIAR_STATE_DIR" >&2
  printf '      This tab would read the SIDECAR bus and reap would find no session.\n' >&2
  printf '      Open a tab without it, or: unset FAMILIAR_STATE_DIR\n' >&2
  return 2 2>/dev/null || exit 2
fi

if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; fi
case "$(node --version 2>/dev/null)" in
  v22.*) printf 'ok: node %s\n' "$(node --version)" ;;
  *) printf 'WARNING: node is %s, the matrix expects v22.x\n' "$(node --version 2>&1)" >&2 ;;
esac

export FAMILIAR_GATE_ROOT="$HOME/familiar-macos-terminal-gate"
export FAMILIAR_GATE_BIN="$FAMILIAR_GATE_ROOT/bin/familiar"
export FAMILIAR_NODE_TMP="$(node -e 'process.stdout.write(require("node:os").tmpdir())')"
export FAMILIAR_GATE_DIR="$FAMILIAR_NODE_TMP/familiar-macos-terminal-gate"
export FAMILIAR_TERMINAL="$_ge_term"
export FAMILIAR_GATE_AGENT="$_ge_agent"

printf 'ready for reap: cell %s-%s\n' "$FAMILIAR_TERMINAL" "$FAMILIAR_GATE_AGENT"
printf '  bus: %s session(s) live\n' \
  "$(node -e 'try{console.log(Object.keys(JSON.parse(require("node:fs").readFileSync(process.env.HOME+"/.local/state/familiar/agents.json","utf8"))).length)}catch{console.log(0)}')"
printf '  run: gate-tools/gate-reap.sh\n'
unset _ge_agent _ge_term
