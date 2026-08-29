#!/bin/bash
# §6's capability-`none` negative controls. Different from gate-verify-cell.sh:
#   - asserts capability `none` from OUTSIDE (the whole point of the control)
#   - does NOT apply a state-coverage checklist: §6 asks for ONE ringing state, not a full drive
# usage: gate-tools/gate-verify-control.sh <trace-basename> [--no-require-restore]
NAME="$1"; shift
if [ -z "$NAME" ]; then printf 'usage: gate-verify-control.sh <trace-basename> [--no-require-restore]\n' >&2; exit 2; fi
for v in FAMILIAR_GATE_DIR FAMILIAR_GATE_RDEV FAMILIAR_GATE_ROOT; do
  if [ -z "${!v}" ]; then printf 'STOP: %s is not set\n' "$v" >&2; exit 2; fi
done
T="$FAMILIAR_GATE_DIR/$NAME"
if [ ! -s "$T" ]; then printf 'STOP: missing or empty: %s\n' "$T" >&2; exit 2; fi

echo "=== $NAME: what the classifier actually recorded ==="
node -e '
const fs=require("node:fs");
const recs=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean)
  .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const caps=new Map(), states=new Set();
let apc=0,bel=0;
for(const r of recs){
  const e=r.expect||{};
  caps.set(e.capability,(caps.get(e.capability)||0)+1);
  if(e.state)states.add(e.state);
  apc+=(r.escapes||[]).filter(x=>x.k==="APC").length;
  bel+=(r.escapes||[]).filter(x=>x.k==="BEL").length;
}
console.log("  records:",recs.length);
for(const [k,v] of caps) console.log(`  capability ${JSON.stringify(k)}: ${v} record(s)`);
console.log("  states:",[...states].sort().join(", ")||"(none)");
const bySource=new Map();
for(const r of recs){const k=(r.expect||{}).source??"(none)";bySource.set(k,(bySource.get(k)||0)+1);}
for(const [k,v] of bySource) console.log(`  source ${JSON.stringify(k)}: ${v} record(s)`);
if(bySource.has("opencode-sprite")) console.log("  !! opencode-sprite records present — the sprite plugin REGISTERED at capability none;\n     \u00a76 expects it to return before registering, writing not one byte");
console.log(`  graphics chunks: ${apc}   bells: ${bel}`);
if(apc>0) console.log("  !! APC chunks present — graphics were NOT suppressed");
if(bel===0) console.log("  !! no bell — drive a ringing state (for opencode use ERROR, not an approval)");
' "$T"
echo
OUT=$(node "$FAMILIAR_GATE_ROOT/tools/gate-verify.mjs" "$T" \
        --expect-rdev "$FAMILIAR_GATE_RDEV" --expect-capability none "$@" 2>&1)
RC=$?
printf '%s\n' "$OUT"
echo
if [ "$RC" -eq 0 ]; then
  printf 'gate-verify exit 0 — CLEAN. Suppression proven. Record 0 in notes.md.\n'
elif printf '%s' "$OUT" | grep -q '^VIOLATION'; then
  printf 'gate-verify exit %s — %s violation(s). Record them.\n' "$RC" "$(printf '%s' "$OUT" | grep -c '^VIOLATION')" >&2
else
  printf 'gate-verify exit %s with NO VIOLATION lines — CRASH, not a pass (see Deviation 3).\n' "$RC" >&2
fi
exit "$RC"
