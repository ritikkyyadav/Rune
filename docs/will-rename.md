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

| Identifier                                                                | Compatibility reason                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `~/.rune`, workspace `.rune`, `rune.db`, `RUNE.md`                        | Existing sessions, configuration, instructions, and memory stay in place.                                |
| `RUNE_*` environment variables                                            | Existing launchers, automation, and isolated profiles keep working.                                      |
| Keychain service/account names                                            | Existing credentials and memory signatures remain readable. Only the displayed memory key label changes. |
| `@rune/*`, exported `Rune*` types, Rust crate names                       | Package imports, SDK clients, and build tooling remain compatible.                                       |
| Protocol identifiers, theme IDs, generated-file markers, commit prefixes  | Existing clients, saved themes, undo, and learned files remain readable.                                 |
| GitHub repository URLs, release asset filenames, hosted installation URLs | Existing update and download locations remain valid.                                                     |

No automatic data-directory migration is needed for this rename. Historic
release notes and captured evidence retain the name of the version they describe.
Renaming an externally hosted repository, domain, or registry package is separate
from this source change.

The public name and command constants live in `packages/shared/src/brand.ts`;
the terminal's version and label are composed in `packages/orchestrator/src/bin/ui/brand.ts`.
