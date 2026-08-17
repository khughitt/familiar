export const BEL = '\x07';

// String Terminator. An OSC sequence may end with either BEL or ST — but BEL is
// ALSO the bell, so ending with it would ring the terminal on every tint and
// every tint write. Then "does this transition ring?" is not a question the code
// can answer, and it is not a question a test can ask. ST costs one byte and buys
// BEL back as a signal that means exactly one thing.
const ST = '\x1b\\';

export const oscBackground = (hex) => `\x1b]11;${hex}${ST}`;
export const oscCursor = (hex) => `\x1b]12;${hex}${ST}`;

// OSC 111 and 112 restore the terminal's own background and cursor colors.
export const oscReset = () => `\x1b]111${ST}\x1b]112${ST}`;
