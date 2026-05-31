# Contributing to Alan

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | 1.85+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Bun | 1.3+ | `curl -fsSL https://bun.sh/install \| bash` |
| Git | any | |

You will also need at least one LLM provider API key. OpenRouter is the easiest starting point since it gives access to many models under one key.

## Setting up

```bash
git clone https://github.com/ritikkyyadav/Alan.git
cd Alan

# Install TypeScript dependencies
bun install

# Build TypeScript packages (required for type resolution across packages)
bun run build

# Build Rust binaries
cargo build

# Set up your API key
mkdir -p ~/.alan
echo 'OPENROUTER_API_KEY=your-key-here' >> ~/.alan/.env
```

## Repository layout

```
crates/         Rust crates (cargo workspace)
  alan-core/    IPC protocol, session manager, daemon binary
  alan-tools/   Tool executors called by the agent
  alan-index/   AST indexing (tree-sitter)
  alan-cli/     Thin Rust CLI wrapper
  alan-sandbox/ Capability isolation (WIP)

packages/       TypeScript packages (bun workspace)
  shared/       Cross-package types: config, session, protocol
  orchestrator/ Agent loop, planner, context engine — the brain
  llm-gateway/  Provider abstraction: Anthropic, OpenAI, OpenRouter, Ollama
  tool-registry/Tool schemas and the MCP integration layer

apps/desktop/   Tauri + React desktop UI
tests/eval/     Integration test harness (mock LLM provider)
bin/alan        Shell launcher script
```

## Making changes

### Rust changes

```bash
# Check for type errors fast (no codegen)
cargo check --all

# Run lints (CI enforces zero warnings)
cargo clippy --all-targets -- -D warnings

# Run tests
cargo test --all

# Format
cargo fmt --all
```

### TypeScript changes

```bash
# Type check all packages
bun run typecheck

# Lint / format check
bun run lint

# Run the eval harness (integration tests with a mock LLM)
bun run eval
```

### Testing your changes end-to-end

```bash
cargo build --release
bun run build
bin/alan  # runs from the current directory as workspace
```

## Commit style

Use the imperative mood, present tense:

```
fix session rollback when checkpoint seq is zero
add bash tool timeout support
refactor context engine to use tiered scoring
```

For larger changes, include a body explaining the *why*:

```
fix: propagate JSON parse errors in get_events instead of panicking

serde_json::from_str(&payload).unwrap() would crash the daemon if a
stored event had been written by a newer schema version. Map the error
to rusqlite::Error so callers can handle it gracefully.
```

## Branching

- `main` — stable, CI must pass
- `claude/*` — automated branches, do not merge manually
- Feature branches: `your-name/short-description`

## Pull request checklist

- [ ] `cargo fmt --all` passes
- [ ] `cargo clippy --all-targets -- -D warnings` passes with no new warnings
- [ ] `cargo test --all` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] New public Rust APIs have `///` doc comments
- [ ] New public TypeScript APIs have JSDoc comments
- [ ] If you changed the SQLite schema, bump `SCHEMA_VERSION` in `session.rs`

## Where to start

Good first areas:

- **Tests** — the agent loop, planner, and context engine have no unit tests; any coverage here is valuable
- **Tool executors** — `crates/alan-tools/src/` — adding new tools is self-contained
- **Provider support** — adding Gemini or other providers follows the `LlmProvider` interface in `packages/llm-gateway/src/types.ts`
- **Bug fixes** — check open issues; anything labelled `good first issue` is scoped to a single file

## Questions

Open a GitHub discussion or reach out at ritik@savoirstudio.com.
