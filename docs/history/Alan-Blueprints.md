# PROJECT ALAN

## Two Blueprints: What We Are Building & How We Build It

**Codename:** Alan
**Class:** Sovereign Agentic Coding System (CLI core + Desktop shell)
**Author:** Savoir Studio
**Status:** Blueprint v1.0 — Pre-implementation
**Date:** 2026-05-10

---

# MAP 1 — WHAT WE ARE BUILDING (Architecture Blueprint)

This map defines the _system as it should exist when complete_. It is the target. Everything in Map 2 exists to converge on this.

## 1. System Thesis

Alan is a **local-first, sandboxed, multi-tool agentic coding assistant** with two surfaces:

1. A **headless engine** (Rust core + TypeScript orchestration) that runs the agent loop, manages context, and executes tools.
2. A **desktop client** (Tauri + React) that provides a Claude-Desktop-class UX over the engine via local IPC.

The engine is the product. The desktop app is one client. A CLI binary is another. An MCP server wrapper is a third. This separation is non-negotiable — it is what makes the system sellable to enterprise B2B clients later.

## 2. High-Level Topology

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTS                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Desktop UI   │  │ CLI binary   │  │ MCP server wrapper│  │
│  │ (Tauri/React)│  │ (alan)       │  │ (alan-mcp)        │  │
│  └──────┬───────┘  └──────┬───────┘  └─────────┬─────────┘  │
└─────────┼─────────────────┼────────────────────┼────────────┘
          │   JSON-RPC over Unix socket / stdio  │
          └─────────────────┴────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     ALAN ENGINE (daemon)                    │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ Orchestrator│◄─┤ Session Mgr  │◄─┤ Permission Broker│    │
│  └──────┬──────┘  └──────────────┘  └──────────────────┘    │
│         │                                                   │
│  ┌──────▼─────────┐  ┌────────────────┐  ┌──────────────┐   │
│  │ Agent Loop     │  │ Context Engine │  │ Tool Registry│   │
│  │ (ReAct/Planner)│◄─┤ (RAG+AST+mem)  │  │              │   │
│  └──────┬─────────┘  └────────────────┘  └──────┬───────┘   │
│         │                                       │           │
│  ┌──────▼──────────┐                  ┌─────────▼────────┐  │
│  │ LLM Gateway     │                  │ Tool Executors   │  │
│  │ (multi-provider)│                  │ (sandboxed)      │  │
│  └─────────────────┘                  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
        ┌───────────────┐       ┌──────────────┐
        │ LLM providers │       │ Sandbox VM   │
        │ (Anthropic,   │       │ (microVM or  │
        │  OpenAI, local│       │  bubblewrap) │
        │  ollama)      │       │              │
        └───────────────┘       └──────────────┘
```

## 3. Component Specifications

### 3.1 Orchestrator

The brain stem. Owns the message bus. Routes inference requests, tool calls, and events between components. Stateless itself — all state lives in Session Manager.

Responsibilities: request routing, cancellation propagation, streaming token relay, telemetry emission, deadlock detection on tool chains.

### 3.2 Session Manager

Persistent state for every conversation. Append-only event log per session (SQLite + WAL). Supports session fork, resume, rewind. Handles checkpointing every N turns.

Schema (core tables):

- `sessions(id, created_at, workspace_root, model, system_prompt_hash)`
- `events(session_id, seq, type, payload_json, ts)` — event types: `user_msg`, `assistant_msg`, `tool_call`, `tool_result`, `system_note`, `checkpoint`
- `files(session_id, path, hash, last_read_seq)` — tracks what the agent has actually seen
- `permissions(session_id, scope, granted_at, expires_at)`

### 3.3 Agent Loop (Planner-Executor split)

Two-tier loop, not a flat ReAct:

**Tier 1 — Planner** (slow model, e.g., Claude Sonnet/Opus): receives the user request and current state summary, emits a `Plan` (ordered list of `Step`s with explicit success criteria). Plans are first-class objects, stored, editable, and resumable.

**Tier 2 — Executor** (fast model, e.g., Haiku/local): receives one `Step` plus a tightly-scoped context window, calls tools, returns `StepResult`. Cheaper, faster, parallelizable across independent steps.

The Planner re-evaluates after every K Steps or whenever a Step fails twice. This avoids the death-spiral of flat ReAct loops where one bad observation poisons the whole trajectory.

State machine per turn:

```
IDLE → PLANNING → EXECUTING → OBSERVING → (REPLAN | EXECUTING | DONE)
                       │
                       └─→ ERROR_RECOVERY → (EXECUTING | ESCALATE)
```

### 3.4 Context Engine

The hardest component. Three-tier memory:

**Working set (in-prompt, ~30-60% of token budget):**

- System prompt + tool schemas
- Last N user/assistant turns verbatim
- "Pinned" files the user explicitly attached
- Active Plan + current Step

**Session memory (compressed, ~20-30%):**

- Summarized older turns (rolling summary, regenerated every K turns)
- "Discoveries" — facts the agent learned about the repo (e.g., "auth lives in `/services/auth/jwt.go`, uses HS256")
- Tool-call history index (not full results — just `(call, signature, summary, ref_id)`)

**Long-term store (retrievable, ~10-20%):**

- Workspace-wide AST index (tree-sitter)
- Symbol graph (definitions, references, call edges)
- Embedding index over chunked files (sqlite-vec or LanceDB)
- Issue/PR/commit history (git integration)

**Retrieval strategy:**

1. Lexical first (ripgrep over indexed paths) — fast, deterministic, free.
2. Symbolic second (AST query: "find all functions that call `db.Exec`") — bounded, structural.
3. Semantic third (embedding similarity) — fallback when the first two miss.
4. The retriever returns _file ranges_, not full files. The Context Engine then decides whether to inline or summarize each range based on remaining budget.

**Dynamic pruning:** every turn, before inference, the Context Engine runs a budget pass: relevance score per item, decay by recency, drop until under budget. Items can be evicted to session memory (with a stub left in working set: "[evicted: services/auth/jwt.go lines 100-340 — re-fetch via tool if needed]").

### 3.5 Tool Registry

Tools are described by JSON Schema, registered at startup, versioned. Three classes:

**Built-in core tools (must-have for parity):**

- `read_file(path, offset?, limit?)`
- `write_file(path, content)`
- `edit_file(path, old, new, replace_all?)` — string-replace, atomic, requires prior read
- `list_dir(path, recursive?, glob?)`
- `grep(pattern, path?, glob?, regex?)` — ripgrep wrapper
- `bash(cmd, cwd?, timeout?)` — sandboxed shell
- `ast_query(language, query)` — tree-sitter queries
- `web_fetch(url)` / `web_search(query)`
- `task_spawn(prompt, tools_subset?)` — sub-agent
- `todo_write(items)` — explicit plan management

**MCP tools (dynamic, third-party):** loaded from user/project `.alan/mcp.json`. Each MCP server is its own subprocess; the Tool Registry adapts MCP tools into the unified tool calling format.

**Custom tools (project-local):** users drop a `tools/` folder with JS/TS files exporting a `Tool` interface. Hot-reloaded.

Every tool call goes through the Permission Broker before execution.

### 3.6 Permission Broker & Sandbox

Three levels of trust per tool, configurable per project:

| Level     | Behavior                                                                 |
| --------- | ------------------------------------------------------------------------ |
| `auto`    | Execute without prompt (read-only ops by default)                        |
| `confirm` | Block until user approves in UI/CLI (writes, network)                    |
| `sandbox` | Execute inside isolated sandbox even on approval (shell, untrusted code) |

**Sandbox tech (platform-specific):**

- macOS: `sandbox-exec` profiles + a custom seatbelt rule set. Restrict FS to workspace root + `/tmp`. Block raw network unless allowlisted.
- Linux: `bubblewrap` (rootless) for first-tier; firecracker microVM for high-risk operations.
- Cross-platform fallback: Docker container with read-only bind to workspace.

**Hard rules (never overridable):**

- No write outside `workspace_root` and `~/.alan/cache`.
- No `rm -rf` on paths matching a blocklist (`/`, `~`, `$HOME`, etc.) — pre-execution path canonicalization + check.
- No env var leakage: tools see a curated env, not the parent process env.
- No exfiltration: outbound network in sandbox is denied by default; allowlist per session.

**Audit log:** every tool call (args hash, result hash, duration, exit code) appended to `~/.alan/audit.jsonl`. Tamper-evident via hash chain.

### 3.7 LLM Gateway

Provider-agnostic abstraction. Speaks Anthropic Messages, OpenAI Chat, Ollama, and Gemini. Single canonical internal format; adapters per provider.

Features: automatic retry with exponential backoff, streaming, prompt caching (Anthropic cache_control), token counting before send, cost ledger per session.

Routing: configured per task type. E.g., `planner: claude-opus-4-6`, `executor: claude-haiku-4-5`, `summarizer: local/qwen-2.5-coder-7b`. This is where token cost-efficiency comes from — don't burn Opus tokens on file summarization.

### 3.8 Error Handling & Self-Correction

Failure taxonomy:

| Class                   | Example                 | Strategy                                                                                              |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Tool input invalid      | bad path, missing arg   | Reject pre-execution, return schema error to model, force retry with fix                              |
| Tool exec failure       | bash exit != 0          | Capture stderr, return as observation; if same tool fails 2x with similar error → escalate to Planner |
| Model output malformed  | bad JSON tool call      | Re-prompt with the parse error; max 2 retries; then surface to user                                   |
| Infinite loop suspicion | same tool+args 3x       | Hard break, force replan                                                                              |
| Context overflow        | budget pass can't fit   | Aggressive summarize + restart turn from compacted state                                              |
| Sandbox violation       | wrote outside workspace | Kill tool, mark session degraded, require user confirmation to continue                               |
| Provider error          | 429, 5xx                | Backoff retry; if persistent, fall back to secondary provider                                         |

A circuit breaker tracks per-tool failure rate. Above threshold, the tool is disabled for the rest of the session.

### 3.9 Performance Targets

| Metric                                  | Target                    | Rationale                  |
| --------------------------------------- | ------------------------- | -------------------------- |
| First-token latency (cached prompt)     | < 800ms                   | Comparable to Claude Code  |
| Tool roundtrip (read_file, < 1MB)       | < 50ms                    | Local, no excuse           |
| Indexing throughput (cold)              | ≥ 5k files/min            | Tree-sitter is fast        |
| Context budget hit rate (no truncation) | > 95%                     | Pruning must work          |
| Session resume time                     | < 2s for 1k-event session | SQLite + lazy hydration    |
| Memory footprint, idle                  | < 200MB                   | Daemon should be invisible |

### 3.10 UI/UX Architecture (Desktop Shell)

Reference frame: Claude Desktop. Layout:

```
┌────────────────────────────────────────────────────────────────────┐
│ ⌘ Alan                                          ⚙   👤   ─ □ ✕     │
├──────────────┬─────────────────────────────────────────────────────┤
│              │                                                     │
│  Sessions    │   ┌────────────────────────────────────────────┐    │
│  ────────    │   │ How can I help with `payments-service`?    │    │
│  ▸ Today     │   └────────────────────────────────────────────┘    │
│   • Refactor │                                                     │
│     auth     │   ┌─ User ──────────────────────────────────────┐   │
│   • Fix bug  │   │ Add Stripe webhook handler with idempotency │   │
│     #4421    │   └─────────────────────────────────────────────┘   │
│              │                                                     │
│  ▸ Yesterday │   ┌─ Alan ──────────────────────────────────────┐   │
│   • ...      │   │ Plan:                                       │   │
│              │   │  1. ☐ Inspect existing webhook routing      │   │
│              │   │  2. ☐ Add /webhooks/stripe handler          │   │
│  Workspaces  │   │  3. ☐ Implement idempotency key store       │   │
│  ────────    │   │  4. ☐ Tests                                 │   │
│  ◉ payments  │   │                                             │   │
│  ○ savoir-web│   │ ▼ Tool: grep("webhook", recursive=true)     │   │
│              │   │   12 matches in 4 files [expand]            │   │
│              │   │                                             │   │
│              │   │ Reading services/api/routes.go...           │   │
│              │   └─────────────────────────────────────────────┘   │
│              │                                                     │
│              │   ┌─────────────────────────────────────────────┐   │
│              │   │ Ask anything...                       ⊕ ↑   │   │
│              │   └─────────────────────────────────────────────┘   │
└──────────────┴─────────────────────────────────────────────────────┘
```

Key UI components:

- **Left rail:** session list (grouped by day), workspace switcher, settings.
- **Main pane:** message stream with collapsible tool-call cards. Tool calls show name + args + result preview, click to expand full result. Plans render as live checklists.
- **Composer:** multiline input, file attach (⊕), model selector, send (↑).
- **Diff viewer:** when the agent proposes file edits, render as VS Code-style side-by-side diff with Apply/Reject per hunk. This is the killer UX detail — never blind-apply, always show.
- **Permission modal:** middle-of-screen modal when a `confirm`-level tool is about to run. Shows the exact command, expected scope, and "Allow once / Allow this session / Deny" options.
- **Plan pane (right, collapsible):** persistent view of current Plan with progress.
- **Context inspector (debug):** shows what's currently in the context window, token-by-token cost. Power-user feature.

Theme: dark default (matches Claude Desktop). Typography: SF Mono for code, Inter for prose. Motion: 150ms ease-out for everything; no bounce.

---

# MAP 2 — HOW WE BUILD IT (Implementation Blueprint)

This map is the buildable sequence. Every milestone has explicit "done" criteria.

## 1. Tech Stack Decisions

| Layer         | Choice                                                                     | Why                                                                                                  |
| ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Engine core   | **Rust**                                                                   | Speed, safety, single static binary. Owns sandbox, tool exec, indexing.                              |
| Orchestration | **TypeScript on Bun**                                                      | Fast iteration on agent logic, JSON-native, huge LLM SDK ecosystem. Runs as subprocess of Rust core. |
| IPC           | **JSON-RPC 2.0** over Unix socket (stdio fallback)                         | Standard, debuggable, language-agnostic.                                                             |
| Desktop UI    | **Tauri 2 + React + TypeScript**                                           | Native window, Rust backend, ~15MB bundle vs Electron's 150MB.                                       |
| Index store   | **SQLite + sqlite-vec extension**                                          | Single file, embeddable, vec search built-in. No separate daemon.                                    |
| AST parsing   | **tree-sitter** (via Rust binding)                                         | Industry standard, fast, ~40 languages.                                                              |
| LLM SDK       | **`@anthropic-ai/sdk`, `openai`, `ollama` clients** wrapped in our Gateway | No lock-in.                                                                                          |
| Sandbox       | **`sandbox-exec` (mac), `bubblewrap` (linux)**                             | Native, no Docker dependency for default flow.                                                       |
| Telemetry     | **OpenTelemetry → local jaeger (dev), opt-in remote (prod)**               | Standard, debuggable.                                                                                |
| Build         | **Cargo workspace + Turbo for TS**                                         | Mono-repo.                                                                                           |

Rejected and why:

- Electron: bundle size, RAM cost, slow startup.
- Python core: GIL kills concurrent tool exec, packaging is a nightmare.
- LangChain/LangGraph for orchestration: too much abstraction; we want explicit state. Borrow ideas, don't import the framework.
- Docker as default sandbox: heavy install dependency for end users; reserve for high-risk tier only.

## 2. Repository Structure

```
alan/
├── Cargo.toml                  # workspace root
├── crates/
│   ├── alan-core/              # engine daemon, IPC server, session mgr
│   ├── alan-sandbox/           # platform-specific sandbox impls
│   ├── alan-index/             # tree-sitter, sqlite-vec, retrieval
│   ├── alan-tools/             # built-in tool implementations
│   └── alan-cli/               # `alan` binary
├── packages/                   # TS workspace (Bun)
│   ├── orchestrator/           # agent loop, planner, executor
│   ├── llm-gateway/            # provider adapters
│   ├── tool-registry/          # JSON-schema + MCP adapter
│   └── shared/                 # types shared with UI
├── apps/
│   └── desktop/                # Tauri + React app
├── docs/
├── .alan/                      # project-local config example
│   ├── config.toml
│   ├── mcp.json
│   └── tools/
└── tests/
    ├── integration/
    └── eval/                   # agent evals (HumanEval-style + custom)
```

## 3. Build Phases (Realistic)

> Realism note up front: a solo or small-team build of something genuinely competitive with Claude Code or Cursor is a **9-15 month effort**, not 6 weeks. The 6-week framing in the source prompt produces a toy. Below is what is actually achievable, with honest deadlines for a 1-2 person team working full-time on an M-series Mac.

### Phase 0 — Foundation (Week 1-2)

Goals: repo skeleton compiles, CI green, IPC roundtrip works.

Tasks:

1. Cargo workspace + Bun TS workspace, shared `package.json`/`Cargo.toml` lints.
2. `alan-core` daemon binary that spawns and listens on a Unix socket.
3. JSON-RPC 2.0 message format defined in `packages/shared/protocol.ts` and Rust mirror generated via codegen (use `ts-rs` or `specta`).
4. `alan-cli` binary that connects to daemon, sends a ping, prints reply.
5. CI: GitHub Actions matrix (mac + linux), `cargo test`, `bun test`, `cargo clippy --deny warnings`.
6. Logging: `tracing` (Rust) + `pino` (TS) emit structured JSON to `~/.alan/logs/`.

**Done = `alan ping` returns `pong` from a daemon-spawned subprocess that itself shelled out to a TS subprocess, all over JSON-RPC, on both mac and linux CI.**

### Phase 1 — Core Loop MVP (Week 3-5)

Goals: agent can read files and answer questions about them. No writes yet.

Tasks:

1. LLM Gateway with Anthropic adapter only. Streaming, tool-calling, basic retry.
2. Session Manager: SQLite schema, append events, list sessions, resume.
3. Tool Registry with three tools: `read_file`, `list_dir`, `grep`.
4. Flat ReAct loop in TS orchestrator (no Planner-Executor split yet — that's Phase 3).
5. CLI surface: `alan chat`, `alan resume <id>`, `alan list`.
6. First eval harness: 20 questions about a fixed open-source repo (e.g., a snapshot of a public Go project), pass/fail scored manually.

**Done = `alan chat` answers "where is JWT validation done in this repo?" correctly on 3 different test repos, with tool calls visible in CLI output.**

### Phase 2 — Write Capability + Diff Application (Week 6-8)

Goals: agent can edit code safely. Diff viewer working in CLI.

Tasks:

1. `write_file`, `edit_file` tools with atomic write (write to tmp, fsync, rename).
2. Pre-write hash check: if file changed since last read, force re-read before edit. Eliminates the #1 class of agent edit bugs.
3. Multi-hunk diff: when the agent proposes multiple changes to one file, batch them, present as a single diff.
4. CLI diff viewer using `similar` crate (Rust) — colored side-by-side.
5. Permission Broker first cut: write ops always prompt unless `--yolo` flag set.
6. Eval expansion: 30 tasks of "fix this failing test" on synthetic mini-repos. Track pass rate.

**Done = pass rate ≥ 60% on the 30-task eval, zero data-loss incidents in 100 manual sessions.**

### Phase 3 — Planner-Executor + Context Engine v1 (Week 9-13)

Goals: agent stops getting lost in long sessions. Context never overflows.

Tasks:

1. Planner-Executor split. Planner outputs `Plan { steps[] }` as a structured tool call. Executor consumes one Step at a time.
2. Plan persistence: Plans stored as session events, mutable, render in UI.
3. Context Engine v1:
   - Working set / session memory / long-term tier in code.
   - Rolling summary: every 10 turns, summarize the oldest 5 into a "session note" event.
   - Token budget pass: simple priority queue, drops by `(age × inverse_relevance)`.
4. Tree-sitter integration for Go, Python, TS, JS, Rust, Java first. Symbol extraction → SQLite.
5. `ast_query` tool exposed to the model.
6. Embedding index: chunk files at function boundaries (via AST), embed with `bge-small` locally via Ollama, store in sqlite-vec.

**Done = handles a 30-turn session on a 50k-line repo without context overflow; eval pass rate ≥ 70%.**

### Phase 4 — Desktop Shell (Week 14-18)

Goals: ship the UI from Map 1, §3.10.

Tasks:

1. Tauri 2 scaffold, Rust backend embeds `alan-core` as a library (not a separate daemon when running from desktop — single process).
2. React app: session list, message stream, composer.
3. Tool-call card component with collapsible details.
4. Diff viewer in React: use `react-diff-viewer-continued` or build on Monaco's diff editor.
5. Permission modal flow.
6. Plan pane.
7. File attach (⊕): drag-drop or picker, attached files become "pinned" in working set.
8. Settings UI: model selection, API keys (stored in OS keychain via Tauri's `keyring` plugin), permission defaults.
9. Auto-update via Tauri updater, signed with our cert.

**Done = installable .dmg and .deb, used dogfood-style daily by the team, no daily-blocker bugs for 1 week.**

### Phase 5 — Sandbox + Hardening (Week 19-22)

Goals: safe to run on a real engineer's machine without supervision.

Tasks:

1. macOS sandbox-exec profile: FS allow-list, network deny-by-default.
2. Linux bubblewrap profile: same shape.
3. Path canonicalization + blocklist on every FS-touching tool.
4. Env curation: tool subprocess gets `PATH`, `HOME`, project-scoped vars only.
5. Audit log with hash chain.
6. Crash recovery: daemon SIGKILL → on next start, detect dirty session, offer rollback to last checkpoint.
7. Threat model document: written, reviewed, signed off.
8. External pen-test (small budget — even a $2k pass with a freelancer on HackerOne is better than nothing).

**Done = pen-test report with no Critical or High findings open; threat model doc published.**

### Phase 6 — MCP, Custom Tools, Polish (Week 23-26)

Goals: extensibility story. The thing third parties can build on.

Tasks:

1. MCP client implementation in Rust (or wrap `@modelcontextprotocol/sdk` in TS layer).
2. `.alan/mcp.json` discovery and lifecycle (spawn, health check, restart).
3. Custom tools loader (TS files in `.alan/tools/`, hot reload).
4. `alan-mcp` server wrapper: makes Alan itself addressable as an MCP server (so Claude Desktop or another agent can use Alan's tools remotely).
5. Performance pass: prompt caching, parallel tool calls where independent, streaming everywhere.
6. Telemetry opt-in.
7. Docs site, install scripts, brew tap, deb/rpm.

**Done = three reference MCP integrations working (e.g., Linear, Postgres, Slack); first beta cohort onboarded.**

### Phase 7 — Evals, Marketing, B2B Launch (Week 27-36+)

This is where most projects die. The product works for you; making it work for a paying customer is another product.

Tasks:

1. SWE-bench Lite run: get a number, publish it, iterate.
2. 5 design partners from Savoir Studio's network. Free white-glove onboarding. Weekly feedback loops.
3. Pricing model: per-seat, per-token, or hybrid. Decide based on partner feedback.
4. Compliance lift: SOC 2 Type 1 (3-month engagement minimum, ~$15-25k).
5. Sales motion: founder-led for first 10 customers.

## 4. Critical Engineering Details Often Missed

These are the details that separate a working prototype from a sellable product. They live nowhere in tutorials.

### 4.1 The Edit Correctness Problem

Cursor and Claude Code spent more engineering time on "make the agent's edits actually apply correctly" than on the agent loop itself. Causes:

- File changed between read and write → stale edit.
- Whitespace mismatch (tabs vs spaces, line endings).
- Multiple identical strings → wrong match.
- Encoding (UTF-8 BOM, CRLF on Windows).

Solutions baked in from day one:

- Edit tool requires hash of last-read content; mismatch → reject and force re-read.
- Match string must be unique in file or include enough surrounding context — enforce in tool schema description.
- Normalize line endings on read; preserve original on write.
- Atomic writes only.

### 4.2 The Long-Running Tool Problem

A `bash` tool running `npm install` takes 90 seconds. The model hangs. The user thinks it's frozen.

Solution: tools support streaming via async iterators. Long-running tools emit progress events to the UI. Model sees the final result + truncated tail of stdout (last 500 lines + summary). Background tools (`npm run dev`, `cargo watch`) get their own lifecycle: started in background, agent gets handle, can `read_logs(handle)` later.

### 4.3 The Cold Start Problem

First time the agent opens a new repo, it knows nothing. Indexing 50k files takes minutes. UX must not block.

Solution: indexing runs in background from the moment a workspace opens. Agent operates on partial index immediately, queries the index with a freshness flag. Index state is a session event so the agent knows what it knows.

### 4.4 The Multi-Turn Drift Problem

After 20 turns, agents start hallucinating file contents from memory instead of re-reading. Common failure mode in production.

Solution: every assertion the agent makes about file contents must cite a `(path, hash, line_range)`. Citations are validated by the orchestrator before being shown to the user — if the cited range doesn't match the current file, the orchestrator forces a re-read and rerun.

### 4.5 The Permission Fatigue Problem

Prompting the user for every tool call kills UX. Allowing everything kills security.

Solution: permission scopes. "Allow `bash` for any command matching `^(npm|yarn|pnpm) (test|run test|run build)$` for this session." Scopes auto-suggested by the system based on the agent's intent. Power users can edit scopes in settings.

### 4.6 The Multi-Provider Tax

Anthropic, OpenAI, and Gemini have different tool-calling formats, different streaming protocols, different caching mechanics. Naive abstractions leak.

Solution: the Gateway translates _into_ a canonical internal format on entry, _out of_ it on exit. Provider-specific features (Anthropic prompt cache, OpenAI structured outputs) exposed as optional capabilities the Orchestrator can opt into. Don't pretend they're identical.

## 5. Honest Timeline & Resourcing

| Scope                                | Solo full-time | 2-person full-time | What you get                                |
| ------------------------------------ | -------------- | ------------------ | ------------------------------------------- |
| Phase 0-2 (working coding agent CLI) | 8-10 weeks     | 5-6 weeks          | Toy — useful for personal use, not sellable |
| Phase 0-4 (desktop app, decent UX)   | 18-22 weeks    | 11-14 weeks        | Personal-tier product, demo-able            |
| Phase 0-5 (sandboxed, safe)          | 26-30 weeks    | 16-20 weeks        | Beta-launchable to design partners          |
| Phase 0-7 (B2B-ready)                | 50-60 weeks    | 30-40 weeks        | First paying customers possible             |

This assumes:

- M-series Mac, no infra costs eating the budget.
- LLM cost during dev: $300-800/month for evals + dogfooding.
- No SOC 2 / no enterprise security review until Phase 7.

What kills these timelines in practice:

- Underestimating eval infrastructure (1-2 weeks just to build a real eval harness).
- Underestimating the diff-application correctness problem (Phase 2 always slips).
- Trying to support too many languages in Phase 3 (start with 3, not 10).
- Building UI in parallel with the engine when the engine isn't stable yet.

What "competitive with Claude Code" actually means: Anthropic has dozens of senior engineers, infrastructure teams, eval teams, and proprietary models. A solo or small-team build will not match parity. Realistic ambition: **best-in-class for a specific vertical** (e.g., n8n workflow generation, Savoir Studio's automation agency niche) where general-purpose agents are weaker. Differentiation > parity.

## 6. First Specific Differentiators to Pursue

Listed in order of moat strength:

1. **n8n workflow injection as a first-class tool.** No other agent does this natively. Direct alignment with Savoir Studio's revenue.
2. **Project-scoped MCP discovery.** Drop a `.alan/mcp.json` in any repo, agent picks up project-specific tools. Stronger than per-machine MCP config.
3. **Structured Plans as user-editable artifacts.** User can drag steps to reorder, mark done, edit. Most agents hide the plan; expose it.
4. **Auditable session export.** One command exports a session as a signed PDF report (every tool call, every file change, every model response). Sells to compliance-conscious B2B buyers.
5. **Local-only mode** with Ollama + qwen-2.5-coder. Some prospects can't send code to a cloud LLM. Owning this is a small but real market.

## 7. Risks & Mitigations

| Risk                                                                  | Likelihood | Impact   | Mitigation                                                                         |
| --------------------------------------------------------------------- | ---------- | -------- | ---------------------------------------------------------------------------------- |
| Anthropic/OpenAI release a feature that obsoletes core differentiator | High       | High     | Pick differentiators they're unlikely to build (vertical-specific, on-prem, audit) |
| Diff-application bugs corrupt user files                              | Medium     | Critical | Atomic writes, hash checks, mandatory backups, eval coverage                       |
| Sandbox escape                                                        | Low        | Critical | Defense in depth, no overridable rules, audit, pen-test                            |
| Solo founder burnout                                                  | High       | High     | Cut scope ruthlessly, ship Phase 0-4 first, get one paying customer before Phase 5 |
| Model cost during dev exceeds budget                                  | Medium     | Medium   | Cache aggressively, run evals with Haiku, only Opus for the planner                |

---

# APPENDIX A — Data Flow Diagram (Text)

```
┌────────┐
│  USER  │
└───┬────┘
    │ "fix the failing test in payments-service"
    ▼
┌──────────────────────────────────────────────┐
│ Desktop UI / CLI                             │
│ - format as user_msg event                   │
│ - send to daemon via JSON-RPC                │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ Orchestrator                                 │
│ - append event to session log                │
│ - request context build from Context Engine  │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ Context Engine                               │
│ - query lexical (rg) → get candidates        │
│ - query AST → get symbol locations           │
│ - query embeddings → get semantic neighbors  │
│ - apply budget pass → assemble final prompt  │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ LLM Gateway (Planner)                        │
│ - send to Claude Opus                        │
│ - stream Plan { steps[] } back               │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ Orchestrator: store Plan, dispatch Step 1    │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ LLM Gateway (Executor)                       │
│ - Step 1 + scoped context → Claude Haiku     │
│ - emits tool_call: read_file("...")          │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ Permission Broker                            │
│ - level: auto (read) → pass through          │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ Tool Executor: read_file                     │
│ - canonicalize path                          │
│ - check inside workspace_root                │
│ - read, hash, return content + hash          │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ Orchestrator                                 │
│ - append tool_result event                   │
│ - feed back to Executor                      │
└───┬──────────────────────────────────────────┘
    ▼ (loop until Step done)
┌──────────────────────────────────────────────┐
│ Step complete → Orchestrator marks done      │
│ Re-evaluate Plan; dispatch next Step or DONE │
└───┬──────────────────────────────────────────┘
    ▼
┌──────────────────────────────────────────────┐
│ Desktop UI: stream events to user            │
│ - render messages, tool cards, diffs         │
└──────────────────────────────────────────────┘
```

---

# APPENDIX B — Open Decisions to Lock Before Phase 1

These need answers before code starts. Don't skip.

1. **License model for Alan engine.** Open core (Apache 2 engine, commercial desktop) vs all-proprietary. Recommendation: open core — recruits trust faster, B2B still pays for the desktop + support.
2. **Default LLM provider for v1.** Recommendation: Anthropic primary, OpenAI fallback, Ollama for local mode. Single primary keeps Phase 1 small.
3. **Telemetry posture.** Opt-in only, anonymous, locally aggregated. Anything else burns trust.
4. **Auto-update policy.** Yes by default, signed, with a kill switch. Required for B2B.
5. **Workspace concept.** Single workspace per session, or multi-workspace? Recommendation: single per session for v1, multi later.
6. **Pricing.** Don't decide until Phase 4. Wrong number set early kills the early adopter motion.

---

End of blueprints. Next concrete decision: lock the open decisions in Appendix B, then start Phase 0.
