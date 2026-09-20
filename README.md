# familiar

Desktop/terminal/agent familiar engine. Themes install separately with
`familiar theme add`; this repo ships no art.

- Requires Node.js 22+; see [installation and integration setup](docs/install.md).
- Linux and macOS 14+ on Apple Silicon. On macOS, terminal rendering is still
  provisional — see [surfaces](docs/surfaces.md) for what each platform claims.
- Run tests: `just test` (or `npm test` without [just](https://just.systems))
- Pre-split history: https://github.com/khughitt/familiar-archive (private archive)

## CLI

`familiar --help` lists every command; `familiar <command> --help` and
`familiar theme list --help` (nested help works the same way) print a command's
own usage, and `familiar help <command>...` is the same thing spelled as a verb.
`-V`/`--version` prints the installed version.

`--json`/`--pretty` (mutually exclusive, `FAMILIAR_FORMAT` overrides the
default) and `--color auto|always|never` (default `never`, `FAMILIAR_COLOR`
overrides it) work before or after the command. A usage error — an unknown
command, a missing argument, a value outside its set — exits 2; a command that
ran and failed exits 1, printing `{"error":{"kind","detail"}}` on stderr under
`--json`.

Shell completion: `eval "$(FAMILIAR_COMPLETE=zsh familiar)"` (or `bash` for the
bash completer), sourced from your shell's rc file.
