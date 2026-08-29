#!/bin/bash
# Live bus watcher. Run in a second tab while driving a cell: prints every state
# transition the moment it reaches agents.json, including transitions that produce
# NO terminal write (a no-op prev===next never appears in the trace).
#
# usage: gate-tools/gate-watch.sh    (Ctrl-C to stop)
BUS="${FAMILIAR_STATE_DIR:-$HOME/.local/state/familiar}/agents.json"
printf 'watching %s  (Ctrl-C to stop)\n\n' "$BUS"
exec node -e '
const fs=require("node:fs");
const bus=process.argv[1];
let prev="";
const stamp=()=>new Date().toISOString().slice(11,23);
setInterval(()=>{
  let cur="";
  try{
    const b=JSON.parse(fs.readFileSync(bus,"utf8"));
    cur=Object.entries(b).map(([id,r])=>`${r.pid}:${r.state}`).sort().join(" | ");
  }catch{ cur="(unreadable)"; }
  if(cur!==prev){
    process.stdout.write(`${stamp()}  ${cur||"(empty)"}\n`);
    prev=cur;
  }
},200);
' "$BUS"
