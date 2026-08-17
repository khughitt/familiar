import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';
import * as opencode from './opencode.js';

// An adapter answers four questions and declares one flag, and nothing else: which state an event
// means, how that state reduces against the one already on the bus, how to read the payload, which
// process is the agent -- and whether the agent's UI prints the cells an image would land in.
// Everything downstream of here -- the bus, the intent resolver, all three renderers -- has never
// heard of claude-code, and must not.
//
// This registry exists because transaction.js used to `import { stateForEvent } from
// '../adapters/claude-code.js'` directly, which made "the core" and "claude-code" the same
// thing by accident. They are not, and codex is the proof.
const ADAPTERS = { 'claude-code': claudeCode, codex, opencode };

// AN ADAPTER IS FOUR FUNCTIONS AND A FLAG, and this is the one door every consumer comes through
// -- so this is where the shape is checked, once, rather than trusted five times.
//
// THE FLAG IS WHY THIS FUNCTION EXISTS. bin/familiar does
// `transmitSprite = adapter.printsPlaceholderCells`, so an adapter that simply FORGOT the flag
// yields `undefined`, which is falsy, which means familiar silently stops printing the placeholder
// cells (and so transmitting the placeholder-cell sprite) for that agent -- forever, with no error,
// anywhere. (opencode carries its sprite a different way — a floated placement in its TUI plugin —
// so its flag is intentionally `false`; the flag governs the placeholder-cell path, not "any sprite
// anywhere".) A missing FUNCTION at least throws a TypeError the first time it is called. A missing
// BOOLEAN throws nothing and lies, and a lie with no error channel is the exact failure mode this
// project spends its time designing against.
const REQUIRED_FUNCTIONS = ['stateForEvent', 'reduceState', 'parsePayload', 'resolveAgentPid'];

export function assertAdapter(name, adapter) {
  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof adapter[fn] !== 'function') {
      throw new Error(
        `adapter "${name}" has no ${fn}() — every adapter must declare all of: ${REQUIRED_FUNCTIONS.join(', ')}`
      );
    }
  }
  if (typeof adapter.printsPlaceholderCells !== 'boolean') {
    throw new Error(
      `adapter "${name}" has no printsPlaceholderCells boolean — it decides whether familiar prints ` +
      `placeholder cells (and so transmits the placeholder-cell sprite), and an undefined here is ` +
      `silently falsy: the placeholder cat would simply never appear for this agent, with nothing ` +
      `anywhere to say why.`
    );
  }
  return adapter;
}

export function adapterFor(name) {
  if (!Object.prototype.hasOwnProperty.call(ADAPTERS, name)) {
    throw new Error(`unknown agent: ${name} — known agents are ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return assertAdapter(name, ADAPTERS[name]);
}

export const AGENTS = Object.keys(ADAPTERS);
