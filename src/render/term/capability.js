export const GRAPHICS_CAPABILITY = Object.freeze({
  ANIMATION: 'kitty-animation',
  STATIC: 'static-graphics',
  NONE: 'none',
});

// Every environment variable that can identify a graphics-capable terminal.
// Exported so environment-scrubbing tests clear the same source of truth the
// classifier reads.
export const GRAPHICS_MARKERS = [
  { name: 'TERM', value: 'xterm-kitty' },
  { name: 'KITTY_WINDOW_ID', value: null },
  { name: 'TERM_PROGRAM', value: 'ghostty' },
  { name: 'GHOSTTY_RESOURCES_DIR', value: null },
  { name: 'GHOSTTY_BIN_DIR', value: null },
];

export const MULTIPLEXER_MARKERS = ['TMUX'];

export function graphicsCapability(env) {
  if (MULTIPLEXER_MARKERS.some((name) => env[name])) return GRAPHICS_CAPABILITY.NONE;
  if (/^(screen|tmux)/.test(env.TERM ?? '')) return GRAPHICS_CAPABILITY.NONE;

  // Explicit Ghostty identity wins over stale Kitty markers inherited from an
  // outer process: Ghostty supports static graphics here, not Kitty animation.
  if (env.TERM_PROGRAM === 'ghostty') return GRAPHICS_CAPABILITY.STATIC;

  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID) {
    return GRAPHICS_CAPABILITY.ANIMATION;
  }
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) {
    return GRAPHICS_CAPABILITY.STATIC;
  }
  return GRAPHICS_CAPABILITY.NONE;
}
