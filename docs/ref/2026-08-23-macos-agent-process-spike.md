# macOS agent-process spike — evidence

**Status:** capture complete 2026-08-23. Closes the live-hook ancestry and
hook-executor gate in §2 of the macOS core support design. Live graphics, tint,
and bell remain provisional under §11.

**Provenance**

- Capture branch: `spike/macos-agent-handoff` at `2f592ee`, disposable and never
  merged. Runbook: `docs/ref/2026-08-23-macos-agent-process-handoff.md`.
- Host: MacBook Air (Mac16,12), Apple M4, arm64. macOS 26.6.2 (build 25G83).
- Kitty 0.46.2. Node v25.8.2 under nvm.
- Claude Code 2.1.241, codex-cli 0.149.0, opencode 1.18.21.
- 30 records captured 2026-08-23T19:21Z–19:52Z: 1 Claude Code, 3 Codex,
  26 OpenCode across four OpenCode sessions.
- Raw and redacted artifacts stayed private and are not committed. Everything
  below is the reviewed, redacted summary.

## 1. Verdict

**The gate opens, confirming the implemented rule rather than correcting it.**
Skipping the hook process and taking the first ancestor whose normalized `comm`
basename equals the expected agent name and whose `tty` is non-null resolves the
correct terminal-owning process for all three agents. No resolver needed more
than exact basename plus non-null TTY, so the design's "amend and reapprove"
branch is not triggered and the approved predicate stands unchanged.

What this unblocks: the three adapters still refuse outright on Darwin
(`src/adapters/claude-code.js`, `codex.js`, `opencode.js` each throw
"resolver evidence is not recorded"). This note is the evidence those throws
were waiting for, so removing them is now authorized — with each adapter's
Darwin claim citing this file.

## 2. Resolved ancestry

Depth 0 is the Familiar hook process. The resolved agent is marked `<--`.

Claude Code, `PreToolUse`:

```text
d0  pid 37708  ppid 37707  tty ??       node        (hook)
d1  pid 37707  ppid 37609  tty ??       sh
d2  pid 37609  ppid 35113  tty ttys000  claude      <-- resolved
d3  pid 35113  ppid 35112  tty ttys000  -zsh
d4  pid 35112  ppid 12450  tty ttys000  login
d5  pid 12450  ppid     1  tty ??       kitty
d6  pid     1  ppid     0  tty ??       launchd
```

Codex, `PreToolUse`:

```text
d0  pid 38843  ppid 38829  tty ttys000  node        (hook)
d1  pid 38829  ppid 38609  tty ttys000  zsh
d2  pid 38609  ppid 38608  tty ttys000  codex       <-- resolved
d3  pid 38608  ppid 35113  tty ttys000  node        (npm launcher for codex)
d4  pid 35113  ppid 35112  tty ttys000  -zsh
d5  pid 35112  ppid 12450  tty ttys000  login
d6  pid 12450  ppid     1  tty ??       kitty
d7  pid     1  ppid     0  tty ??       launchd
```

OpenCode, `init` from the successful session:

```text
d0  pid 42885  ppid 42878  tty ttys000  node        (hook)
d1  pid 42878  ppid 35113  tty ttys000  opencode    <-- resolved
d2  pid 35113  ppid 35112  tty ttys000  -zsh
d3  pid 35112  ppid 12450  tty ttys000  login
d4  pid 12450  ppid     1  tty ??       kitty
d5  pid     1  ppid     0  tty ??       launchd
```

Two details carry weight beyond the table.

**Basename normalization is load-bearing.** Codex's `comm` is the full vendored
executable path
(`.../@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`), not a
bare name. This is the Darwin/Linux `comm` divergence the design anticipated:
BSD `comm` is an executable path, Linux `comm` is the kernel-set process name.
`basename()` recovers `codex`. Claude Code and OpenCode reported bare names.

**The Codex launcher does not collide.** Directly above the resolved `codex`
binary sits `node .../bin/codex`, the npm shim, whose basename is `node`. It
holds the same TTY but cannot match the expected name, so the first-match walk
is unambiguous without any additional rule.

## 3. Hook-command execution boundary

Three agents, three distinct behaviours, all measured:

| Agent | Executor | Observed frame |
| --- | --- | --- |
| Claude Code | `/bin/sh -c`, one string | `/bin/sh -c '<bin>' hook PreToolUse ; :` |
| Codex | `/bin/zsh -c`, one string | `/bin/zsh -c <bin> hook PreToolUse --agent codex; :` |
| OpenCode | none; direct spawn | Familiar is a direct child of `opencode` |

The Codex entry was written with a deliberately **unquoted** path and a trailing
`; :` canary. A whitespace-splitting executor could not have produced the frame
observed, so Codex is a shell executor. That settles the open question behind the
setup-command encoding: shell quoting is required, and `shellQuote`'s
single-quote form is correct under both `sh` and `zsh`.

Two consequences worth stating plainly:

- **Codex's shell is `zsh`, not `sh`.** Any reasoning that assumes POSIX `sh`
  for Codex hook commands is contradicted by this capture.
- **OpenCode applies no shell at all.** Familiar registers a JS plugin there
  rather than a command string, so nothing today depends on it — but a future
  `setup opencode` emitting a shell-quoted command string would be broken by
  this path, not merely redundant.

## 4. Terminal and environment

**The hook has no controlling terminal under Claude Code** (`tty ??` at depths 0
and 1). This independently confirms, on Darwin, the decision that the TTY target
must come from the resolved agent's record and never from the hook process — the
same conclusion the Linux spike reached when `/dev/tty` failed in 1507 of 1507
samples. Codex and OpenCode hooks did inherit `ttys000`; relying on that would
have worked for two agents out of three, which is the trap.

**Graphics markers survive into the hook environment.** Identical across all 30
records:

```text
TERM                  present
KITTY_WINDOW_ID       present
KITTY_PID             present
TERM_PROGRAM          absent
GHOSTTY_RESOURCES_DIR absent
```

`graphicsCapability` returns `kitty-animation` on `KITTY_WINDOW_ID` alone
(`src/render/term/capability.js`), so the design's decision to read the graphics
environment from the hook's inherited environment on Darwin holds for Kitty.

## 5. What this evidence does not cover

- **No background or daemon-hosted Claude Code session.** The `tty !== null` half
  of the predicate exists because 370 of 1507 Linux samples put a `claude
  bg-pty-host` or `claude daemon run` between hook and agent, sharing the comm
  and owning no terminal. Only an interactive session was captured here, so that
  half remains carried over from Linux rather than measured on Darwin.
- **No configuration matching the support claim.** CI covers macOS 14 + Node 22
  with no live agents; this capture covers macOS 26.6.2 + Node 25.8.2 with live
  agents. macOS 14 + Node 22 + a real agent has not been exercised.
- **The machine-wide snapshot parser was not exercised.** The probe reads
  per-PID (`ps -p`). The shipping path parses `ps -axo` over every process on the
  machine and maps `parseDarwinRow` across all of it, so a single unparseable row
  anywhere throws and disables every hook (`src/bus/proc.js`). An eight-row
  ancestor walk is not that input.
- **Kitty only, no tmux, no Ghostty**, per the runbook's deliberate scope.

## 6. Deviations from the runbook

Recorded so this is not read as a clean-room run.

1. **The suite was not green.** `npm test` fails 1 of 840 deterministically on
   this machine: `a status line invocation makes exactly one cheap git call`. The
   test's fake-`git` shim costs ~252 ms on its cold first exec against a 250 ms
   `BRANCH_TIMEOUT_MS`, so `symbolic-ref` is killed and the `rev-parse` fallback
   fires, logging two calls. Harness timing, not the probe path — but the stop
   condition in step 1 fired and was overridden.
2. **The runbook's step-3 guard loop is broken under zsh.** It used `for path in
   ...`; zsh ties lowercase `path` to `PATH`, so the loop wiped `PATH` mid-script
   and later commands failed with `command not found` — *after* printing a
   success line. Worked around under `bash`. Fixed in the runbook.
3. **`install opencode` did not cover this machine's config.** The pre-existing
   file was `opencode.jsonc`; the installer only knows `opencode.json` and
   `tui.json`, so it created a fresh `opencode.json` beside it. Restore was still
   correct. See §7.
4. **The execution witness has spurious Claude Code rows.** A second Claude Code
   session on the same machine picked up the temporary `PreToolUse` hook from the
   shared `~/.claude/settings.json` and wrote witness rows with no accompanying
   capture, because `FAMILIAR_MACOS_SPIKE` was absent from its environment. The
   genuine row is 19:21:05.630Z. No capture file contains a contaminated chain,
   and the OpenCode retry ran with the other agents' hooks deliberately removed.
5. **OpenCode CLI was installed during the run.** The machine had only
   `/Applications/OpenCode.app`, which exposes no `opencode` command;
   `opencode-ai@1.18.21` was installed from npm to match the
   `@opencode-ai/plugin@1.18.21` already present.
6. **Step 6 ran four times, not once.** The first three OpenCode sessions failed
   in the provider layer before any tool call (a missing Google key, then a
   malformed OpenRouter key). All four sessions' records are retained.

## 7. Findings that are not about macOS

- **Familiar's OpenCode integration observes no tool events, by construction.**
  `integrations/opencode/plugin.js` registers `event`, `permission.ask`, and
  `dispose`; `integrations/opencode/binding.js` narrows the stream to
  `session.status` and `permission.replied` plus a `session.error` case. The
  runbook's "one authenticated tool event" premise does not hold for OpenCode.
  The successful session fired `init`, `session.busy` ×5, `session.idle` — the
  tool call ran and printed, and no hook saw it. This is a session-presence
  integration, which is a design fact worth stating explicitly somewhere.
- **`install opencode` does not understand `.jsonc`.** `src/install/opencode.js`
  opens by stating that opencode configs are JSONC, then hardcodes `tui.json` and
  `opencode.json`. An existing `opencode.jsonc` is invisible to it, and the
  sibling `opencode.json` it creates may change which file OpenCode reads. This
  is a bug on Linux too.
- **`BRANCH_TIMEOUT_MS = 250` is thin on macOS.** Beyond the test harness, a
  cold or security-scanned `git symbolic-ref` spawn can exceed it in production,
  falling through to `rev-parse` and showing a commit sha where Linux shows a
  branch name. Cosmetic, user-visible, worth a macOS caveat.

## 8. Verification performed on the returned artifacts

Checked mechanically before acceptance, independently of the tester's notes:

- All 30 records: chain starts at the recorded `hookPid`, ends at PID 1 / PPID 0,
  `ppid → pid` links unbroken, `comm` and `command` rows paired with matching
  leading PIDs. Zero structural problems.
- Executor frames match the notes exactly; the `; :` canary survives redaction in
  both shell-executed commands.
- 17 distinct command lines across all records, matching the tester's count.
- Secret sweep for `sk-`, `ghp_`, `AKIA`, `Bearer`, and `key=`/`token=` shapes:
  clean. The only `/Users/` value present anywhere is `/Users/REDACTED`, and the
  `login -f -l -p REDACTED` frame carries no account name.

One correction to the tester's notes: the successful OpenCode session fired
`session.busy` five times, not three. Nothing else in the notes diverged from the
artifacts.
