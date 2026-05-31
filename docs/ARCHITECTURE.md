# Alan — Architecture Overview

This document describes how the running system is organized. For the full design rationale and long-term vision, see [Alan-Blueprints.md](../Alan-Blueprints.md).

---

## Component map

```
┌────────────────────────────────────────────────────────────┐
│                          CLIENTS                           │
│  bin/alan (shell)  ·  Desktop (Tauri/React)  ·  MCP wrap  │
└────────────────────────┬───────────────────────────────────┘
                         │ JSON-RPC newline-delimited over
                         │ Unix domain socket (~/.alan/alan.sock)
┌────────────────────────▼───────────────────────────────────┐
│                      ALAN ENGINE                           │
│                                                            │
│  IpcServer (alan-core)                                     │
│    └─► dispatch_request()  ──► SessionManager              │
│                                  └─► SQLite WAL DB         │
│                                                            │
│  Engine (orchestrator)                                     │
│    ├─► AgentLoop  ──► LlmGateway  ──► providers           │
│    │       └─► ToolRegistry  ──► alan-tools binary         │
│    ├─► PermissionBroker                                    │
│    ├─► ContextEngine                                       │
│    └─► PlanRunner  ──► Planner + Executor (if --planner)   │
└────────────────────────────────────────────────────────────┘
```

---

## Data flow for a single user message

```
1. User types input
       │
2. Engine.chat(sessionId, input)
       │
3. ContextEngine.build()
   ├─ Tier 1: last N turns from session log (sliding window)
   ├─ Tier 2: compressed session memory (distilled observations)
   └─ Tier 3: AST index hits from alan-index (symbol/file RAG)
       │
4. LlmGateway.inferStream()  ──►  LLM provider (streaming)
       │
5. AgentLoop processes stream events:
   ├─ text_delta  →  yield to caller (printed to terminal)
   ├─ tool_use_start  →  PermissionBroker.check()
   │     ├─ allowed  →  ToolRegistry.execute(tool, args)
   │     │               └─► alan-tools binary (subprocess)
   │     └─ needs_confirmation  →  pause, prompt user
   └─ message_stop  →  append AssistantMessage + ToolResults to session
       │
6. SessionManager.append_event()  →  SQLite insert
       │
7. If stop_reason == "end_turn":  yield turn_complete
   If stop_reason == "tool_use":  loop back to step 3
```

---

## Planner-Executor mode (`--planner`)

When `--planner` is active, the AgentLoop is replaced by the PlanRunner:

```
User message
    │
Planner (slow model, full context)
    └─► Plan { steps: [Step, Step, ...] }
            │
            ├─► Step 1 ──► Executor (fast model, scoped context)
            │                  └─► tools, result
            ├─► Step 2 ──► Executor
            │
           ...
            │
       After K failures or K steps: Planner re-evaluates
            └─► revised Plan  ──►  continue
```

The split reduces cost (executor uses a cheaper model per step) and avoids trajectory poisoning (the planner sees the full picture before committing to next steps).

---

## Session storage

Every conversation is an **append-only event log** in SQLite:

| Table | Purpose |
|-------|---------|
| `sessions` | One row per conversation; workspace, model, status |
| `events` | Ordered event stream: `user_msg`, `assistant_msg`, `tool_call`, `tool_result`, `checkpoint` |
| `files` | Files the agent has read + their hash at read time |
| `permissions` | Session-scoped tool grants |
| `audit_log` | Tamper-evident log of tool executions (planned, not yet active) |

The database lives at `~/.alan/alan.db`. Schema version is tracked via `PRAGMA user_version`; the daemon refuses to start against a DB written by a newer binary.

Dirty-session detection: on startup, `find_dirty_sessions()` identifies sessions that have a `session_started` checkpoint but no corresponding `session_ended`. These can be rolled back to the last checkpoint via `rollback_to_last_checkpoint()`.

---

## IPC protocol

Clients talk to the daemon over a Unix socket using **newline-delimited JSON-RPC 2.0**:

```json
→ {"jsonrpc":"2.0","id":"1","method":"session.create","params":{"workspace":"/my/project"}}
← {"jsonrpc":"2.0","id":"1","result":{"id":"019...","model":"claude-sonnet-4-20250514",...}}
```

Supported methods:

| Method | Description |
|--------|-------------|
| `ping` | Liveness check; returns `"pong"` and binary version |
| `session.create` | Create a new session for a workspace |
| `session.list` | List active sessions |
| `session.events` | Stream events from a session by sequence number |
| `session.append_event` | Append an event to a session |

---

## LLM Gateway

`packages/llm-gateway` provides a uniform `LlmProvider` interface across four backends:

```
LlmGateway
  ├─ AnthropicProvider   →  @anthropic-ai/sdk
  ├─ OpenAIProvider      →  openai SDK (also used for OpenRouter)
  ├─ OpenRouterProvider  →  OpenAIProvider + OpenRouter base URL
  └─ OllamaProvider      →  OpenAI-compatible local endpoint
```

All providers expose `infer()`, `inferStream()`, `countTokens()`, and `healthCheck()`. The gateway adds retry logic with exponential back-off, Retry-After header respect, and a cost ledger.

---

## Tool execution

Tools are defined in `packages/tool-registry` and executed by the `alan-tools` Rust binary. The TypeScript agent calls the binary via subprocess, passing JSON arguments on stdin and receiving JSON results on stdout. This isolates tool execution from the orchestration process.

Built-in tools:

| Tool | Permission | Description |
|------|-----------|-------------|
| `read_file` | auto | Read file with optional line range |
| `write_file` | confirm | Write or create a file |
| `edit_file` | confirm | Apply a targeted string replacement |
| `bash` | confirm | Run a shell command |
| `list_dir` | auto | List directory contents |
| `symbol_search` | auto | Find symbol definitions via tree-sitter index |
| `grep` | auto | Search file contents |

---

## Permission model

Every tool call passes through `PermissionBroker.check()`:

```
PermissionLevel
  auto      →  allowed immediately (read-only tools)
  confirm   →  pause and prompt user, optionally grant for session
  sandbox   →  prompt; execution runs in restricted environment (WIP)
```

`--yolo` sets all checks to `allowed`. Permission grants are stored in the `permissions` table scoped to `once`, `session`, `project`, or `global`.

---

## Context engine

`packages/orchestrator/src/context-engine.ts` assembles the prompt from three tiers before each inference call:

| Tier | Token budget | Contents |
|------|-------------|---------|
| Working set | ~50–60% | System prompt, last N turns, active plan, pinned files |
| Session memory | ~20–30% | Rolling summary of older turns, agent "discoveries" |
| Long-term store | ~10–20% | AST symbol hits, file chunks from the index |

Token counts are tracked against the provider's context window. When the budget is exceeded, older working-set turns are compressed into session memory.

---

## Adding a new LLM provider

1. Create `packages/llm-gateway/src/providers/myprovider.ts` implementing `LlmProvider`
2. Export it from `packages/llm-gateway/src/index.ts`
3. Register it in `packages/orchestrator/src/engine.ts` under the provider name
4. Add config types in `packages/shared/src/config.ts`
5. Document the env var in `README.md`

---

## Key files at a glance

| File | Role |
|------|------|
| `crates/alan-core/src/session.rs` | SQLite session store; append-only event log |
| `crates/alan-core/src/ipc.rs` | Unix socket server and client |
| `crates/alan-core/src/protocol.rs` | JSON-RPC types, SessionEvent enum |
| `packages/orchestrator/src/engine.ts` | Top-level Engine class; wires all components |
| `packages/orchestrator/src/agent-loop.ts` | Single-turn ReAct loop |
| `packages/orchestrator/src/plan-runner.ts` | Planner-Executor two-tier loop |
| `packages/orchestrator/src/context-engine.ts` | Three-tier prompt assembly |
| `packages/orchestrator/src/permissions.ts` | PermissionBroker |
| `packages/llm-gateway/src/gateway.ts` | LlmGateway with retry and cost tracking |
| `packages/shared/src/config.ts` | Config loading and type definitions |
| `bin/alan` | Shell launcher; resolves binary paths |
