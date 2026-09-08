# The command sandbox

Every `bash` call Rune makes runs, by default, inside an OS sandbox: Seatbelt (`sandbox-exec`) on
macOS, bubblewrap on Linux. The sandbox is kernel-enforced and it is the reason 3rd gear and Auto
mode can approve a shell command without asking anyone — the walls, not a person, bound what the
command can do.

`/sandbox` used to be one switch, on or off. It is now a policy with three parts, the same three a
person expects to find:

| Tab           | Choices                                         | What it decides                                                                  |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| **Mode**      | `auto-allow` (default) · `regular` · `off`      | Whether commands are contained, and whether containment vouches for them         |
| **Overrides** | allow unsandboxed fallback (default) · strict   | Whether a command that hit a sandbox wall may retry on the host                  |
| **Config**    | excluded commands · filesystem read/write rules | Which commands never run sandboxed, and which paths the profile denies or grants |

Type `/sandbox` in the terminal to open the menu, or use the text forms below. Everything here is
also a config key, so it can be checked in with a project.

## Mode

- **`auto-allow`** — commands run in the sandbox: no network unless a call sets `network: true`,
  writes confined to the workspace, temp and Rune's cache, credential stores unreadable. Because
  the sandbox is the boundary, 3rd gear and Auto approve sandboxed commands without a prompt.
  Explicit ask/deny rules are always respected.
- **`regular`** — the same containment, but the gear's ordinary permission prompt still applies to
  each command. Walls without vouching, for people who want to see every command and still want
  it contained.
- **`off`** — no sandbox. Commands run on the host with full network and filesystem access. 4th
  gear never prompts; the other gears prompt for every command; Auto runs read-only commands and
  reviews everything else (see [Auto mode and the shell](#auto-mode-and-the-shell)).

```text
/sandbox mode regular       # also: /sandbox on (= auto-allow) · /sandbox off
```

Shifting into Auto turns the sandbox on if it was off; it does not change a `regular` choice.

## Overrides

- **Allow unsandboxed fallback** (default) — when a sandboxed command fails on a permission error,
  its result carries a `sandbox_hint` naming the wall it probably hit. The agent may then retry
  the command **once** with `unsandboxed: true`. That retry runs on the host and goes through the
  regular permission prompt (Auto reviews it); it is never auto-approved.
- **Strict sandbox mode** — `unsandboxed: true` is refused. Every command runs sandboxed unless it
  is listed in `excludedCommands`, and the agent is told to report which host access it needed
  rather than route around the wall.

```text
/sandbox override strict    # or: /sandbox override fallback
```

## Config

### Excluded commands

Command patterns that always run **outside** the sandbox — an Android toolchain that needs the
host's device sockets, a container CLI that talks to a daemon:

```toml
[sandbox]
excludedCommands = ["adb *", "emulator *", "docker"]
```

A pattern with `*` globs the whole command segment (`adb *` covers `adb shell ls`, not a bare
`adb`); a bare name is a command prefix (`docker` covers `docker ps` and `docker`, not `dockerd`).
Any matching segment takes the whole command out of the sandbox — a command that is half on the
host is on the host. An excluded command loses the sandbox's auto-allow along with its walls, so
the gear's ordinary permission decision applies to it, and Auto reviews it as an uncontained
command.

```text
/sandbox exclude adb *      # written to [sandbox] excludedCommands in ~/.rune/config.toml
/sandbox unexclude adb *
```

### Filesystem

```toml
[sandbox.filesystem]
denyRead = ["~/Private"]           # on top of the built-in credential stores
allowWrite = ["~/.gradle"]         # extra writable roots
denyWrite = ["dist/generated"]     # denied even inside the workspace
```

What the profile enforces, and `/sandbox config` prints:

- **Reads** are broad (a compiler has to see the system) minus the credential stores: `~/.ssh`,
  `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.npmrc`,
  `~/.netrc`, the shell histories and Rune's own `secrets.json` — plus `denyRead`.
- **Writes** are allowed under the workspace, `~/.rune/cache`, `/tmp`, `/private/tmp`,
  `/private/var/folders` and `$TMPDIR` — plus `allowWrite`.
- **Denied within allowed**, in every gear: Rune's own control surface inside the workspace
  (`.rune/config.toml`, `hooks.json`, `mcp.json`, `sandbox.json`, `policy.json`, `org.pub`, and the
  `hooks/`, `skills/`, `plugins/`, `commands/` directories; the legacy `.gear/` and `.alan/`
  spellings too) and `.git/hooks` — a git hook is persistence, it runs on the next commit long
  after the session ends — plus `denyWrite`.
- **Network** is denied unless a call sets `network: true`; loopback stays open so a dev server on
  `127.0.0.1` and a `curl` against it work. `network: true` never permits writes outside the
  workspace.

Paths are resolved against the workspace (relative) or the home directory (`~`, `$HOME`) before
they cross into the Rust profile, which matches resolved paths only. On macOS the deny lists are
Seatbelt rules; on Linux a denied write becomes a read-only bind over itself and a denied read an
empty tmpfs. The lists reach `rune-tools` beside each command as `sandbox_paths`, and the harness
always overwrites that field from trusted config — a model cannot widen its own sandbox by writing
it into the tool arguments.

## Where the choices live

| Choice                        | Saved to                                                                       | Precedence at launch                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Mode                          | `~/.rune/sandbox.json` (`/sandbox`), or `[sandbox] mode` (`/config sandbox …`) | `--sandbox`/`--no-sandbox` > `RUNE_SANDBOX_MODE` / `RUNE_SANDBOX_ENABLED` > sidecar > config > `auto-allow` |
| Override                      | `~/.rune/sandbox.json`, or `[sandbox] allowUnsandboxedFallback`                | sidecar > config > allow                                                                                    |
| Excluded commands, filesystem | `[sandbox]` / `[sandbox.filesystem]` in config.toml                            | config only                                                                                                 |

`/config sandbox <auto-allow|regular|off>` and `/config sandbox_fallback <on|off>` write config.toml
and forget the matching sidecar choice so the two cannot disagree. The legacy `[sandbox] enabled`
boolean still reads (`false` = off); `mode` wins when both are present.

## Auto mode and the shell

Auto mode's supervised tier — ordinary work runs immediately and a watcher reads it out of band —
is safe **because** the sandbox is underneath it. Two things follow from making the sandbox a
policy:

1. **A read-only command takes the safe tier.** `ls`, `cat`, `grep`, `git status`, `cargo tree`,
   `docker ps`, `adb devices`, pipelines of those, `--version`/`--help` of anything — every
   segment a known read-only program, no redirection, no substitution, no elevation — runs with
   no reviewer call and no supervisor screen, whatever the sandbox state. A read-only _shape_ is
   not enough on its own: `cat .env` and `cat ~/.ssh/id_rsa` keep the classifier tier, and once
   injected content is suspected in a run, reads stop being free. Extend the set for your own
   tools with `[permissions.autoMode] safeCommands = ["adb shell getprop *"]`.
2. **A command with no sandbox under it follows `unsandboxedShell`.** When the sandbox is off, the
   command is excluded, or it is a fallback retry, the boundary is gone and something has to stand
   in for it:
   - `review` (default) — one in-path reasoned reviewer call, the same review a high-risk action
     gets. When the sandbox is not the boundary, the reviewer is. A reviewer outage on such a
     command becomes a question, not a deferral — for an _ordinary_ command. The mechanical
     router still answers for the shapes it recognizes, with or without a sandbox and whatever
     `unsandboxedShell` says: an exfiltration halts the run, a publish comes back as its dry run,
     a persistence step is deferred. An attack shape is never put to you as a yes/no card.
   - `ask` — the modal prompt, for every command that is not read-only.
   - `allow` — the mechanical breakers alone, as in 4th gear.

   Before this, the engine turned **every** allowed bash into a high-risk "explicit approval
   required" prompt the moment the sandbox was off — `ls` included — which is what made "sandbox
   off + Auto" a mode nobody could work in.

The supervisor's scope is a setting too: `[permissions.autoMode] supervisor = "unusual"` (default)
skips recognized ordinary development work — builds, tests, installs, linters, local git,
containers — which the mechanical breakers have already read; `"all"` screens everything the
supervised tier runs; `"off"` disables the background supervisor. On a rate-capped reviewer the
supervisor used to compete with the acting agent for the same quota on every `npm audit`, and
nearly a third of its flags did not survive the reasoned pass. See
[`auto-mode.md`](auto-mode.md#user-configuration) for the keys and their live forms.

## When the sandbox cannot isolate

A machine with no backend (Windows, a mac without `sandbox-exec`) runs commands with path-guard
checks only. `/status` says `NOT ISOLATED`, the model is told, bash loses auto-approval, and Auto
treats every command as uncontained. `[sandbox] requireOs = true` refuses sandbox-tier commands
outright instead. See [`threat-model.md`](threat-model.md#os-sandbox-matrix).
