# Gear

> A local-first, sandboxed, multi-provider agentic coding assistant — a headless engine with CLI and desktop surfaces.

**Status:** early, active development. The engine, CLI, tool suite, and evals work end-to-end; interfaces are still evolving and not all blueprint features are built yet. Current release: **Gear v0.3.0**.

> _Gear is the sole public product identity. Older internal identifiers remain only as migration-compatible package, data, and launcher aliases._

## What is Gear?

Gear is an agentic coding assistant built around a reusable **engine** (TypeScript) that runs the
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
- **Classifier-backed Auto mode** — safe reads and reversible workspace edits stay fast; shell,
  network, protected/external writes (including CI workflows), and delegation are reviewed by an
  isolated two-stage action classifier. Blocked actions resolve conversationally: the agent asks you
  a plain-language question and your typed answer authorizes the retry — modal prompts remain only
  as the backstop. Failed reviewer calls retry against a same-boundary fallback before failing
  closed, tool results cross a prompt-injection probe before model context (flagged sessions get
  heightened review), and decisions enter the tamper-evident audit trail. See
  [`docs/auto-mode.md`](docs/auto-mode.md).
- **Permissions & sandbox** — signed organization policy, mechanical deny/ask/allow rules, egress +
  output redaction, per-tool rate limiting, OS sandboxing, and the five-gear permission ladder.
  In the CLI, Shift+Tab shifts up: 1st gear (every action asks) → 2nd (workspace edits proceed) →
  3rd (adds sandboxed commands and confined delegation) → 4th (full autonomy) → Auto
  (classifier-reviewed), then wraps. The OS sandbox is a separate `/sandbox` switch — no gear
  changes it.
- **Hooks** — run shell commands automatically around tool use and session lifecycle via
  `.gear/hooks.json` (e.g. format/lint after edits, block protected paths).
- **MCP** — project-scoped tool discovery via `.gear/mcp.json`.
- **Research mode (`/research`, `/deepresearch`)** — ChatGPT/Claude-style Deep Research: the agent
  proposes a decomposed research plan (asking a couple of clarifying questions first when the request
  is vague), **you approve, revise, or cancel**, then it runs an **iterative** loop — bounded parallel
  investigators search the web (and, only when the question is about your project, your local repo),
  a supervisor reflects on the findings to spot gaps and spins up follow-up questions, and a
  synthesizer writes a **cited** markdown report. `/research` is the standard preset; `/deepresearch`
  runs more rounds, sources, and a longer report. Sources are captured from the investigators' tool
  calls (not hallucinated), and the report streams to the terminal, saves under `.gear/research/`, and
  stays in the session for follow-ups. Set a **Tavily/Brave** key via `/keys` for higher-quality
  search; keyless DuckDuckGo is the fallback.
- **Skills** — 181 bundled expert playbooks (code review, debugging, architecture, data analysis,
  PDF handling, and more) surfaced by progressive disclosure: a compact catalog rides in the system
  prompt and the model loads a skill's full instructions on demand via the `skill` tool. Browse with
  `/skills`; add your own under `.gear/skills/`. See [`skills/`](skills/README.md).
- **Custom slash commands** — drop `.gear/commands/*.md` files to add your own `/commands`.
- **Session loops (`/loop`)** — repeat a prompt while the current terminal session is open. Use a
  fixed cadence (`/loop 5m check the deploy`) or let Gear adapt between one minute and one hour
  (`/loop check CI`). Loops wait for the active turn, resume with the same conversation, inherit its
  permissions, and expire after seven days. See [`docs/loop-mode.md`](docs/loop-mode.md).
- **Sessions, checkpoints & rewind** — SQLite-backed session history, automatic checkpoints, and
  `/rewind` to roll the conversation back to an earlier turn.
- **Auditable export** — export a session transcript (`md`/`json`) with an optional **Ed25519
  signature** for tamper-evident records.
- **Opt-in diagnostics** — a local Black Box flight recorder (`gear doctor`) captures every
  failure/degradation with redaction and fingerprinting; an **off-by-default, transparent**
  channel (`gear telemetry`) can forward redacted crash reports + an anonymous usage heartbeat
  to a collector you run. `gear telemetry preview` shows the exact bytes; no IPs or device ids.
- **Context engine** — token-budgeted prompt construction with compaction.

## Architecture

Bun workspaces + Turbo monorepo:

```
packages/
  orchestrator/   Engine: agent loop, task spine, context engine, permissions,
                  memory, hooks, sub-agent, session export — plus the CLI (bin/gear-cli.ts)
  llm-gateway/    Provider adapters + gateway (retry / fallback / cost tracking)
  tool-registry/  Tool schemas, registry, built-in tools, MCP client, skills loader
  shared/         Sessions, checkpoints, config, protocol
  telemetry/      Telemetry
skills/           Bundled skills catalog (21 plugins, 181 SKILL.md playbooks)
crates/
  gear-tools/     Fast Rust tool binary (read/grep/edit/bash/symbol_search/...)
  gear-index/     Code symbol index
  gear-sandbox/   Sandbox primitives
apps/
  desktop/        Tauri + React desktop client (developer preview — runs from a source checkout)
```

The engine ⇆ client separation is intentional: the same engine powers the CLI, the desktop app, and
(planned) an MCP-server wrapper. The desktop app is a **developer preview**: it launches the engine
from this source checkout (Bun required) and is not part of the release assets yet.

## Install

**End users — one line, no toolchain** (downloads the prebuilt CLI **and** its
native `gear-tools` executor for your OS from the
[latest GitHub release](https://github.com/ritikkyyadav/Alan/releases) into
`~/.gear/bin`; file, search, and shell tools depend on `gear-tools`):

```bash
curl -fsSL https://raw.githubusercontent.com/ritikkyyadav/Alan/main/scripts/web-install.sh | bash
```

While this repo is **private**, anonymous `curl` can't reach it — use the
authenticated equivalent (one-time `gh auth login` with the [GitHub CLI](https://cli.github.com)):

```bash
mkdir -p ~/.gear/bin
os="$(uname -s | tr '[:upper:]' '[:lower:]')" arch="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
gh release download -R ritikkyyadav/Alan -p "gear-$os-$arch" -O ~/.gear/bin/gear --clobber
gh release download -R ritikkyyadav/Alan -p "gear-tools-$os-$arch" -O ~/.gear/bin/gear-tools --clobber
chmod +x ~/.gear/bin/gear ~/.gear/bin/gear-tools
```

The one-liner script is [`scripts/web-install.sh`](scripts/web-install.sh); release
binaries are compiled per-platform by [`scripts/build-release.sh`](scripts/build-release.sh)
via `bun build --compile`.

**From source** — recommended on any machine with the toolchain (needs [Bun](https://bun.sh)
and [Rust](https://rustup.rs)); compiles a standalone CLI **plus** the native Rust tools
binary into `~/.gear/bin` and exposes them as the **`gear`** command:

```bash
gh repo clone ritikkyyadav/Alan && cd Alan     # or: git clone https://github.com/ritikkyyadav/Alan.git
./scripts/install.sh
```

Then add `~/.gear/bin` to your PATH and just type `gear`:

```bash
export PATH="$HOME/.gear/bin:$PATH"    # add to ~/.zshrc or ~/.bashrc, then reload
gear
```

Or run straight from the source tree without installing:

```bash
bun install
cargo build --release -p gear-tools    # required — file, search, and shell tools run through it
./bin/gear
```

## Quickstart

Gear defaults to a **free model (Gemini 2.5 Flash)**. Grab a free
[Google AI Studio key](https://aistudio.google.com/apikey), then:

```bash
export GOOGLE_API_KEY=...     # free tier — or put it in .env (Bun auto-loads it)
gear                          # or, from the source tree: ./bin/gear
```

Other **free** options:

```bash
export OPENROUTER_API_KEY=...                                   # free models on OpenRouter
gear -p openrouter -m deepseek/deepseek-v4-flash:free

export OLLAMA_HOST=http://localhost:11434                       # fully local / offline
gear -p ollama -m llama3
```

Paid top-tier (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) is **optional** — only needed
for a later production-grade validation pass. See `.env.example`.

Common flags: `-m/--model`, `-p/--provider`, `-w/--workspace <dir>`,
`--autonomy <I|II|III>`, `--trust` (Auto), `-r/--resume <sessionId>`, `-l/--list`.

## Configuration

**Environment:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`,
`OLLAMA_HOST`, `N8N_BASE_URL`, and `TAVILY_API_KEY` / `BRAVE_API_KEY` for web search (used by
`/research`; you can also save these via `/keys`).

**Auto review:** set `[permissions] mode = "auto"`, then configure the independent reviewer and
trust boundary under `[permissions.autoMode]`. Deployment overrides are
`GEAR_PERMISSION_MODE`, `GEAR_AUTO_CLASSIFIER_PROVIDER`, `GEAR_AUTO_CLASSIFIER_MODEL`, and
`GEAR_AUTO_FAIL_CLOSED`. Full policy, signed-admin, audit, and rollout guidance is in
[`docs/auto-mode.md`](docs/auto-mode.md). A labeled live reviewer smoke gate is available through
`bun run eval:auto-safety` (`--list` makes no model calls).

**Verification:** post-edit checks are auto-detected (typecheck/tests/lint across JS/TS, Rust,
Go — including monorepo roots and single nested apps); point them at your real commands with
`[verify] commands = ["bun run lint", "bun test tests/unit/"]`, tune `timeoutSecs`, or disable
with `enabled = false`.

**Research defaults** live under `[research]` in `.gear/config.toml`: `depth` (`quick`/`standard`/`deep`),
`maxSubQuestions`, `maxParallel`, `maxSourcesPerStep`, `autoApprove`, `save`, and `outputDir`. Env
overrides: `GEAR_RESEARCH_DEPTH`, `GEAR_RESEARCH_MAX_PARALLEL`, `GEAR_RESEARCH_MAX_SUBQUESTIONS`,
`GEAR_RESEARCH_AUTO_APPROVE`, `GEAR_RESEARCH_SAVE`.

**Project files (under `.gear/` in your workspace):**

- `hooks.json` — pre/post tool-use and session lifecycle hooks.
- `mcp.json` — project-scoped MCP servers.
- `commands/*.md` — custom slash commands. The filename is the command name; the body is the prompt
  template, with `$ARGUMENTS` (or `{{args}}`) replaced by whatever you type after the command.
  Optional `--- description: ... ---` frontmatter.
- `loop.md` — optional default prompt for a bare `/loop`. Project-level instructions override
  `~/.gear/loop.md`.

## Slash commands

`/model`, `/effort`, `/status`, `/providers`, `/keys`, `/mcp`, `/skills`, `/research`,
`/deepresearch`, `/cost`, `/loop`, `/loops`, `/compress`, `/plan`, `/rewind`, `/help`, `/quit` — plus any custom
commands you define in `.gear/commands/`.
`/skills` lists the bundled skill catalog; `/skills <keywords>` searches it.
`/research <question>` runs research: it proposes a plan, waits for your approval (Enter to run,
`r` to revise, `n` to cancel), then iteratively fans out and writes a cited report. `/deepresearch
<question>` is the same flow at the heaviest preset (more rounds, sources, and a longer report).
`/keys set tavily <key>` (or `brave`) enables a higher-quality search backend.
`/loop 5m <prompt>` repeats on a fixed cadence; `/loop <prompt>` adapts the next delay; `/loops`
lists tasks; `/loop cancel <id>` stops one; and `/loop clear` stops all loops in the conversation.

## Evals

```bash
bun run tests/eval/runner.ts                 # mock provider — deterministic, offline (plumbing only)
ANTHROPIC_API_KEY=sk-... \
  bun run tests/eval/runner.ts --real --max 3   # drive a live model for a real success rate
```

`--real` honors `GEAR_EVAL_PROVIDER` / `GEAR_EVAL_MODEL`, and supports `--tasks <category|name>` and
`--max <n>` for cheap smoke runs.

## Development

```bash
bun install
bun test tests/unit/      # unit tests
bun run typecheck         # tsc across all packages
cargo test -p gear-tools  # Rust tool tests
```

## Privacy & telemetry

Gear is local-first: **telemetry is off by default and transmits nothing unless
you opt in.** When enabled (a configured collector endpoint **and** an explicit
`yes` to the first-run prompt), it sends two minimal, redacted streams — crash /
error reports drawn from the local Black Box, and an anonymous daily usage
heartbeat — to a collector **you** run. It never sends file contents, prompts,
your IP address, or any device fingerprint.

- Inspect the exact bytes: `gear telemetry preview`
- Opt in / out any time: `gear telemetry on` / `gear telemetry off`
- Receive it yourself: run [`collector/gear-collector.ts`](collector/README.md)
  (a single dependency-free Bun server + live dashboard that stores reports to a
  local SQLite and never persists raw IPs).

Full details in [`PRIVACY.md`](PRIVACY.md).

## License

TBD.
