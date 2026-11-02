// Picks the one stage token the status line shows for a task. Pure: the detached refresher
// runs `tasks` and flow's `flow-state` and hands their results here. Imports stay node
// builtins and relative files only, because the refresher runs with no dependency preflight.
import { ABSENT } from './hud.js';

export const GATES = ['captured', 'scoped', 'designed', 'planned', 'implementing', 'verified', 'closed'];

const ok = (stage) => ({ stage, fault: null });
const gateFault = (fault) => ({ stage: 'gate?', fault });

// Rules 2-10 of the spec's precedence table, in order. Rule 1 ("not refreshed") is the
// render side's.
export function stageToken({ tasks, park, flow }) {
  if (tasks.fault !== undefined) return { stage: ABSENT, fault: tasks.fault };       // 2
  if (park) {                                                                        // 3-5
    if (park.reason) return ok(`parked: ${park.reason}`);
    if (park.waiting_on === 'user') return ok('parked: you');
    return ok('parked');
  }
  if (flow.missing) return ok(tasks.status);                                         // 6
  if (flow.timedOut) return gateFault('flow-state: timed out');
  if (flow.code !== 0 && flow.code !== 3) return gateFault(`flow-state: exited ${flow.code}`);
  let state;
  try {
    state = JSON.parse(flow.stdout)?.state;
  } catch {
    return gateFault('flow-state: unparseable output');
  }
  if (flow.code === 3) {                                                             // 8
    if (state === null || state === undefined) return gateFault('flow-state: exit 3 without a gate state');
    if (GATES.includes(state)) return ok(`${state}?`);
    return gateFault(`flow-state: unknown state ${state}`);
  }
  if (GATES.includes(state)) return ok(state);                                       // 7
  if (state === 'outside') return ok(tasks.status);                                  // 9
  return gateFault(`flow-state: unknown state ${state}`);
}
