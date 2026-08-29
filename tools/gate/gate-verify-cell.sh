#!/bin/bash
# Runs §5's verifier for the current cell, deriving the capability from the terminal.
# usage: gate-tools/gate-verify-cell.sh [extra gate-verify flags...]
for v in FAMILIAR_GATE_TRACE FAMILIAR_GATE_RDEV FAMILIAR_TERMINAL FAMILIAR_GATE_ROOT; do
  if [ -z "${!v}" ]; then printf 'STOP: %s is not set\n' "$v" >&2; exit 2; fi
done
case "$FAMILIAR_TERMINAL" in
  kitty)   CAP=kitty-animation ;;
  ghostty) CAP=static-graphics ;;
  *) printf 'STOP: unknown terminal %s\n' "$FAMILIAR_TERMINAL" >&2; exit 2 ;;
esac
if [ ! -s "$FAMILIAR_GATE_TRACE" ]; then
  printf 'STOP: trace is missing or empty: %s\n' "$FAMILIAR_GATE_TRACE" >&2
  printf '      an empty trace usually means Familiar was unconfigured (no scheme/theme).\n' >&2
  exit 2
fi
printf 'verifying %s  (rdev %s, capability %s)\n' \
  "$(basename "$FAMILIAR_GATE_TRACE")" "$FAMILIAR_GATE_RDEV" "$CAP"
# --- state coverage: gate-verify checks byte/intent agreement, NOT whether you
# --- actually drove the agent through the states it structurally exposes.
node -e '
const fs = require("node:fs");
const EXPECTED = {
  "claude-code": ["idle","working","needs-input","needs-approval","done","error"],
  "codex":       ["idle","working","needs-approval","done"],
  "opencode":    ["idle","working","needs-approval","done","error"],
};
const agent = process.argv[2];
const recs = fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const seen = new Set(recs.map((r) => r.expect && r.expect.state).filter(Boolean));
const want = EXPECTED[agent] || [];
const KNOWN_UNREACHABLE = { "opencode": ["needs-approval"] };   // Deviation 10
const known = KNOWN_UNREACHABLE[agent] || [];
const missing = want.filter((s) => !seen.has(s) && !known.includes(s));
const missingKnown = want.filter((s) => !seen.has(s) && known.includes(s));
const bells = recs.reduce((n,r) => n + (r.escapes||[]).filter((e)=>e.k==="BEL").length, 0);
console.log("state coverage for " + agent + ":");
for (const s of want) {
  const mark = seen.has(s) ? "[x]" : (known.includes(s) ? "[-]" : "[ ]");
  const tag = (!seen.has(s) && known.includes(s)) ? "  (known unreachable - Deviation 10)" : "";
  console.log(`  ${mark} ${s}${tag}`);
}
console.log(`  bells rung: ${bells}`);
if (missing.length) {
  console.log(`\nINCOMPLETE — never reached: ${missing.join(", ")}`);
  console.log("This cell is NOT done. gate-verify can still exit 0: it checks that the");
  console.log("bytes match what the emitter intended, not that you drove every state.");
  console.log("Move the trace aside as .attemptN and re-drive, or record the state as");
  console.log("genuinely un-inducible in notes.md with the reason.");
} else if (missingKnown.length) {
  console.log(`\ncomplete as far as the adapter permits; ${missingKnown.join(", ")} is a`);
  console.log("RECORDED FAILURE (Deviation 10), not an undriven state. Do not re-drive.");
} else {
  console.log("\nall structurally exposed states reached");
}
' "$FAMILIAR_GATE_TRACE" "$FAMILIAR_GATE_AGENT"
echo

OUT=$(node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$FAMILIAR_GATE_TRACE" \
        --expect-rdev "$FAMILIAR_GATE_RDEV" --expect-capability "$CAP" "$@" 2>&1)
RC=$?
printf '%s\n' "$OUT"
echo
if [ "$RC" -eq 0 ]; then
  printf 'gate-verify exit 0 — CLEAN. Record 0 in notes.md.\n'
elif printf '%s' "$OUT" | grep -q '^VIOLATION'; then
  printf 'gate-verify exit %s — %s violation(s). Record them in notes.md; do NOT retry and overwrite.\n' \
    "$RC" "$(printf '%s' "$OUT" | grep -c '^VIOLATION')" >&2
else
  printf 'gate-verify exit %s with NO VIOLATION lines — this is a CRASH, not a pass.\n' "$RC" >&2
  printf 'See DEVIATION 3 in GATE-DELTA.md (missing escapes[] array).\n' >&2
fi
exit "$RC"
