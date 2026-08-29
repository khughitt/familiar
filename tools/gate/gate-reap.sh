#!/bin/bash
# Mechanises §5's abnormal-termination block (runbook lines ~640-820) into one command.
# Every check the runbook makes is preserved verbatim, including the strict
# "exactly one live session on the bus" guard. This saves keystrokes, not rigour.
#
# usage:  gate-tools/gate-reap.sh
# needs:  FAMILIAR_TERMINAL FAMILIAR_GATE_AGENT FAMILIAR_GATE_DIR FAMILIAR_GATE_BIN FAMILIAR_GATE_ROOT
# expects: the cell's agent is running and has reached the bus.

for v in FAMILIAR_TERMINAL FAMILIAR_GATE_AGENT FAMILIAR_GATE_DIR FAMILIAR_GATE_BIN FAMILIAR_GATE_ROOT; do
  if [ -z "${!v}" ]; then printf 'STOP: %s is not set\n' "$v" >&2; exit 2; fi
done

CELL="$FAMILIAR_TERMINAL-$FAMILIAR_GATE_AGENT"
BUS="${FAMILIAR_STATE_DIR:-$HOME/.local/state/familiar}/agents.json"
SESSION_FILE="$FAMILIAR_GATE_DIR/reap-session-$CELL.json"
PID_FILE="$FAMILIAR_GATE_DIR/reap-pid-$CELL.txt"

printf '=== reap sequence for cell %s ===\n' "$CELL"

if [ ! -e "$BUS" ]; then printf 'STOP: no bus at %s — has the agent reached it?\n' "$BUS" >&2; exit 2; fi
for f in "$SESSION_FILE" "$PID_FILE" "$FAMILIAR_GATE_DIR/before-reap-$CELL.json" \
         "$FAMILIAR_GATE_DIR/reap-$CELL.txt" "$FAMILIAR_GATE_DIR/after-reap-$CELL.json"; do
  if [ -e "$f" ]; then
    printf 'STOP: this cell already has reap evidence: %s\n' "$f" >&2
    printf '      move it aside under a new name; do not delete or overwrite it.\n' >&2
    exit 2
  fi
done

# --- step 0: name the session and verify process identity BEFORE anything is killed ---
cd "$FAMILIAR_GATE_ROOT" || exit 2
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { startTimeOf } from "./src/bus/proc.js";
const [busPath, sessionOut, pidOut] = process.argv.slice(1);
const bus = JSON.parse(readFileSync(busPath, "utf8"));
const ids = Object.keys(bus);
if (ids.length !== 1) {
  const hint = ids.length === 0
    ? "\n  FOUND ZERO. The agent has not reached the bus yet. Codex in particular does\n" +
      "  not register at window open -- its SessionStart fires at the FIRST TURN. Submit\n" +
      "  a prompt, confirm with gate-tools/gate-status.sh, then re-run this."
    : "\n  Every other Familiar-visible agent must be closed, OR launched with\n" +
      "  FAMILIAR_STATE_DIR pointed at a scratch directory.\n" +
      "  On the bus: " + ids.map((i) => `pid ${bus[i].pid} (${bus[i].project})`).join(", ");
  throw new Error(`expected exactly one live session, found ${ids.length}.` + hint);
}
const record = bus[ids[0]];
if (!Number.isInteger(record.pid) || record.pid <= 1) {
  throw new Error(`refusing to name pid ${JSON.stringify(record.pid)} as a kill target`);
}
const fresh = startTimeOf(record.pid);
if (fresh !== record.starttime) {
  throw new Error(
    `pid ${record.pid} start time is ${fresh}, the bus recorded ${record.starttime}: ` +
    "this pid has been recycled and is NOT the agent. Do not kill it."
  );
}
writeFileSync(sessionOut, JSON.stringify(ids[0]));
writeFileSync(pidOut, `${record.pid}\n`);
process.stdout.write(`session verified, pid ${record.pid} starttime ${fresh}\n`);
' "$BUS" "$SESSION_FILE" "$PID_FILE" \
  >"$FAMILIAR_GATE_DIR/reap-identity-$CELL.txt" 2>"$FAMILIAR_GATE_DIR/.ident-err-$CELL"
IDENT_RC=$?
cat "$FAMILIAR_GATE_DIR/reap-identity-$CELL.txt"

if [ "$IDENT_RC" -ne 0 ] || [ ! -s "$PID_FILE" ]; then
  printf '\nSTOP: identity check failed — NOTHING WAS KILLED.\n\n' >&2
  awk '/^Error:/{f=1} /^[ \t]+at /{f=0} f' "$FAMILIAR_GATE_DIR/.ident-err-$CELL" >&2
  printf '\n' >&2
  rm -f "$FAMILIAR_GATE_DIR/reap-identity-$CELL.txt" "$SESSION_FILE" "$PID_FILE" \
        "$FAMILIAR_GATE_DIR/.ident-err-$CELL"
  exit 1
fi
rm -f "$FAMILIAR_GATE_DIR/.ident-err-$CELL"

AGENT_PID="$(cat "$PID_FILE")"
case "$AGENT_PID" in ''|*[!0-9]*) printf 'STOP: not a pid: %s\n' "$AGENT_PID" >&2; exit 1 ;; esac

# --- step 0b: corroboration for whoever reads the evidence ---
ps -p "$AGENT_PID" -o pid=,comm= | tee "$FAMILIAR_GATE_DIR/reap-target-$CELL.txt"
BASENAME="$(ps -p "$AGENT_PID" -o comm= | xargs basename 2>/dev/null)"
printf 'about to SIGKILL pid %s (%s)\n' "$AGENT_PID" "$BASENAME"

kill -9 "$AGENT_PID" || { printf 'STOP: kill failed\n' >&2; exit 1; }

# 1. that session must still be on the bus
cp "$BUS" "$FAMILIAR_GATE_DIR/before-reap-$CELL.json"
# 2. reap must name that session (eviction lines go to stderr, so stdout is just `reaped <id>`)
"$FAMILIAR_GATE_BIN" reap | tee "$FAMILIAR_GATE_DIR/reap-$CELL.txt"
# 3. and that session must be the one now absent
cp "$BUS" "$FAMILIAR_GATE_DIR/after-reap-$CELL.json"

node -e '
const fs = require("node:fs");
const [beforePath, reapPath, afterPath, sessionPath] = process.argv.slice(1);
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
const reaped = fs.readFileSync(reapPath, "utf8");
if (!(session in before)) throw new Error("the session was already gone before reap ran");
if (reaped !== `reaped ${session}\n`) throw new Error("reap stdout was not exactly the killed session");
if (session in after) throw new Error("the session survived reap");
process.stdout.write("present before, named by reap, absent after\n");
' "$FAMILIAR_GATE_DIR/before-reap-$CELL.json" "$FAMILIAR_GATE_DIR/reap-$CELL.txt" \
  "$FAMILIAR_GATE_DIR/after-reap-$CELL.json" "$SESSION_FILE"
RC=$?

echo
if [ "$RC" -eq 0 ]; then
  printf 'CELL %s REAP: PASS  (7 artifacts written)\n' "$CELL"
else
  printf 'CELL %s REAP: FAIL  — record it in notes.md and move on; a recorded failure is a result.\n' "$CELL" >&2
fi
printf 'Remember: the terminal stays tinted after a force-kill. That is correct.\n'
exit "$RC"
