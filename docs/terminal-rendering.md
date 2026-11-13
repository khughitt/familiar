# Terminal rendering

Type: protocol, data model, guide; document types 1. The emission and trace
formats are currently unversioned. This describes Familiar's terminal writers,
its retained offline verifier and acceptance limits. Read [surfaces](surfaces.md)
for platform claims and [testing](testing.md) for the automated test front door.

## Participants and emission ownership

Relay supplies ordered lifecycle observations. Familiar resolves presentation
intent; the emitter owns terminal writes and its per-session transmit ledger.
Claude's frontend owns statusline cells; the OpenCode TUI owns its sidebar box.
Codex draws its own pet and receives no Familiar pet graphics stream.

The intent is what Familiar wants; the ledger records what reached the terminal.
Every create/update/no-op decision and terminal byte is serialized under the same
session lock. The critical section reads the ledger, checks event sequence and
fresh owner liveness, decides the action, clears old evidence, writes, then
publishes evidence. Required terminal, sequence, ledger, lock and owner-alive
inputs are explicit; missing protection is an error, not an unprotected write.
A suppressed or failed transmission must not pretend an image exists.

SessionStart can race the frontend's switch to the alternate screen. A provisional
write therefore ignores held evidence and marks its own evidence provisional.
Once the statusline is up, its settle operation reacquires the same ownership and
transmit locks and creates the image; an intervening event can create it first.
A teardown can write its tombstone and reset without loading theme/image modules.

`writeAllSync` retries EINTR and handles short writes. Non-integer/zero progress,
negative counts and overruns fail; two processes must not interleave image chunks.
See [emit.js](../src/render/term/emit.js), [ledger.js](../src/render/term/ledger.js),
[io.js](../src/render/term/io.js) and [the section tests](../test/emit-section.test.js).

## Transport

The [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
is raster transport. Familiar encodes image data and emits complete chunked
programs; it cannot apply native shaders, vector effects or image hit-testing.
Encoded APC chunks are bounded at 4096 bytes. One image upload must finish before
another program can write to that terminal. Avoid retransmitting unchanged state;
OpenCode uploads and reuses placements rather than uploading each frame.
File/shared-memory transport is not assumed across SSH or containers. Proposed
filters, preload strategies and performance measurements are not shipped features.

Tint uses OSC 11 (background) and OSC 12 (cursor), terminated with ST, not BEL.
BEL is reserved for an actual bell: needs-input, needs-approval and error ring;
other presentation states do not. Normal session-end reset emits both OSC 111
and OSC 112. A reap reconciles files without terminal bytes, so an abandoned
terminal can stay tinted until a later live event or manual terminal reset.
Familiar does not own the terminal title.

## Tmux

Probe the server/pane and attached outer client before drawing. The pane must
have `allow-passthrough all`; `on` drops hidden-pane escapes. Require Kitty or
Ghostty client identity. The probe includes allow-passthrough, client terminal
name/type/TTY/pid/creation time; its chosen client is part of transmit evidence.
Each APC is wrapped separately as a tmux DCS, with inner ESC bytes doubled.
Wrapping a whole large program as one DCS can exceed tmux's input buffer.

Enable passthrough with `tmux set -g allow-passthrough all`. Through tmux 3.7c,
full-width panes avoid the known combining-character redraw problem. The
statusline can have 256-colour output; FORCE_COLOR=3 is only an untested workaround.
A newly attached client gets a pet at the next state change. Mixed outer-terminal
multiple clients remain unaddressed. These limits do not qualify Codex's native
renderer; see [native ownership](surfaces.md#codex).

## OpenCode

The TUI reserves a sidebar rectangle, queues state from timers/watchers and emits
only inside OpenTUI's post-process frame callback. Normal placements are used
because that layout path cannot express the placeholder combining structure.
Reasserting a placement follows the current box and hides it when the box is absent.
A placement envelope is **save cursor, one absolute row/column move, one a=p APC,
restore cursor**, in that order. Bare hide/free commands are outside the envelope.
Only this writer may emit those cursor controls; a hook writer must not move it.
TUI API coupling and physical rendering limits remain [explicit](surfaces.md#opencode).

## Native pet boundary

The Codex compiler makes an 8×9 grid of 192×208 frames, 1536×1872 overall.
It fills cells 0–5 idle, 6 running, 7 waiting, 8–13 review and 14–19 failed;
20–71 are transparent. Review/failed are one-shot tracks with final-cell holds.
These declarations do not prove which tracks a native frontend selects.
Historical test-card probes observed the idle loop, running/waiting phases, no
pet during approval and no distinct completion pose. New frame allocation needs
its own version-bound native probe, not inference from track names.
See [compiler source](../src/render/codex/pets.js) and [installation](install.md#codex-pets).

## Trace records

The offline [gate verifier](../tools/gate-verify.mjs) reads newline-delimited JSON,
one object per terminal write. There is no schema-version field. Blank lines are
ignored; malformed JSON lines each become a violation while other records are
checked. Whitespace-only lines are not blank under this parser.

The table describes the producer contract and what the current verifier consumes;
it is not a claim of complete JSON-schema validation. Unknown metadata is ignored.
Missing structural arrays or unexpected JSON shapes can crash instead of producing
a clean violation; a crash never establishes a pass.

| Record field | Meaning, expected values and checks |
| --- | --- |
| kind | `write`; other values produce a violation. |
| agent | Agent label for summary/diagnosis; optional, not an independently authenticated identity. |
| event | Native event label used in diagnosis; optional. |
| target | Resolved target path or null/absent; a present path requires targetRdev. |
| targetRdev | Target device identity; must equal fdRdev when target is present. |
| fdRdev | Written file descriptor's device identity; required, never null. Compared to the external expected device when supplied. |
| expect | Required nonnull expectation object described below. Its inputs must travel with the write. |
| escapes | Required array of decomposed escapes described below. |
| timestamp, pid and additional capture metadata | Historical capture context; not checked by this verifier. |

Expectations are attached before output, not reconstructed by decoding the result.

| Expectation field | Meaning, values and validation boundary |
| --- | --- |
| source | `opencode-sprite` selects sprite envelope rules. Other/absent values use hook rules; this is a trusted producer classification. |
| capability | `none`, `static-graphics` or `kitty-animation`. An external --expect-capability must match; without it there is no independent classifier check. |
| state | Presentation state: idle, working, needs-input, needs-approval, done, error, or null/absent when no state. The ringing set is independent of the writer's bell decision. |
| imageId | Numeric expected image id; null/absent means no graphics planned. Every emitted id must match and at least one APC must name it when graphics are expected. |
| commands | Optional nonnull encoder chunk count; compared with actual APC count. This checks transfer integrity, not encoder correctness. |
| placement | Optional object with cols and rows from the sprite box. A transmit action a=t/T must carry matching c/r controls. Not a frame-sequence check. |
| presented | Exactly false means no tint or bell was produced, even if state/colours are recorded. Otherwise nonnull expected colours and the hook ringing-state rule apply. |
| backdrop, base | Expected OSC 11/12 strings; null/absent omits that colour comparison. The verifier compares literal payloads, not colour-space validity. |
| reset | True for normal session end: both reset codes are required. Otherwise either reset code is a violation. The flag is trusted; it does not authenticate the event label. |

Numeric fields are producer numbers; the verifier does not comprehensively enforce
integer/range types. At capability none, any APC is a violation. When imageId is
null/absent, any APC is also a violation even on a graphics-capable terminal.
When presented is false, any OSC 11/12 or BEL fails. Otherwise the hook's bell count
is exactly one for a ringing state, zero for the others; sprite writes do not
receive that hook state rule. A nonempty cell normally needs a session-end restore.

## Escape records

Every escape has `k`. These are the consumed fields; bulk pixels are not needed.

| k | Fields and allowed meaning |
| --- | --- |
| APC | keys: comma-separated single-letter k=v controls. Optional capture payload length/digest metadata is not independently checked. Image ids use i=digits; an action chunk must exist for expected graphics. |
| OSC | code and payload: only 11, 12, 111 and 112. Payloads for 11/12 match their expected colours when supplied. |
| BEL | One bell; no additional consumed field. |
| ESC | code 7 or 8, only for the sprite envelope's ordered save/restore. |
| CSI | final H and params `<row>;<column>`, digits only, only for that envelope's absolute move. |
| OTHER, UNTERMINATED | Always violations; hex supplies diagnostics. |

Unknown kinds fail. Hook ESC/CSI controls fail even if they balance. For sprites,
reverse/nested/unclosed envelopes, extra moves, non-placement APCs inside an
envelope, or multiple envelopes in one write fail. Bare hide/free APCs outside an
envelope remain possible. Image-id checks cover every chunk, not only the first.
OpenCode graphics have shallower evidence when their producer omitted planned
count/placement; a missing comparison is a limitation, not a stronger pass.

## Acceptance

For a previously captured trace, run the verifier with independently recorded
terminal device and expected capability:

```sh
node tools/gate-verify.mjs trace.jsonl --expect-rdev DEVICE_NUMBER --expect-capability static-graphics
```

Exit 0 means no parsed-line or verifier violations; 1 means violations; missing
filename prints usage and exits 2. Read the actual status: an exception without
VIOLATION lines is a crash. `--no-require-restore` deliberately narrows the claim.
An empty file can pass this low-level verifier; acceptance must reject missing or
empty traces and separately establish driven-state coverage. The encoder's own
chunk count and the lack of frame-sequence validation remain evidence limits.

For physical acceptance, record exact OS/Node/agent/terminal versions and a separate
human observation of position, tint and bell. Independently capture the window's
rdev before launching; verify every write reached it. Exercise launch/idle, work,
input/approval where exposed, done/error, clean session-end reset and abnormal-death
reap. A file-only reap must not emit terminal bytes. Record unavailable states as
limitations rather than marking undriven states passed. Drive a graphics-disabled
negative control by removing capability markers: no APC may appear, while valid
TTY tint/bell still follows its contract. Include background/daemon ancestry cases.

Check tmux passthrough/full-width/colour and next-state-after-attach behavior.
Observe cells around menus/dialogs and resize; numeric trace agreement cannot
prove layout or focus. A checklist pass does not qualify an untested combination.
Native acceptance needs the host owner's authorization; this guide does not run it.

## Failure and evidence gaps

The retained tools/gate helpers are unsupported historical capture helpers. Several
still read the retired agents.json state path, and current io.js has no opt-in
capture tee. Setting their trace variable alone does not instrument this checkout.
Do not use those scripts to promote a new physical support claim until the capture
path and state readers are repaired and independently checked. The offline verifier
and its independent ringing, device and placement rules remain available unchanged.

Missing expected device/capability, omitted colour/count/placement inputs, unknown
native state mappings and a structurally malformed trace all limit a verdict.
Portable [tests](testing.md) cover engine behavior; they do not supply fresh
physical Mac, OpenCode or live desktop evidence.
