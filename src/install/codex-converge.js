import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  planCodexProjectForPath, applyCodexProjectSync, configText, EXCLUDE, lstatIfPresent,
} from './codex.js';
import { petUsable } from './pet-stamp.js';

// SessionStart ONLY, AND CODEX ONLY. claude-code and opencode need none of this:
// Familiar draws their surfaces itself, from the bus, live. This exists solely
// because Codex draws its own pet from a file, so the file has to be kept true.
// PreToolUse fires on every tool call and would repeat the work for nothing.
export function shouldConverge({ agent, event }) {
  return agent === 'codex' && event === 'SessionStart';
}

// ONE REPOSITORY, ONE LAUNCH LATE BY CONSTRUCTION.
// docs/specs/2026-09-05-codex-identity-parity-design.md §6.1 measured it: Codex
// reads `[tui] pet` at TUI start and no hook runs before the first turn, so what
// this writes is read by the NEXT launch. That is the ceiling, not a bug to fix
// here -- which is why nothing below tries to signal Codex.
//
// `repoRoot` AND `member` ARE ARGUMENTS, NOT DISCOVERIES. The transaction has
// already run gitContext and resolved the identity for this very session. Asking
// the planner first would spawn five `git` subprocesses and repeat the pin sweep
// on EVERY SessionStart just to learn that nothing needs doing. And a planner
// that resolved its own member could name a different one than the gate checked,
// verifying one pet's art and selecting another.
//
// EVERY ORDINARY REFUSAL IS A RETURN, NOT A THROW. This runs inside a cosmetic
// hook; an unmanaged config, a tracked one, a missing pet and a non-repository
// are all normal states of a user's machine, and none may take down the session.
export async function convergeCodexProject({
  repoRoot, member, catalog, pack, themeId, petsDir,
}) {
  // No repository is not a failure -- it is most of the filesystem.
  if (!repoRoot) return { changed: false, member, outcome: 'quiet' };

  const target = join(repoRoot, EXCLUDE);

  // THE GATE RUNS FIRST, AND UNCONDITIONALLY. A config that already names this
  // member is NOT evidence the member is installed: swap to a theme that reuses
  // the id and the text matches while the art belongs to the old theme. Gating
  // only on mismatch would skip the diagnostic in the one case that most needs
  // it. Cost is three existsSync probes and one small read -- no subprocess.
  const usable = petUsable({ petsDir, themeId, memberId: member });
  if (!usable.ok) {
    return {
      changed: false, member, outcome: 'actionable',
      reason: `${usable.reason} — run \`familiar install pets\``,
    };
  }

  // TYPE-CHECK BEFORE OPENING. readFileSync on a FIFO blocks forever and this
  // code has no timeout of its own, so the path is lstat'd before it is read.
  // None of this spawns a process.
  const configDir = join(repoRoot, '.codex');
  const dirStat = lstatIfPresent(configDir);
  if (dirStat?.isSymbolicLink()) {
    return {
      changed: false, member, outcome: 'error',
      reason: `refusing symlinked Codex config directory ${configDir}`,
    };
  }

  // The zero-byte `.codex` FILE is a marker the full planner migrates into a
  // directory (assertConfigTarget's allowEmptyMarker). Reading through it would
  // yield ENOTDIR and turn a supported migration into a reported error, so hand
  // it straight to the write path -- which knows how, and has the git it needs
  // to decide whether that marker is tracked.
  const emptyMarker = Boolean(dirStat?.isFile() && dirStat.size === 0);
  if (dirStat && !dirStat.isDirectory() && !emptyMarker) {
    return {
      changed: false, member, outcome: 'error',
      reason: `Codex config path is not a directory: ${configDir}`,
    };
  }

  if (!emptyMarker) {
    const fileStat = lstatIfPresent(target);
    if (fileStat?.isSymbolicLink()) {
      return {
        changed: false, member, outcome: 'error',
        reason: `refusing symlinked project config ${target}`,
      };
    }
    if (fileStat && !fileStat.isFile()) {
      return {
        changed: false, member, outcome: 'error',
        reason: `Codex project config is not a regular file: ${target}`,
      };
    }
    let current = null;
    if (fileStat) {
      try {
        current = readFileSync(target, 'utf8');
      } catch (error) {
        return { changed: false, member, outcome: 'error', reason: `${target}: ${error.message}` };
      }
    }
    if (current === configText(member)) return { changed: false, member, outcome: 'unchanged' };
  }

  let planned;
  try {
    planned = await planCodexProjectForPath({
      path: repoRoot, pinned: false, catalog, pack, member,
    });
  } catch (error) {
    // Only the genuinely exceptional reaches here: a non-regular config, a
    // wedged git. Both are worth saying out loud.
    return { changed: false, member, outcome: 'error', reason: error.message };
  }

  if (planned.conflict) {
    return {
      changed: false, member, outcome: 'actionable',
      reason: `refusing unmanaged project config ${planned.conflict}`,
    };
  }
  if (planned.manual) {
    return {
      changed: false, member, outcome: 'actionable',
      reason: `project config is tracked by Git; set it yourself: ${planned.manual.path}`,
    };
  }
  if (planned.skip) return { changed: false, member, outcome: 'quiet', reason: planned.skip.reason };
  if (planned.missing) return { changed: false, member, outcome: 'quiet' };

  try {
    applyCodexProjectSync({
      configs: [planned.config],
      excludes: planned.exclude ? [planned.exclude] : [],
    });
  } catch (error) {
    return { changed: false, member, outcome: 'error', reason: error.message };
  }
  return { changed: true, member: planned.member, outcome: 'converged' };
}
