# Getting started

Rune is a coding agent that runs in your terminal. It stores sessions locally and works with
hosted providers or local models through Ollama.

## Installation

### macOS and Linux

```sh
curl -fsSL https://savoir.services/install.sh | bash
```

### Windows

Run in PowerShell:

```powershell
irm https://savoir.services/install.ps1 | iex
```

Windows is an x64 preview and currently has no OS sandbox.

The installers download the latest public GitHub release and verify each asset against
`SHA256SUMS` before installation. The Savoir URLs redirect to this repository's installers.
You can also use the repository URLs directly:

```sh
curl -fsSL https://raw.githubusercontent.com/ritikkyyadav/Rune/main/scripts/web-install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/ritikkyyadav/Rune/main/scripts/install.ps1 | iex
```

### From source

Install [Bun](https://bun.sh) and [Rust](https://rustup.rs), then run:

```sh
gh repo clone ritikkyyadav/Rune
cd Rune
bash scripts/install.sh
export PATH="$HOME/.rune/bin:$PATH"
rune
```

Add the PATH line to `~/.zshrc` or `~/.bashrc` if required. The source installer compiles Rune
and its native tools into `~/.rune/bin`. It runs `rune serve --check` before promoting the
staged build.

To run directly from the checkout:

```sh
bun install
cargo build --release -p rune-tools
./bin/rune
```

### Check, update, or uninstall

```sh
rune --version
rune doctor
rune tools-smoke
rune upgrade
```

To uninstall, pass `--uninstall` to the POSIX installer or `-Uninstall` to the PowerShell
installer. See [release and installation reference](release.md) for custom install locations,
PATH behavior, signature verification, and Homebrew.

## First session

Open a project and run `rune`. Setup walks you through choosing a provider and model.
Describe the change you want, then review the edits and checks in the session.

| Command    | Purpose                          |
| ---------- | -------------------------------- |
| `/login`   | Connect a provider               |
| `/model`   | Select a model                   |
| `/theme`   | Choose appearance and finish     |
| `/config`  | Inspect and change configuration |
| `/sandbox` | Configure OS sandbox policy      |
| `/rewind`  | Restore a checkpoint             |
| `/help`    | Browse available commands        |

Shift+Tab cycles permission levels. Permission approvals and OS sandbox policy are separate
controls; see [permissions](auto-mode.md) and [sandbox behavior](sandbox.md).

## White terminal and matte appearance

To match the README screenshots:

```sh
RUNE_THEME=rune-light RUNE_FINISH=matte rune
```

Or choose Light and Matte in `/theme`. Rune saves both choices. You can set defaults in
`~/.rune/config.toml` or the workspace's `.rune/config.toml`:

```toml
[ui]
theme = "rune-light"
finish = "matte"
```

An environment override takes precedence over the saved choice, which takes precedence over
configuration defaults.

## Providers and local models

Use `/login` for hosted providers. For a local Ollama server, after downloading a model:

```sh
rune -p ollama -m llama3
```

Hosted credentials can also be supplied through provider environment variables such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `GOOGLE_API_KEY`.
Availability, pricing, and quotas depend on the provider and model.
See the [provider reference](providers.md) for supported routes and setup.

## Sessions and automation

```sh
rune --list
rune --resume <session-id>
rune -P "Explain how this project is structured"
```

Use `--stream-json` for structured headless output. See [CI](ci.md) and
[remote sessions and ACP](protocol.md) for integration examples.

`RUNE_HOME` selects an alternate profile and session directory. Telemetry is off by default;
see [Privacy](../PRIVACY.md).
