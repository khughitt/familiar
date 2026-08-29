#!/bin/bash
# Orientation for a paused run: where you are, what is captured, what is next.
D="${FAMILIAR_GATE_DIR:-}"
printf '=== bus ===\n'
B="$HOME/.local/state/familiar/agents.json"
if [ -e "$B" ]; then
  node -e 'const b=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
  const ids=Object.keys(b);console.log(`${ids.length} session(s) live`);
  for(const i of ids)console.log(`  pid=${b[i].pid} state=${b[i].state} project=${b[i].project} cwd=${b[i].cwd}`);
  if(ids.length!==1)console.log("  NOTE: reap checks need EXACTLY ONE. Redirect other agents with FAMILIAR_STATE_DIR.");' "$B"
else printf 'no bus yet\n'; fi
printf '\n=== env ===\n'
for v in FAMILIAR_TERMINAL FAMILIAR_GATE_DIR FAMILIAR_GATE_ROOT FAMILIAR_GATE_RDEV \
         FAMILIAR_GATE_CAPABILITY FAMILIAR_GATE_AGENT FAMILIAR_GATE_TRACE FAMILIAR_GATE_BACKUP_DIR; do
  printf '  %-28s %s\n' "$v" "${!v:-<unset>}"
done
printf '\n=== artifacts ===\n'
if [ -z "$D" ] || [ ! -d "$D" ]; then printf '  FAMILIAR_GATE_DIR unset or missing\n'; exit 0; fi
for n in kitty-claude-code.jsonl kitty-codex.jsonl kitty-opencode.jsonl \
         ghostty-claude-code.jsonl ghostty-codex.jsonl ghostty-opencode.jsonl \
         spot-check.jsonl codex-events.jsonl \
         capability-none-claude-code.jsonl capability-none-opencode.jsonl \
         probe2-stderr.txt bg-comm.txt bg-command.txt \
         versions-kitty.txt versions-ghostty.txt; do
  if [ -s "$D/$n" ]; then printf '  [x] %-36s %8s bytes\n' "$n" "$(wc -c < "$D/$n" | tr -d ' ')"
  else printf '  [ ] %s\n' "$n"; fi
done
printf '\n=== recorded device (must be nonzero; 0 means the substitution pipe was measured) ===\n'
for t in kitty ghostty; do
  f="$D/versions-$t.txt"
  if [ -s "$f" ]; then
    r=$(sed -n 's/^terminal-rdev=//p' "$f")
    if [ "$r" = "0" ] || [ -z "$r" ]; then
      printf '  [!] versions-%s.txt terminal-rdev=%s  <-- BOGUS. source gate-tools/gate-rdev.sh in that window\n' "$t" "${r:-<missing>}"
    else
      printf '  [x] versions-%s.txt terminal-rdev=%s\n' "$t" "$r"
    fi
  fi
done

printf '\n  reap sets (7 files each):\n'
for c in kitty-claude-code kitty-codex kitty-opencode ghostty-claude-code ghostty-codex ghostty-opencode; do
  k=0
  for f in reap-session-$c.json reap-pid-$c.txt reap-identity-$c.txt reap-target-$c.txt \
           before-reap-$c.json reap-$c.txt after-reap-$c.json; do
    [ -e "$D/$f" ] && k=$((k+1))
  done
  if [ "$k" -eq 7 ]; then printf '  [x] %-24s 7/7\n' "$c"; else printf '  [ ] %-24s %s/7\n' "$c" "$k"; fi
done
