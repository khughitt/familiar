# Kitty graphics protocol

A concise engineering reference for familiar. Current as of 2026-07-17.

## Rule of thumb

Kitty graphics is fast when pixels are uploaded once and placements are cheap. It becomes
expensive when a client repeatedly sends complete images through the TTY. For familiar's
occasional pose changes, transport is not a problem. Animation, live filters, remote sessions,
and terminal multiplexers are where the constraints become architectural.

The protocol is raster-only: 24-bit RGB, 32-bit RGBA, or PNG. It has no vector primitives,
shader/filter API, hit testing, or image-specific mouse events.

Primary reference: [Kitty terminal graphics protocol][kitty-protocol].

## Transport and hard limits

- Direct image data is base64 encoded, adding about 33% to the payload.
- Direct payloads are split into at most 4096 encoded bytes per APC escape.
- One chunked image must finish before another graphics command begins. The terminal displays
  nothing until the complete upload has been received and validated.
- File, temporary-file, and shared-memory media avoid bulk TTY transport, but require the client
  and terminal to share the relevant namespace. They are not general SSH/container solutions.
- RGB/RGBA can use zlib. Applying zlib to a PNG normally adds CPU for negligible savings because
  PNG is already compressed.
- Control values and image/placement identifiers are 32-bit. Practical image dimensions are
  bounded much earlier by decoded memory, decoder limits, texture limits, and terminal policy.
- Kitty's image quota is 320 MB per screen buffer. Animation frames have a separate disk-backed
  quota of five times the base quota. Old image data may be evicted.

There is a final success/error reply when an image identifier is used, but no graphics-level
per-chunk credit or flow-control window. A client sending a burst relies on the PTY, transport,
and terminal parser to absorb it.

## Performance checklist

In descending order of likely value:

1. **Do not redraw an unchanged state.** Familiar already suppresses steady-state pose uploads.
2. **Upload once, place many times.** Keep a stable image ID and use `a=p` for movement, resizing,
   or repeated display. OpenCode already follows this pattern.
3. **For animation, preload frames or a spritesheet.** Select a frame with a small placement or
   source-rectangle command instead of sending a PNG on every tick. Verify the exact update
   semantics in every target terminal.
4. **Use terminal-driven animation only as a Kitty-specific enhancement.** It avoids client
   scheduling jitter and supports rectangle deltas, but Ghostty does not currently render Kitty
   animation-frame commands.
5. **Pre-size and pre-encode assets.** Do not upload substantially more pixels than the largest
   surface will render. Keep PNG encoding out of the state-change latency path.
6. **Cache derived art by content and parameters.** Filters should key cache entries on source
   digest, filter specification, output dimensions, and encoder settings. Continuous effects
   should use precomputed frames when possible.
7. **Keep one terminal writer per render path.** Never let a timer, hook, watcher, and TUI frame
   callback independently emit chunked images. Queue state changes and write at an owned frame
   boundary.
8. **Prefer local file/shared memory only after capability is established.** Familiar often has
   a write-only relationship with another process's terminal, so it cannot safely negotiate a
   fast path and should not assume one.
9. **Measure the wire.** Record bytes, chunk count, image decode/encode time, time-to-visible,
   frame jitter, and p95 state-change latency in both Kitty and Ghostty at the real display size.

Current terminal pose PNGs are approximately 89-203 KB, with a mean of 141 KB. Direct transfer
therefore costs approximately 118-271 KB and 29-67 graphics chunks per pose change (mean about
188 KB and 46 chunks). This is fine for transitions; it is the wrong unit of work for every
animation frame.

## Kitty and Ghostty

Ghostty [supports the base Kitty graphics protocol][ghostty-features], including Unicode
placeholders. Its default image storage limit is also 320 MB per primary or alternate screen
and is configurable with [`image-storage-limit`][ghostty-config].

Important differences and cautions:

- Ghostty's [animation-frame support issue][ghostty-animation] remains open. Treat Kitty's
  `a=f`, `a=a`, and frame-composition actions as Kitty-only until a cross-terminal probe proves
  otherwise.
- Do not rely on Ghostty accepting retransmission of a displayed image ID as an in-place update.
  That behavior has differed from Kitty and is not the portable animation path.
- Alpha/gamma blending can differ slightly between renderers and platforms. Judge transparent
  art in both terminals on light and dark backgrounds.
- Ghostty is under active development and OpenCode auto-updates by default. Pin or record tested
  versions for visual/protocol acceptance runs.

[Ghostty PR #12144][ghostty-12144] does **not** add a new feature to the Ghostty application. It
exposes existing Kitty-image parsing and configuration through libghostty's C API so other
applications can embed the VT library. It adds a host-provided PNG decode callback and exposes
the storage limit plus file, temporary-file, and shared-memory loading switches. The PR
explicitly leaves querying image metadata and rendering those images to follow-up work. It is
relevant if familiar ever embeds libghostty; it does not remove today's terminal portability
constraints.

## Familiar by agent surface

The state source and render surface are separate concerns. See [the measured surface field
guide](../surfaces.md) for the full evidence.

### Claude Code

Approach:

- A hook writes the PNG to the agent's stdout under a stable, session-derived 24-bit image ID and
  creates a **virtual** placement (`U=1`). It draws nothing by itself.
- `familiar statusline` prints Kitty Unicode placeholder cells carrying that ID. Claude owns and
  lays out those cells, so the image cannot cover its dialogs or transcript.
- A state transition replaces the image under cells that were printed independently.

Additional constraints:

- The current theme allocates four status-line rows. Every pose for a member must share one
  canvas and cell box because the hook and status-line processes do not communicate.
- The status line hides during permission prompts, autocomplete, and some menus, so the
  `needs-approval` familiar is not visible there.
- Current Claude Code status lines support multiple output lines and an optional
  `refreshInterval` with a minimum of one second. This is enough for slow ASCII motion or
  once-per-second frame selection, not smooth client-driven raster animation.
- Status-line executions are debounced; a new update cancels an in-flight command. Slow Git or
  image work will make the display stale.
- The hook and status line must not independently stream image chunks. A future animation design
  needs one serialized owner rather than two opportunistic writers.
- tmux is deliberately rejected by familiar today even though wrapped passthrough can work: a
  hook cannot verify that the user's tmux server permits passthrough.

Source: [Claude Code status-line documentation][claude-statusline].

### Codex

Approach:

- Familiar emits no graphics escapes into Codex. Codex owns the cells and its native pet
  renderer; familiar installs a spritesheet and `pet.json` on disk.
- The accepted sheet is 1536x1872: an 8x9 grid of 192x208 frames, or 72 cells total. The current
  familiar generator uses eight cells and leaves the rest transparent.
- The current public pet documentation specifies a transparent PNG or WebP, exactly 1536x1872
  and at most 20 MiB. Terminal pets require iTerm2 3.6+, Kitty graphics, or Sixel, and are
  unavailable inside tmux and Zellij.

The 72 cells are a capacity ceiling, not a target. Animation frame allocation is shared across
idle and all activity animations, and reduced-motion users receive a still frame.

There is an evidence mismatch to resolve before changing the mapping. Familiar's existing
test-card probes observed cells 0-5 as the forced idle loop, cell 6 as `running`, cell 7 as a
second busy/`waiting` phase, no pet during approval, and no distinct completion pose. Current
Codex documentation describes terminal pet states as Running, Needs input, Ready, and Blocked.
Re-run the test-card probe against the target Codex version before assigning new frames; do not
infer animation names from labels.

Source: [current Codex pets documentation][codex-pets].

### OpenCode

Approach:

- The server plugin folds OpenCode events into familiar's bus.
- A separate TUI plugin reserves a reactive box in `sidebar_content` (currently capped at 16
  rows), uploads a pose once with `a=t`, and reasserts its normal `a=p` placement from OpenTUI's
  post-process callback each frame.
- Watchers and timers only queue state. Terminal writes happen inside the frame callback, which
  keeps OpenTUI and graphics output serialized.
- Normal placements are necessary: OpenTUI cannot represent the combining-diacritic structure
  used by Kitty Unicode placeholders. Reasserting the placement each frame keeps it attached to
  the reserved sidebar box and hides it when the sidebar is absent.

This is the strongest surface for portable, client-selected animation because it already owns a
frame loop and a rectangle. A likely efficient primitive is a preloaded spritesheet plus cheap
source-rectangle/placement changes, but that must be proven in both Kitty and Ghostty before it
becomes a design decision.

The main additional limitation is integration stability. Familiar uses OpenCode's TUI plugin,
slot, renderer, and post-process APIs; the public plugin documentation primarily describes the
server/event plugin surface. Treat the TUI integration as version-coupled and keep the existing
real-OpenCode acceptance test.

Sources: [OpenCode plugin documentation][opencode-plugins] and the local
[OpenCode sprite design](../specs/2026-07-16-opencode-sprite-design.md).

## Mouse interaction

The graphics protocol itself cannot make an image clickable. It does not report an image or
placement ID when the pointer enters or clicks a placement, and it has no hit-test or callback
action.

A terminal application can enable the separate terminal mouse protocol, receive button/motion
events on stdin, and map cell or SGR-pixel coordinates to its own placement rectangles. Kitty
also extends [SGR-pixel reporting][kitty-mouse] with a mouse-leave event. The application still
owns hit testing, hover state, click behavior, and accessibility.

Implications for familiar:

- Claude Code and Codex own stdin. Familiar must not enable mouse reporting or consume their
  input, so their current familiar images cannot safely become independently interactive.
- OpenCode already owns terminal mouse capture (enabled by default) and familiar has a reserved
  sidebar box. Interaction could be added through the OpenCode/OpenTUI event system, not through
  Kitty graphics. That is a separate UI feature and should preserve normal text selection when
  OpenCode mouse capture is disabled.
- A text hyperlink around placeholder cells may provide terminal-managed link activation, but
  that is an OSC 8 link rather than general image mouse interaction.

## Filters and post-processing

Kitty graphics has no placement-level saturation, brightness, contrast, tint, blur, bloom,
noise, pixelation, or color-matrix operation. A filter layer must produce new pixels.

- **Static/user-tuned filters:** compute on change and cache the resulting PNG. This gives a
  responsive control surface without paying encode/transfer cost on every redraw.
- **State filters:** precompute during theme compilation where possible. This makes behavior
  deterministic across terminals and keeps state transitions cheap.
- **Continuous effects:** precompute a small loop of frames. Per-tick color conversion plus PNG
  encoding and direct transfer is the least favorable path.
- **Codex:** bake filters into its installed spritesheet; familiar cannot post-process Codex's
  native renderer at runtime.
- **Claude/OpenCode:** derived PNGs can be swapped by their existing render paths, subject to the
  animation-driver and writer-ownership constraints above.

For perceptual adjustments, state the working color space explicitly. HSL noise and CIE
LCh/OKLCh noise are different effects; brightness in encoded sRGB is not the same operation as
brightness in linear light. Preserve alpha separately unless changing coverage is intentional.

## Design work split

Keep these as separate design/spec/plan cycles:

1. **Animation assets and runtime:** shared animation vocabulary and metadata, then a distinct
   renderer strategy for Claude, Codex, and OpenCode, with Kitty/Ghostty acceptance probes.
2. **Filter pipeline:** filter vocabulary, color semantics, cache/provenance keys, CLI/config
   surface, and which outputs are compiled versus dynamic.
3. **Claude status-line dashboard:** use the existing four-row composition area for text/ASCII
   motion and session statistics. This can ship independently of raster animation and filters.

Do not make frame count a global theme invariant before the surface budgets are designed.

[kitty-protocol]: https://sw.kovidgoyal.net/kitty/graphics-protocol/
[kitty-mouse]: https://sw.kovidgoyal.net/kitty/misc-protocol/#reporting-when-the-mouse-leaves-the-window
[ghostty-features]: https://ghostty.org/docs/features
[ghostty-config]: https://ghostty.org/docs/config/reference#image-storage-limit
[ghostty-animation]: https://github.com/ghostty-org/ghostty/issues/5255
[ghostty-12144]: https://github.com/ghostty-org/ghostty/pull/12144
[claude-statusline]: https://code.claude.com/docs/en/statusline
[codex-pets]: https://learn.chatgpt.com/docs/pets?surface=cli
[opencode-plugins]: https://opencode.ai/docs/plugins/
