# Will: name and compatibility

Will is the public name of the coding agent previously called Rune. This change
updates interface copy, terminal titles, help, sign-in pages, dashboard labels,
agent identity, and installation guidance. The theme, glyph, layout, commands,
permissions, providers, and session behavior are unchanged.

Launch it with `will`. The `rune` command remains available and reaches the same
implementation. POSIX installations use a relative symlink; Windows uses a
`will.cmd` launcher that forwards arguments and the exit status to `rune.exe`.
Upgrades and rollbacks replace that one underlying executable.

The following identifiers intentionally remain stable:

| Identifier                                                               | Compatibility reason                                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `~/.rune`, workspace `.rune`, `rune.db`, `RUNE.md`                       | Existing sessions, configuration, instructions, and memory stay in place.                                |
| `RUNE_*` environment variables                                           | Existing launchers, automation, and isolated profiles keep working.                                      |
| Keychain service/account names                                           | Existing credentials and memory signatures remain readable. Only the displayed memory key label changes. |
| `@rune/*`, exported `Rune*` types, Rust crate names                      | Package imports, SDK clients, and build tooling remain compatible.                                       |
| Protocol identifiers, theme IDs, generated-file markers, commit prefixes | Existing clients, saved themes, undo, and learned files remain readable.                                 |
| Release asset filenames and hosted installation URLs                     | Existing update and download locations remain compatible.                                                |

No automatic data-directory migration is needed for this rename. Historic
release notes and captured evidence retain the name of the version they describe.

The canonical GitHub repository is `ritikkyyadav/Will`. Update an existing clone
with `git remote set-url origin https://github.com/ritikkyyadav/Will.git`.
The previous repository URL redirects to the new name, while the current
installers, updater, and plugin catalog use the new URL directly. Domains and
registry package names are unchanged.

GitHub does not redirect action references. Any workflow that uses
`ritikkyyadav/Rune/action@...` must use `ritikkyyadav/Will/action@...` instead.
See [GitHub's repository rename guidance](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).

The existing v1.4.17 release predates this rename. Build from `main` to use Will
until a subsequent release includes these changes.

The public name and command constants live in `packages/shared/src/brand.ts`;
the terminal's version and label are composed in `packages/orchestrator/src/bin/ui/brand.ts`.
