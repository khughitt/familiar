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

// Variables that mean "the terminal is behind a multiplexer". They demand the probe
// result (src/render/term/tmux.js), because the inner environment cannot answer the
// question. Exported so environment-scrubbing tests clear the same list the classifier reads.
export const MULTIPLEXER_MARKERS = ['TMUX'];

// The outer terminal, as the tmux client reports it. NOT the inherited environment: a
// tmux server carries the environment of the client that started it, and the client
// attached now may be a different program on a different machine.
function outerCapability({ termname, termtype }) {
  if (termname === 'xterm-kitty' || termtype.startsWith('kitty')) return GRAPHICS_CAPABILITY.ANIMATION;
  if (termname === 'xterm-ghostty' || termtype.startsWith('ghostty')) return GRAPHICS_CAPABILITY.STATIC;
  return GRAPHICS_CAPABILITY.NONE;
}

// `tmux` is the result of tmuxFacts(env). It is REQUIRED whenever env names a
// multiplexer, on the same principle as the missing env default: the caller decides
// which process was probed, and a caller that forgot to probe gets told, not guessed for.
export function graphicsCapability(env, tmux) {
  if (MULTIPLEXER_MARKERS.some((name) => env[name])) {
    if (tmux === undefined || tmux === null) {
      throw new TypeError('graphicsCapability: the environment names a multiplexer but no probe result was given — call tmuxFacts(env) first');
    }
    if (!tmux.ok) return GRAPHICS_CAPABILITY.NONE;
    // `on` forwards passthrough only while the pane is visible. A level-triggered hook
    // firing in a background window would leave the outer terminal holding the previous
    // state's image — a cat saying "working" while the session waits for approval. The
    // rule since virtual placement is that the cat is never stale; a terminal that cannot
    // honour it gets no cat, the same way a plain TERM gets no substitute.
    if (tmux.passthrough !== 'all') return GRAPHICS_CAPABILITY.NONE;
    return outerCapability(tmux);
  }
  // TERM says tmux or screen but $TMUX is absent: a remote shell inside someone else's
  // multiplexer, or GNU screen. Neither has a passthrough story.
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
