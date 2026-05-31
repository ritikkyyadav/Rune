# Alan

**Alan** is a local-first, agentic coding assistant built by [Savoir Studio](https://savoirstudio.com). It runs entirely on your machine, understands your codebase through tree-sitter AST indexing, and executes multi-step development tasks through a Planner-Executor architecture — without requiring a cloud service or account beyond your own API keys.

```
  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐
  │ Desktop UI   │  │ CLI (alan)   │  │ MCP server wrapper│
  └──────┬───────┘  └──────┬───────┘  └─────────┬─────────┘
         └─────────────────┴────────────────────┘
                            │  JSON-RPC / Unix socket
         ┌──────────────────▼──────────────────────────────┐
         │                ALAN ENGINE                      │
         │  Agent Loop · Context Engine · Session Store    │
         │  LLM Gateway · Tool Registry · Permission Broker│
         └─────────────────────────────────────────────────┘
```

---

## Features

- **Planner-Executor split** — a slow planner model creates a structured plan; a fast executor model runs each step, reducing token waste and death-spirals
- **Append-only session log** — every conversation is a replay-able, fork-able event stream stored in SQLite
- **Three-tier context engine** — sliding window + compressed session memory + AST-indexed long-term store
- **Multi-provider LLM gateway** — Anthropic, OpenAI, OpenRouter, and Ollama, with retry, backoff, and cost tracking
- **Granular permissions** — every tool call is `auto`, `confirm`, or `sandbox` scoped; `--yolo` disables prompts
- **Multi-surface** — same engine powers the CLI, the Tauri desktop app, and an MCP wrapper

---

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.85+ | install via [rustup](https://rustup.rs) |
| Bun | 1.3+ | install via `curl -fsSL https://bun.sh/install \| bash` |
| Turbo | included | installed as a dev dependency |

At least one LLM provider API key is required (see [Configuration](#configuration)).

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/ritikkyyadav/Alan.git
cd Alan

# 2. Build the Rust binaries
cargo build --release

# 3. Install TypeScript dependencies
bun install

# 4. Build TypeScript packages
bun run build

# 5. Add your API key
mkdir -p ~/.alan
echo 'OPENROUTER_API_KEY=sk-or-...' >> ~/.alan/.env

# 6. Run from any project directory
bin/alan --help
```

To make `alan` available globally:

```bash
ln -s "$(pwd)/bin/alan" /usr/local/bin/alan
```

---

## Usage

```bash
# Start an interactive session in the current directory
alan

# Start with a specific model
alan --model claude-sonnet-4-20250514 --provider anthropic

# Enable planner mode (two-tier Planner + Executor)
alan --planner --planner-model claude-opus-4-8 --executor-model claude-haiku-4-5-20251001

# Skip permission prompts (trust all tools)
alan --yolo

# Resume a previous session
alan --resume <session-id>

# List all sessions
alan list
```

### In-session commands

| Command | Description |
|---------|-------------|
| `/cost` | Show total LLM spend for this session |
| `/exit` or `/quit` | Exit cleanly |
| `[a]` at permission prompt | Allow tool call once |
| `[s]` at permission prompt | Allow tool for the rest of the session |
| `[d]` at permission prompt | Deny (default) |

---

## Configuration

Alan merges config from three layers, lowest to highest priority:

1. Built-in defaults
2. `~/.alan/config.toml` (user-global)
3. `<workspace>/.alan/config.toml` (per-project)

Environment variables in `~/.alan/.env` override everything.

### `~/.alan/config.toml`

```toml
[llm]
defaultProvider = "anthropic"   # anthropic | openai | openrouter | ollama

[llm.anthropic]
apiKey = "sk-ant-..."           # or set ANTHROPIC_API_KEY in .env
model = "claude-sonnet-4-20250514"
maxTokens = 8192

[llm.openrouter]
apiKey = "sk-or-..."            # or set OPENROUTER_API_KEY in .env
model = "anthropic/claude-sonnet-4"

[llm.ollama]
baseUrl = "http://localhost:11434"
model = "llama3.2"

# Optional: separate models for planner and executor
[llm.planner]
provider = "anthropic"
model = "claude-opus-4-8"

[llm.executor]
provider = "anthropic"
model = "claude-haiku-4-5-20251001"

[permissions]
defaultLevel = "confirm"        # auto | confirm | sandbox

[[permissions.rules]]
tool = "read_file"
level = "auto"
scope = "global"

[[permissions.rules]]
tool = "bash"
level = "confirm"
scope = "session"
pattern = "^rm "                # only prompt for dangerous rm commands

[engine]
maxSessions = 50                # sessions kept in the DB before pruning

[telemetry]
enabled = false
```

### `~/.alan/.env`

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

---

## Project structure

```
Alan/
├── bin/alan                    # Shell launcher (entry point)
├── crates/
│   ├── alan-core/             # IPC server/client, session manager, protocol
│   ├── alan-cli/              # Rust CLI wrapper
│   ├── alan-tools/            # Tool executors (bash, file ops, symbol search)
│   ├── alan-index/            # AST indexing via tree-sitter
│   └── alan-sandbox/          # Sandboxing & capability isolation (WIP)
├── packages/
│   ├── shared/                # Config, session types, protocol definitions
│   ├── orchestrator/          # Agent loop, planner, plan-runner, context engine
│   ├── llm-gateway/           # Multi-provider LLM abstraction
│   └── tool-registry/         # Tool definitions and MCP integration
├── apps/
│   └── desktop/               # Tauri + React desktop UI
├── tests/
│   └── eval/                  # Integration test harness with mock providers
└── Alan-Blueprints.md         # Full architecture and design document
```

---

## Development

```bash
# Run all Rust tests
cargo test --all

# Run TypeScript typecheck
bun run typecheck

# Run linters
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
bun run lint

# Run the integration eval harness
bun run eval

# Build everything
bun run build && cargo build --release
```

### Adding a tool

1. Define the tool schema in `packages/tool-registry/src/`
2. Implement the executor in `crates/alan-tools/src/`
3. Register it in `packages/tool-registry/src/registry.ts`

### Supported LLM providers

| Provider | Env var | Notes |
|----------|---------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | Recommended for best results |
| OpenAI | `OPENAI_API_KEY` | |
| OpenRouter | `OPENROUTER_API_KEY` | Access to all providers via one key |
| Ollama | _(none)_ | Local inference; set `llm.ollama.baseUrl` |

---

## Architecture

See [Alan-Blueprints.md](./Alan-Blueprints.md) for the full design document, and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for a concise implementation-level overview.

---

## Status

Alan is pre-release (`v0.1.0`). Core infrastructure is stable; the sandboxing layer is work-in-progress. Expect breaking changes before `v1.0`.

---

## License

Proprietary — © Savoir Studio. All rights reserved.
