# SOURCE this IN THE GATE TERMINAL WINDOW:  source gate-tools/gate-rdev.sh
#
# Replaces §2's terminal-rdev capture, which is wrong by construction:
#
#     export FAMILIAR_GATE_RDEV="$(node -e '...fstatSync(1).rdev')"
#
# `$( )` replaces fd 1 with the capture pipe, so fstat(1) measures the PIPE, not the
# window. It yields 0 on every run. Guard 3 requires command substitution for VERSION
# strings (a redirected block lets a child seek the shared fd); for the device it is
# exactly wrong, because the thing being measured IS fd 1.
#
# `tty` reads fd 0, which `$( )` leaves alone, so the tty PATH survives the substitution.
# Stat that path: it is the same device the trace records as `targetRdev`.

_gr_tty="$(tty)"
case "$_gr_tty" in
  /dev/*) ;;
  *)
    printf 'STOP: no controlling tty (%s).\n' "$_gr_tty" >&2
    printf '      Source this in the gate terminal window itself, not through a pipe,\n' >&2
    printf '      a subshell capture, or an agent tool call.\n' >&2
    unset _gr_tty
    return 2 2>/dev/null || exit 2
    ;;
esac

_gr_rdev="$(node -e '
const fs = require("node:fs");
const s = fs.statSync(process.argv[1]);
if (!s.isCharacterDevice()) throw new Error(`${process.argv[1]} is not a character device`);
if (!Number.isInteger(s.rdev) || s.rdev === 0) throw new Error(`implausible rdev ${s.rdev}`);
process.stdout.write(String(s.rdev));
' "$_gr_tty")"

if [ -z "$_gr_rdev" ]; then
  printf 'STOP: could not resolve the device of %s\n' "$_gr_tty" >&2
  unset _gr_tty _gr_rdev
  return 1 2>/dev/null || exit 1
fi

export FAMILIAR_GATE_RDEV="$_gr_rdev"
printf 'ok: this window is %s, rdev %s\n' "$_gr_tty" "$FAMILIAR_GATE_RDEV"

case "$FAMILIAR_TERMINAL" in
  kitty)   export FAMILIAR_GATE_CAPABILITY=kitty-animation ;;
  ghostty) export FAMILIAR_GATE_CAPABILITY=static-graphics ;;
  *) printf 'note: FAMILIAR_TERMINAL is %s; capability not set\n' "${FAMILIAR_TERMINAL:-<unset>}" >&2 ;;
esac

# --- correct the versions file in place, if it already carries the bogus value ---
_gr_versions="$FAMILIAR_GATE_DIR/versions-$FAMILIAR_TERMINAL.txt"
if [ -f "$_gr_versions" ]; then
  _gr_old="$(sed -n 's/^terminal-rdev=//p' "$_gr_versions")"
  if [ "$_gr_old" = "$FAMILIAR_GATE_RDEV" ]; then
    printf 'ok: %s already records rdev %s\n' "$(basename "$_gr_versions")" "$FAMILIAR_GATE_RDEV"
  elif [ -z "$_gr_old" ]; then
    printf 'terminal-rdev=%s\n' "$FAMILIAR_GATE_RDEV" >> "$_gr_versions"
    printf 'appended terminal-rdev=%s to %s\n' "$FAMILIAR_GATE_RDEV" "$(basename "$_gr_versions")"
  else
    cp -p "$_gr_versions" "$_gr_versions.uncorrected"
    node -e '
const fs = require("node:fs");
const [file, rdev] = process.argv.slice(1);
const text = fs.readFileSync(file, "utf8");
const next = text.replace(/^terminal-rdev=.*$/m, `terminal-rdev=${rdev}`);
if (next === text) throw new Error("no terminal-rdev line to correct");
fs.writeFileSync(file, next, { mode: 0o600 });
' "$_gr_versions" "$FAMILIAR_GATE_RDEV"
    printf 'CORRECTED %s: terminal-rdev %s -> %s\n' "$(basename "$_gr_versions")" "$_gr_old" "$FAMILIAR_GATE_RDEV"
    printf '  the uncorrected file is kept alongside as .uncorrected (do NOT return it)\n'
    printf '  RECORD THIS IN notes.md as a deviation: §2 captured the substitution pipe,\n'
    printf '  not the window; re-derived in the same window via tty(1).\n'
  fi
  # §2 appends TWO lines; the capability one is not device-derived but belongs beside it.
  if [ -n "$FAMILIAR_GATE_CAPABILITY" ] \
     && ! grep -q '^expected-capability=' "$_gr_versions"; then
    printf 'expected-capability=%s\n' "$FAMILIAR_GATE_CAPABILITY" >> "$_gr_versions"
    printf 'appended expected-capability=%s\n' "$FAMILIAR_GATE_CAPABILITY"
  fi
else
  printf 'note: no %s yet — §2 has not run for this terminal\n' "$(basename "$_gr_versions")" >&2
fi
unset _gr_tty _gr_rdev _gr_versions _gr_old
