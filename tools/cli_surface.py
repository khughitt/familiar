#!/usr/bin/env python3
# cli_surface 3: the conformance half of docs/specs/2026-09-20-cli-conventions-design.md.
"""Build a CLI's parser surface and compare it with its rows in cli.toml.

Vendored from ops as tools/cli_surface.py beside tools/cli.toml; never edited in a project.
A surface is a set of rows, each a tuple, so two surfaces compare as sets:

    ("command", path, summary)
    ("arg", path, index, name, value, values, required, variadic)
    ("option", path, names, value, values, default, arity, repeatable, required)

`path` and `names` are tuples; `names` lists long names first, then short aliases, each
group in declaration order; `index` is the positional's 0-based position; `values` is a
tuple or (); `default` is a string or None, and for a flag it is "true" when the flag
defaults on and None otherwise. Roles, verbs, output, protocol, and exception are
table-only metadata and never compared.

--json, --pretty, --color, -h, and --help are implied on every command and never rows;
-V and --version are implied at the root only, so a nested --version (mindful history)
is an ordinary option row. The root `help` command is implied by the Help rule and
never a row.

    python3 tools/cli_surface.py rows <cli> [tools/cli.toml]   # the table's rows as JSON lines
"""
import argparse
import json
import pathlib
import sys
import tomllib

VALUE_KINDS = {"none", "string", "int", "path", "ref", "when", "age", "enum"}
IMPLIED_EVERYWHERE = {"--json", "--pretty", "--color", "-h", "--help"}
IMPLIED_AT_ROOT = {"-V", "--version"}


def implied(names, path):
    """True when an option with these names is implied by the CLI header at this path."""
    names = set(names)
    return bool(names & IMPLIED_EVERYWHERE) or (not path and bool(names & IMPLIED_AT_ROOT))


def normalize_names(names):
    """Long names first, then short aliases, each group in the order given."""
    names = list(names)
    return tuple([n for n in names if n.startswith("--")] + [n for n in names if not n.startswith("--")])


def _opt_row(path, names, value, values=(), default=None, arity="1", repeatable=False, required=False):
    if value == "none":
        arity = None
        default = "true" if default in (True, "true") else None
    return ("option", tuple(path), normalize_names(names), value, tuple(values), default, arity, bool(repeatable), bool(required))


def table_rows(table_path, cli):
    """The rows cli.toml declares for one CLI."""
    doc = tomllib.loads(pathlib.Path(table_path).read_text())
    vocab = doc["vocabulary"]["options"]
    rows = set()
    for cmd in doc["cli"][cli].get("commands", []):
        path = tuple(cmd["path"])
        if path:
            rows.add(("command", path, cmd["summary"]))
        for index, arg in enumerate(cmd.get("args", [])):
            rows.add(("arg", path, index, arg["name"], arg["value"], tuple(arg.get("values", ())), bool(arg["required"]), bool(arg.get("variadic", False))))
        for opt in cmd.get("options", []):
            names = vocab[opt["shared"]]["names"] if "shared" in opt else opt["names"]
            rows.add(_opt_row(path, names, opt["value"], opt.get("values", ()), opt.get("default"),
                              opt.get("arity", "1"), opt.get("repeatable", False), opt.get("required", False)))
    return rows


def _argparse_kind(action):
    if action.nargs == 0:
        return "none"
    if action.choices is not None:
        return "enum"
    name = getattr(action.type, "__name__", None)
    if name == "Path":
        return "path"
    if name == "int":
        return "int"
    if name in VALUE_KINDS:
        return name
    return "string"


def argparse_rows(parser, path=(), summary=None):
    """The live surface of an argparse parser tree. A subparser's help is its summary,
    its own description when it has no help; a `type=` callable named ref, when, or
    age declares that value kind; Path and int map. The parser is never modified."""
    rows = set()
    if path:
        rows.add(("command", tuple(path), (summary or parser.description or "").rstrip(".")))
    index = 0
    for action in parser._actions:
        if isinstance(action, argparse._HelpAction):
            continue
        if isinstance(action, argparse._VersionAction) and not path:
            continue
        if isinstance(action, argparse._SubParsersAction):
            helps = {c.dest: c.help for c in action._choices_actions}
            seen = set()
            for name, sub in action.choices.items():
                if id(sub) in seen:
                    continue
                seen.add(id(sub))
                if not path and name == "help":
                    continue
                rows |= argparse_rows(sub, path + (name,), helps.get(name) or sub.description)
            continue
        kind = _argparse_kind(action)
        values = tuple(action.choices) if action.choices is not None else ()
        if action.option_strings:
            if implied(action.option_strings, path):
                continue
            default = None
            if kind == "none":
                default = action.default is True
            elif action.default not in (None, argparse.SUPPRESS, [], ()):
                default = str(action.default)
            arity = "1.." if action.nargs in ("+", "*") else "1"
            repeatable = isinstance(action, (argparse._AppendAction, argparse._ExtendAction))
            rows.add(_opt_row(path, action.option_strings, kind, values, default, arity, repeatable, action.required))
        else:
            rows.add(("arg", tuple(path), index, action.dest.replace("_", "-"), kind, values,
                      action.nargs not in ("?", "*"), action.nargs in ("+", "*")))
            index += 1
    return rows


def _click_kind(param):
    """(value kind, values) for a click parameter's type."""
    import click
    if isinstance(param.type, click.Choice):
        return "enum", tuple(param.type.choices)
    if isinstance(param.type, click.Path):
        return "path", ()
    if param.type.name in ("integer", "integer range"):  # click.INT and click.IntRange
        return "int", ()
    name = getattr(param.type, "name", "string")
    return (name if name in VALUE_KINDS else "string"), ()


def _click_default(param, kind):
    """The row's default: "true" for a flag that defaults on, else the default as a string,
    None when click records none (None, or the UNSET sentinel of click 8.3+)."""
    import click.core
    unset = (None, getattr(click.core, "UNSET", None))
    if kind == "none":
        return "true" if param.default is True else None
    if any(param.default is u for u in unset):
        return None
    return str(param.default)


def click_rows(group, path=()):
    """The live surface of a click group tree."""
    import click
    rows = set()
    if path:
        rows.add(("command", tuple(path), (group.help or "").strip().split("\n")[0].rstrip(".")))
    index = 0
    for param in group.params:
        if isinstance(param, click.Option):
            names = tuple(param.opts) + tuple(param.secondary_opts)
            if implied(names, path) or set(names) & {"--help"}:
                continue
            kind, values = ("none", ()) if param.is_flag else _click_kind(param)
            rows.add(_opt_row(path, names, kind, values, _click_default(param, kind), "1", param.multiple, param.required))
        else:
            kind, values = _click_kind(param)
            rows.add(("arg", tuple(path), index, param.name.replace("_", "-"), kind, values, bool(param.required), param.nargs == -1))
            index += 1
    if isinstance(group, click.Group):
        for name, cmd in group.commands.items():
            if not path and name == "help":
                continue
            rows |= click_rows(cmd, path + (name,))
    return rows


def _global_options(parser):
    """The root parser's own options as (flags, valued): what may precede the command."""
    flags, valued = set(), set()
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction) or not action.option_strings:
            continue
        (flags if action.nargs == 0 else valued).update(action.option_strings)
    return flags, valued


def argparse_candidates(parser, words, index):
    """Completion candidates for words[index] as (value, description) pairs, from the
    argparse tree: commands at a command position, the current command's options for a
    word starting with '-', an enum option's or positional's values otherwise. The root
    parser's own options before the command are skipped (a valued one with its value),
    and candidates are filtered by the word's prefix so the shell need not."""
    global_flags, global_valued = _global_options(parser)
    current = parser
    consumed = 1
    while consumed < index:
        token = words[consumed]
        if token in global_flags:
            consumed += 1
            continue
        if token in global_valued:
            consumed += 2
            continue
        subs = next((a for a in current._actions if isinstance(a, argparse._SubParsersAction)), None)
        if subs is None or token not in subs.choices:
            break
        current = subs.choices[token]
        consumed += 1
    word = words[index] if index < len(words) else ""
    prev = words[index - 1] if index >= 1 else ""
    found = []
    for action in current._actions:
        if prev in action.option_strings and action.choices is not None:
            found = [(str(c), "") for c in action.choices]
            break
    else:
        if word.startswith("-"):
            found = [(n, action.help or "") for action in current._actions for n in action.option_strings if n.startswith("--") or not word.startswith("--")]
        else:
            subs = next((a for a in current._actions if isinstance(a, argparse._SubParsersAction)), None)
            if subs is not None:
                helps = {c.dest: c.help or "" for c in subs._choices_actions}
                found = [(name, helps.get(name, "")) for name in subs.choices]
            else:
                for action in current._actions:
                    if not action.option_strings and action.choices is not None:
                        found = [(str(c), "") for c in action.choices]
                        break
    return [(v, d) for v, d in found if v.startswith(word)]


def completion_script(name, shell):
    """The zsh or bash script that delegates to `<NAME>_COMPLETE=<shell> <name> -- words`."""
    var = name.upper().replace("-", "_") + "_COMPLETE"
    if shell == "zsh":
        return (f"#compdef {name}\n"
                f"_{name}() {{\n"
                f"  local -a c\n"
                f"  c=(\"${{(@f)$({var}=zsh {var}_INDEX=$((CURRENT-1)) {name} -- \"${{words[@]}}\" 2>/dev/null)}}\")\n"
                f"  c=(\"${{c[@]//$'\\t'/:}}\")\n"
                f"  [[ -n $c ]] && _describe '{name}' c\n"
                f"}}\n"
                f"compdef _{name} {name}\n")
    if shell == "bash":
        return (f"_{name}() {{\n"
                f"  local IFS=$'\\n'\n"
                f"  COMPREPLY=($({var}=bash {var}_INDEX=$COMP_CWORD {name} -- \"${{COMP_WORDS[@]}}\" 2>/dev/null | cut -f1))\n"
                f"}}\n"
                f"complete -F _{name} {name}\n")
    raise ValueError(f"unknown shell {shell!r}")


def complete_main(parser, name, argv, environ, out):
    """The `<NAME>_COMPLETE` entry point: with no argv print the script; with `--` and
    words print candidates. Returns an exit code, or None when completion is not asked for."""
    var = name.upper().replace("-", "_") + "_COMPLETE"
    shell = environ.get(var)
    if not shell:
        return None
    if not argv:
        out.write(completion_script(name, shell))
        return 0
    if argv[0] == "--":
        words = argv[1:]
        index = int(environ.get(var + "_INDEX", len(words) - 1))
        for value, description in argparse_candidates(parser, words, index):
            out.write(f"{value}\t{description}\n")
        return 0
    return None


def diff(live, table):
    """Human-readable lines for rows only the parser has and rows only the table has."""
    out = []
    for row in sorted(live - table, key=repr):
        out.append(f"parser only: {row}")
    for row in sorted(table - live, key=repr):
        out.append(f"table only:  {row}")
    return out


def main(argv):
    if len(argv) >= 2 and argv[0] == "rows":
        table = argv[2] if len(argv) > 2 else str(pathlib.Path(__file__).with_name("cli.toml"))
        for row in sorted(table_rows(table, argv[1]), key=repr):
            print(json.dumps(row))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
