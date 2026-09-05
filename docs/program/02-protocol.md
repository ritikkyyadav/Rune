# Phase 2 — One protocol

**Lane B · 10–14 days · the seam every later surface hangs on**

## Goal

The engine is a server. One typed, versioned protocol package is consumed by the terminal, the desktop, the web client, editors and CI. No client duplicates the event union; no client reaches into engine internals.

## Evidence (2026-09-02)

- Event stream is a typed union: `AgentTurnEvent`, 22 members, `packages/orchestrator/src/agent-loop.ts:38-160`; `ResearchEvent`, 9 members, `research-types.ts:120-141`. `Engine.chat()` yields it (`engine.ts:3156`).
- The one choke point where events become rows is `TurnRenderer.onEvent()` at `bin/ui/turn.ts:1175`, typed `(event: any)`. `bin/ui/events.ts:130` is the same, narrower. Adding a union member compiles clean and renders nothing.
- Every human-in-the-loop path is already dependency-inverted through handler setters: `setPermissionHandler` (`engine.ts:1369`), `setQuestionHandler` (`:1548`), `setBriefHandler` (`:1554`), `setAutoApprovalNotifier` (`:1374`), `setAutoDeferralNotifier` (`:1387`). Methods: `runHeldStep` (`:1410`), `dismissHeldSteps` (`:1503`), `switchModel` (`:4347`), `abort` (`:4095`), `interject` (`:4110`).
- `bin/engine-host.ts` is JSON-RPC in all but the envelope: `{"id","cmd","args"}` / `{"id","ok","result"}` / `{"stream","payload"}`, 25 commands in `dispatch()` (`:378-563`), transport-agnostic through `handleRequestLine` (`:567`) and `emitStream` (`:104`), over stdio and unix socket (`--socket`, stale-socket probe `:625-649`, broadcast to all clients `:104-117`).
- `host-client.ts:19` is a working reference client (146 lines): request correlation, stream fan-out, line buffering, timeouts.
- Gaps: the host wires only `setPermissionHandler` (`engine-host.ts:336`), so `ask_user` fails with "No interactive user is available" (`ask-user.ts:181-184`) for every desktop and detached run and held steps are invisible off-terminal (`engine.ts:3985`). `activeChat` is one module-level boolean (`engine-host.ts:338, 585`); `Engine` holds one `currentAbort`/`liveLoop` (`engine.ts:3104, 3830`); `abort()` takes no session. Permission promises have no timeout and no rejection on disconnect (`engine-host.ts:321-335`, `:676-680`). `resume_session` returns only user turns (`engine-host.ts:400-415`). No research command. No auth of any kind: any connecting client can call `save_settings` (`:470`), which writes API keys.
- Persistence: 14 event types in `events` (`packages/shared/src/session.ts:44-107`); `text_delta`, `usage`, `retry`, `fallback`, `tool_progress`, `step_check`, `verification_*`, `handoff`, `replanning`, `checkpoint_saved` have no row. `eventsToTranscript` (`engine.ts:289`) handles 5 types.
- Sub-agent internals are flattened to strings via `onProgress` (`tool-registry/src/types.ts:35`, `worker.ts:476,489`, re-emitted as `tool_progress` at `agent-loop.ts:2114`).
- `headless.ts` consumes the stream and reduces it to counters (`:113-151`); no `--stream-json`.
- `apps/desktop/src/lib/types.ts:80` redeclares `EngineEvent` by hand and has drifted both ways (stale `plan_*`, missing `retry`/`tool_progress`/`step_check`/`handoff`, `usage` missing cache fields).

## Work items

### P2.1 `packages/protocol` (2 days)

- New workspace package `@rune/protocol`: move `AgentTurnEvent`, `ResearchEvent`, the command/result types for all 25 host commands, and the five round-trip shapes (`PermissionPrompt`/`UserPermissionDecision`, `UserQuestion`/answer, brief, auto-approval notice, `AutoModeDeferral` list + `runHeldStep`/`dismissHeldSteps`). `PROTOCOL_VERSION` constant; JSON-RPC 2.0 envelope helpers; zod (or hand-written) validators for inbound frames; `assertNever` exhaustiveness helper.
- `agent-loop.ts`, `research-types.ts`, `engine-host.ts`, `host-client.ts`, `bin/ui/turn.ts`, `bin/ui/events.ts`, `headless.ts`, `apps/desktop/src/lib/*` import from it. Delete `apps/desktop/src/lib/types.ts:80` `EngineEvent`.
- Retype `onEvent(event: any)` → `AgentTurnEvent` at `turn.ts:1175` and `formatEvent` at `events.ts:130`; add an exhaustiveness test that fails when a member is unhandled by the TUI reducer, the desktop reducer, or the headless reducer.

### P2.2 Round-trips for all five handlers (1.5 days)

In `engine-host.ts`, mirror the `pendingPerms` pattern (`:319-335`) for question, brief, and held steps; push auto-approval notices and deferral lists as streams. Every pending promise gets a timeout (default 10 min, configurable) and is rejected when the last client disconnects, with a policy: unattended → `deny` for permissions, "no answer" for questions, and the deferral stays in the held-steps ledger. Tests in `tests/integration/engine-host-socket.test.ts`.

### P2.3 Sessions and concurrency (2–3 days)

- Replace `activeChat` with a per-session run map. Decision: **process-per-session supervisor** (reuse `detach-cli.ts`'s spawn + `~/.rune/run/registry.json` pattern) rather than refactoring `Engine` for in-process multiplexing. `rune serve` becomes a supervisor that spawns one host per session on demand, proxies frames, and reaps idle hosts.
- `abort(sessionId)`; `interject(sessionId, text)`.

### P2.4 `rune serve` (2 days)

- WebSocket transport around `handleRequestLine`/`emitStream`. Loopback bind by default; bearer token minted to `~/.rune/serve.json` (0600) and required on every connection; `Origin` allowlist; `--host 0.0.0.0` opt-in with a printed warning; `--port`; `rune serve --status`; graceful shutdown that leaves running sessions' hosts alive (as detach does today).
- `save_settings`, `login`, key writes: refuse over non-loopback unless the token was minted with `--allow-remote-settings`.

### P2.5 Replay and subscribe (2 days)

- `subscribe(sessionId, sinceSeq)`: backfill from DB via a new `replayEvents()` beside `eventsToTranscript` (`engine.ts:289`) that maps every persisted type, then stream live. Persist the missing run-level events (`usage`, `fallback`, `retry`, `verification_*`, `handoff`, `step_check`, `checkpoint_saved`) as a compact `run_trace` event, or as rows of their own; `text_delta` stays unpersisted and the UI says "settled state" on reconnect. Per-session ring buffer of the last N live events in the host so a reconnect mid-turn sees the current tool call.

### P2.6 Sub-agent event fidelity (1.5 days)

Replace `onProgress: (note: string)` with `onEvent: (ev: AgentTurnEvent, agentId)`; `tool_progress` carries the child event typed under `child`. The fleet panel (`turn.ts:617`) and the desktop fleet view render from real events. Keep a string projection for the TUI's one-line heartbeat.

### P2.7 Research over the protocol (half a day)

`research_start` command streaming `ResearchEvent` through `emitStream`; plan approval as a round-trip like the brief handler.

### P2.8 `rune -P --stream-json` (half a day)

`headless.ts` emits every event as NDJSON on stdout when `--stream-json` is set; the final envelope is the last line. Exit codes unchanged.

### P2.9 `@rune/sdk` seed (half a day)

`HostClient` over WS with the typed protocol, exported from `packages/protocol` (or a new `packages/sdk`). One example in the README: connect, create session, run a prompt, answer a permission.

## Gate

```bash
bun test tests/unit/protocol/ tests/integration/engine-serve.test.ts
# engine-serve.test.ts: WS client with token → create_session → chat_start with a prompt that triggers
#   a permission, an ask_user and a deferral → answers all three over the wire → turn_complete;
#   second client subscribes mid-turn and receives backfill + live events;
#   unauthenticated connection refused; Origin mismatch refused.
grep -rn "bin/ui" packages/orchestrator/src --include=*.ts | grep -v "^packages/orchestrator/src/bin" | wc -l   # 0
bun run --cwd apps/desktop typecheck      # builds against @rune/protocol, types.ts duplicate gone
rune -P --stream-json "say ok" | head -3  # NDJSON events
```

Done means: a non-terminal client can do everything the TUI can, over a socket, with auth, and drift between clients is a type error.
