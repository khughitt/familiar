#!/bin/bash
# §7 probe 2 — the fail-closed contract. A launchd LaunchAgent runs one headless
# `claude -p` with stdio fully detached and NO controlling terminal anywhere in its
# process chain. Familiar's resolver must fail, and that failure must reach `familiar
# hook`'s cosmetic diagnostic on stderr rather than being swallowed.
#
# The runbook flags this probe as never having been run on hardware, and flags
# `launchctl kickstart -w`'s blocking behaviour as unverified. This wraps both with
# explicit checks and a poll fallback.
#
# usage: gate-tools/gate-probe2.sh     (run in the gate window, Node 22 active)

LABEL=dev.familiar.gate-probe
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N="$(id -u)"

for v in FAMILIAR_GATE_DIR; do
  if [ -z "${!v}" ]; then echo "STOP: $v is not set" >&2; exit 2; fi
done

TRACE="$FAMILIAR_GATE_DIR/probe2.jsonl"
OUT="$FAMILIAR_GATE_DIR/probe2-stdout.txt"
ERR="$FAMILIAR_GATE_DIR/probe2-stderr.txt"

if [ -e "$TRACE" ]; then
  echo "STOP: probe 2 already has a trace: $TRACE" >&2
  echo "      move it aside; do not delete or overwrite it." >&2
  exit 2
fi
echo "ok: fresh probe 2 trace path"

CLAUDE_BIN="$(command -v claude)"
if [ ! -x "$CLAUDE_BIN" ]; then echo "STOP: claude is not on PATH as an executable" >&2; exit 2; fi
echo "ok: claude at $CLAUDE_BIN"

# The job inherits NO shell environment, so PATH must carry node itself -- bin/familiar
# is #!/usr/bin/env node and every hook dies without it. Verify before writing the plist.
NODE_BIN="$(command -v node)"
if [ ! -x "$NODE_BIN" ]; then echo "STOP: node is not on PATH; the hook cannot run" >&2; exit 2; fi
echo "ok: node at $NODE_BIN ($(node --version))"
case "$(node --version)" in v22.*) ;; *) echo "WARNING: node is not v22.x" >&2 ;; esac

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLAUDE_BIN</string>
    <string>-p</string>
    <string>Reply with the single word: probe.</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$PATH</string>
    <key>FAMILIAR_GATE_TRACE</key>
    <string>$TRACE</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$OUT</string>
  <key>StandardErrorPath</key>
  <string>$ERR</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" || { echo "STOP: plist is malformed" >&2; exit 2; }

launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null   # clear a stale registration
launchctl bootstrap "gui/$UID_N" "$PLIST" || { echo "STOP: bootstrap failed" >&2; exit 2; }
echo "ok: bootstrapped $LABEL"

echo "kickstarting (this may block, or may return immediately)..."
launchctl kickstart -w "gui/$UID_N/$LABEL"
echo "kickstart returned $?"

# Poll fallback: -w is documented to block until the first run exits, but that is
# unverified on this macOS. Wait until the job reports no PID.
for i in $(seq 1 60); do
  state="$(launchctl print "gui/$UID_N/$LABEL" 2>/dev/null)"
  if [ -z "$state" ]; then echo "job is gone from launchd after ${i}s"; break; fi
  if ! printf '%s' "$state" | grep -qE '^[[:space:]]*pid = '; then
    echo "job is no longer running (after ${i}s)"; break
  fi
  sleep 1
done

echo
echo "================ REQUIRED RESULT 1: the diagnostic ================"
if [ -s "$ERR" ]; then
  cat "$ERR"
  echo "---"
  n=$(grep -c 'could not find the claude-code process' "$ERR")
  if [ "$n" -gt 0 ]; then echo "PASS: diagnostic present ($n occurrence(s))"
  else echo "FAIL: expected diagnostic 'could not find the claude-code process' NOT present" >&2; fi
else
  echo "FAIL: $ERR is missing or empty" >&2
fi

echo
echo "================ REQUIRED RESULT 2: last exit status ================"
launchctl print "gui/$UID_N/$LABEL" 2>/dev/null | grep -iE 'last exit (status|code)' \
  || echo "(job no longer registered; exit status unavailable from launchctl print)"

echo
echo "================ REQUIRED RESULT 3: zero trace lines ================"
if [ -e "$TRACE" ]; then
  lines=$(wc -l < "$TRACE" | tr -d ' ')
  echo "probe2.jsonl exists with $lines line(s) ($(wc -c <"$TRACE"|tr -d ' ') bytes)"
  [ "$lines" -eq 0 ] && echo "PASS: zero lines" || echo "FAIL: expected zero lines" >&2
else
  echo "probe2.jsonl absent"
  echo "PASS: no trace file at all is an acceptable zero (the resolver throws before any write)"
fi

echo
echo "NOTE: probe2-stdout.txt holds the agent's own reply and must NOT be returned (§9)."
echo "NOTE: the LaunchAgent stays registered; §11 unloads and removes it."
