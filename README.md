# Berne

> A local-first, sandboxed, multi-provider agentic coding assistant — a headless engine with CLI and desktop surfaces.

**Status:** early, active development. The engine, CLI, tool suite, and evals work end-to-end; interfaces are still evolving and not all blueprint features are built yet. Current release: **Berne v0.1**.

> _Berne is the product name. **Alan** is the internal codename you'll still see in package names (`@alan/*`), the `~/.alan` data directory, and the `alan-tools` binary — none of it user-facing._

## What is Berne?

Berne is an agentic coding assistant built around a reusable **engine** (TypeScript) that runs the
agent loop, manages context, enforces permissions and sandboxing, and executes tools. The engine is
the product — the CLI is one client, a Tauri desktop app is another, and an MCP-server wrapper is
planned. It is multi-provider (including a fully local path via Ollama) and built to be auditable for
compliance-sensitive teams.

## Features

- **Multi-provider gateway** — Anthropic, OpenAI, OpenRouter, Google, and local **Ollama**, with
  automatic provider fallback, retry, and backoff.
- **Tool suite** — `read_file`, `write_file`, `edit_file`, `multi_edit`, `glob`, `grep`, `list_dir`,
  `bash`, `symbol_search`, `ast_query`, `web_fetch`, `web_search`, `todo_write`, `n8n_trigger`, and a
  `task` sub-agent for parallel **read-only** investigations.
- **Reliable editing** — hash-guarded, atomic edits with 3-tier matching (exact →
  whitespace-insensitive → indentation-insensitive) in both the TypeScript and Rust editors, so edits
  survive minor whitespace drift instead of corrupting files.
- **Permissions & sandbox** — `auto` / `confirm` / `sandbox` tool tiers, an egress + output-redaction
  security guard, per-tool rate limiting, and a `--yolo` mode for trusted runs.
- **Hooks** — run shell commands automatically around tool use and session lifecycle via
  `.alan/hooks.json` (e.g. format/lint after edits, block protected paths).
- **MCP** — project-scoped tool discovery via `.alan/mcp.json`.
- **Research mode (`/research`, `/deepresearch`)** — ChatGPT/Claude-style Deep Research: the agent
  proposes a decomposed research plan (asking a couple of clarifying questions first when the request
  is vague), **you approve, revise, or cancel**, then it runs an **iterative** loop — bounded parallel
  investigators search the web (and, only when the question is about your project, your local repo),
  a supervisor reflects on the findings to spot gaps and spins up follow-up questions, and a
  synthesizer writes a **cited** markdown report. `/research` is the standard preset; `/deepresearch`
  runs more rounds, sources, and a longer report. Sources are captured from the investigators' tool
  calls (not hallucinated), and the report streams to the terminal, saves under `.alan/research/`, and
  stays in the session for follow-ups. Set a **Tavily/Brave** key via `/keys` for higher-quality
  search; keyless DuckDuckGo is the fallback.
- **Skills** — 181 bundled expert playbooks (code review, debugging, architecture, data analysis,
  PDF handling, and more) surfaced by progressive disclosure: a compact catalog rides in the system
  prompt and the model loads a skill's full instructions on demand via the `skill` tool. Browse with
  `/skills`; add your own under `.alan/skills/`. See [`skills/`](skills/README.md).
- **Custom slash commands** — drop `.alan/commands/*.md` files to add your own `/commands`.
- **Sessions, checkpoints & rewind** — SQLite-backed session history, automatic checkpoints, and
  `/rewind` to roll the conversation back to an earlier turn.
- **Auditable export** — export a session transcript (`md`/`json`) with an optional **Ed25519
  signature** for tamper-evident records.
- **Opt-in diagnostics** — a local Black Box flight recorder (`berne doctor`) captures every
  failure/degradation with redaction and fingerprinting; an **off-by-default, transparent**
  channel (`berne telemetry`) can forward redacted crash reports + an anonymous usage heartbeat
  to a collector you run. `berne telemetry preview` shows the exact bytes; no IPs or device ids.
- **Context engine** — token-budgeted prompt construction with compaction.

## Architecture

Bun workspaces + Turbo monorepo:

```
packages/
  orchestrator/   Engine: agent loop, planner-executor, context engine, permissions,
                  memory, hooks, sub-agent, session export — plus the CLI (bin/alan-cli.ts)
  llm-gateway/    Provider adapters + gateway (retry / fallback / cost tracking)
  tool-registry/  Tool schemas, registry, built-in tools, MCP client, skills loader
  shared/         Sessions, checkpoints, config, protocol
  telemetry/      Telemetry
skills/           Bundled skills catalog (21 plugins, 181 SKILL.md playbooks)
crates/
  alan-tools/     Fast Rust tool binary (read/grep/edit/bash/symbol_search/...)
  alan-index/     Code symbol index
  alan-sandbox/   Sandbox primitives
apps/
  desktop/        Tauri + React desktop client
```

The engine ⇆ client separation is intentional: the same engine powers the CLI, the desktop app, and
(planned) an MCP-server wrapper.

## Install

**End users — one line, no toolchain** (downloads a prebuilt standalone binary
for your OS into `~/.alan/bin`):

```bash
curl -fsSL https://YOUR-DOMAIN/install.sh | bash
```

That script is [`scripts/web-install.sh`](scripts/web-install.sh); host it (or the
raw GitHub URL) and paste the one-liner on your site. Publish the binaries it
pulls with [`scripts/build-release.sh`](scripts/build-release.sh), which compiles
`berne-<os>-<arch>` for macOS/Linux via `bun build --compile`.

**From source** — the installer compiles a standalone CLI + the Rust tools binary
into `~/.alan/bin` and exposes them as the **`berne`** command:

```bash
./scripts/install.sh
```

Then add `~/.alan/bin` to your PATH and just type `berne`:

```bash
export PATH="$HOME/.alan/bin:$PATH"    # add to ~/.zshrc or ~/.bashrc, then reload
berne
```

Or run straight from the source tree without installing:

```bash
bun install
cargo build --release -p alan-tools    # optional native tools; the CLI also works without it
./bin/berne
```

## Quickstart

Berne defaults to a **free model (Gemini 2.5 Flash)**. Grab a free
[Google AI Studio key](https://aistudio.google.com/apikey), then:

```bash
export GOOGLE_API_KEY=...     # free tier — or put it in .env (Bun auto-loads it)
berne                         # or, from the source tree: ./bin/berne
```

Other **free** options:

```bash
export OPENROUTER_API_KEY=...                                   # free models on OpenRouter
berne -p openrouter -m deepseek/deepseek-v4-flash:free

export OLLAMA_HOST=http://localhost:11434                       # fully local / offline
berne -p ollama -m llama3
```

Paid top-tier (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) is **optional** — only needed
for a later production-grade validation pass. See `.env.example`.

Common flags: `-m/--model`, `-p/--provider`, `-w/--workspace <dir>`, `--yolo`, `--planner`,
`-r/--resume <sessionId>`, `-l/--list`.

## Configuration

**Environment:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`,
`OLLAMA_HOST`, `N8N_BASE_URL`, and `TAVILY_API_KEY` / `BRAVE_API_KEY` for web search (used by
`/research`; you can also save these via `/keys`).

**Research defaults** live under `[research]` in `.alan/config.toml`: `depth` (`quick`/`standard`/`deep`),
`maxSubQuestions`, `maxParallel`, `maxSourcesPerStep`, `autoApprove`, `save`, and `outputDir`. Env
overrides: `ALAN_RESEARCH_DEPTH`, `ALAN_RESEARCH_MAX_PARALLEL`, `ALAN_RESEARCH_MAX_SUBQUESTIONS`,
`ALAN_RESEARCH_AUTO_APPROVE`, `ALAN_RESEARCH_SAVE`.

**Project files (under `.alan/` in your workspace):**

- `hooks.json` — pre/post tool-use and session lifecycle hooks.
- `mcp.json` — project-scoped MCP servers.
- `commands/*.md` — custom slash commands. The filename is the command name; the body is the prompt
  template, with `$ARGUMENTS` (or `{{args}}`) replaced by whatever you type after the command.
  Optional `--- description: ... ---` frontmatter.

## Slash commands

`/model`, `/effort`, `/status`, `/providers`, `/keys`, `/mcp`, `/skills`, `/research`,
`/deepresearch`, `/cost`, `/compress`, `/plan`, `/rewind`, `/help`, `/quit` — plus any custom
commands you define in `.alan/commands/`.
`/skills` lists the bundled skill catalog; `/skills <keywords>` searches it.
`/research <question>` runs research: it proposes a plan, waits for your approval (Enter to run,
`r` to revise, `n` to cancel), then iteratively fans out and writes a cited report. `/deepresearch
<question>` is the same flow at the heaviest preset (more rounds, sources, and a longer report).
`/keys set tavily <key>` (or `brave`) enables a higher-quality search backend.

## Evals

```bash
bun run tests/eval/runner.ts                 # mock provider — deterministic, offline (plumbing only)
ANTHROPIC_API_KEY=sk-... \
  bun run tests/eval/runner.ts --real --max 3   # drive a live model for a real success rate
```

`--real` honors `ALAN_EVAL_PROVIDER` / `ALAN_EVAL_MODEL`, and supports `--tasks <category|name>` and
`--max <n>` for cheap smoke runs.

## Development

```bash
bun install
bun test tests/unit/      # unit tests
bun run typecheck         # tsc across all packages
cargo test -p alan-tools  # Rust tool tests
```

## Privacy & telemetry

Berne is local-first: **telemetry is off by default and transmits nothing unless
you opt in.** When enabled (a configured collector endpoint **and** an explicit
`yes` to the first-run prompt), it sends two minimal, redacted streams — crash /
error reports drawn from the local Black Box, and an anonymous daily usage
heartbeat — to a collector **you** run. It never sends file contents, prompts,
your IP address, or any device fingerprint.

- Inspect the exact bytes: `berne telemetry preview`
- Opt in / out any time: `berne telemetry on` / `berne telemetry off`
- Receive it yourself: run [`collector/berne-collector.ts`](collector/README.md)
  (a single dependency-free Bun server + live dashboard that stores reports to a
  local SQLite and never persists raw IPs).

Full details in [`PRIVACY.md`](PRIVACY.md).

## License

TBD.
