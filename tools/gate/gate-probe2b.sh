#!/bin/bash
# Probe 2b — what probe 2 was meant to prove, induced directly.
#
# Probe 2 runs `claude -p` under launchd. On claude 2.1.241 that fires no level-bearing
# hook, so `resolveAgentPid` is never called and no resolver failure exists to report.
# Results 2 and 3 pass vacuously.
#
# This runs `familiar hook SessionStart` ITSELF under launchd: no controlling terminal
# anywhere in the chain and no claude ancestor at all, so the resolver MUST fail. If the
# fail-closed contract holds, stderr carries the diagnostic, the job exits 0, and no
# trace is written.
LABEL=dev.familiar.gate-probe2b
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
U="$(id -u)"
[ -z "$FAMILIAR_GATE_DIR" ] && { echo "STOP: FAMILIAR_GATE_DIR unset" >&2; exit 2; }
[ -z "$FAMILIAR_GATE_ROOT" ] && { echo "STOP: FAMILIAR_GATE_ROOT unset" >&2; exit 2; }
TRACE="$FAMILIAR_GATE_DIR/probe2b.jsonl"
ERR="$FAMILIAR_GATE_DIR/probe2b-stderr.txt"
OUT="$FAMILIAR_GATE_DIR/probe2b-stdout.txt"
rm -f "$ERR" "$OUT"
[ -e "$TRACE" ] && { echo "STOP: $TRACE already exists" >&2; exit 2; }

PAYLOAD='{"session_id":"gate-probe2b","cwd":"'"$FAMILIAR_GATE_ROOT"'","hook_event_name":"SessionStart"}'
RUNNER="$FAMILIAR_GATE_DIR/probe2b-runner.sh"
cat > "$RUNNER" <<RUN
#!/bin/bash
printf '%s' '$PAYLOAD' | '$FAMILIAR_GATE_ROOT/bin/familiar' hook SessionStart
printf 'familiar-hook-exit=%s\n' "\$?"
RUN
chmod +x "$RUNNER"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$RUNNER</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$PATH</string>
    <key>FAMILIAR_GATE_TRACE</key><string>$TRACE</string>
  </dict>
  <key>StandardOutPath</key><string>$OUT</string>
  <key>StandardErrorPath</key><string>$ERR</string>
  <key>RunAtLoad</key><false/><key>KeepAlive</key><false/>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null || { echo "STOP: malformed plist" >&2; exit 2; }
launchctl bootout "gui/$U/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$U" "$PLIST" || { echo "STOP: bootstrap failed" >&2; exit 2; }
launchctl kickstart -w "gui/$U/$LABEL"
for i in $(seq 1 30); do
  s="$(launchctl print "gui/$U/$LABEL" 2>/dev/null)"
  [ -z "$s" ] && break
  printf '%s' "$s" | grep -qE '^[[:space:]]*pid = ' || break
  sleep 1
done
echo; echo "=========== probe 2b results ==========="
echo "--- stderr ---"; cat "$ERR" 2>/dev/null; echo "--- end ---"
if grep -q 'could not find the claude-code process' "$ERR" 2>/dev/null; then
  echo "PASS: resolver failure reached the cosmetic diagnostic under launchd"
else
  echo "FAIL: diagnostic absent" >&2
fi
echo "--- hook exit code (must be 0) ---"; cat "$OUT" 2>/dev/null
launchctl print "gui/$U/$LABEL" 2>/dev/null | grep -iE 'last exit' || true
echo "--- trace (must be absent or 0 lines) ---"
[ -e "$TRACE" ] && wc -l < "$TRACE" || echo "absent (PASS)"
echo; echo "cleanup: launchctl bootout gui/$U/$LABEL && rm -f '$PLIST' '$RUNNER'"
