# The Gear protocol

**`@gear/protocol` · PROTOCOL_VERSION 1.0.0**

One typed, versioned contract between the engine and every surface that drives
it: the terminal, the desktop, the web client, editors, CI and the SDK.

Two invariants hold this together, and both are enforced by tests rather than
by prose:

1. **No client duplicates the event union.** `AgentTurnEvent` and
   `ResearchEvent` are declared once, in `packages/protocol/src`. Everything
   else re-exports.
2. **No client reaches into engine internals.** A surface talks to the engine
   over this protocol or not at all. `grep -rn "bin/ui" packages/orchestrator/src
| grep -v "^packages/orchestrator/src/bin"` prints 0.

---

## Transports

The same frames serve over three transports. Only the framing differs.

| Transport   | Framing                            | Who uses it                           |
| ----------- | ---------------------------------- | ------------------------------------- |
| stdio       | one JSON object per line on stdout | the desktop sidecar (`engine-host`)   |
| unix socket | one JSON object per line           | `gear detach` / `gear attach`         |
| websocket   | one JSON object per message        | `gear serve`, the web client, the SDK |

Stream frames broadcast to every connected client; responses go only to the
client that asked. Dropping a client never stops the engine — that is the point
of socket mode, and `gear serve` keeps it.

## Envelope

Two dialects are read, and a response goes back in the dialect its request
arrived in. This is not indecision: a desktop binary already in someone's
Applications folder must keep working against a host it did not ship with.

**JSON-RPC 2.0** — what new clients speak:

```jsonc
--> {"jsonrpc":"2.0","id":1,"method":"chat_start","params":{"message":"hi"}}
<-- {"jsonrpc":"2.0","id":1,"result":{"sessionId":"s-abc"}}
<-- {"jsonrpc":"2.0","method":"stream.chat_event","params":{"sessionId":"s-abc","event":{"type":"text_delta","text":"Hel"}}}
<-- {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"missing bearer token"}}
```

**Legacy** — the sidecar contract, still served:

```jsonc
--> {"id":1,"cmd":"chat_start","args":{"message":"hi"}}
<-- {"id":1,"ok":true,"result":{"sessionId":"s-abc"}}
<-- {"stream":"chat_event","payload":{"type":"text_delta","text":"Hel"}}
```

Server pushes are JSON-RPC _notifications_ (no id, never answered) whose method
is `stream.<name>`.

### Error codes

Reserved JSON-RPC codes plus this protocol's own:

| Code   | Name                | Meaning                                           |
| ------ | ------------------- | ------------------------------------------------- |
| -32700 | parse               | the frame was not JSON                            |
| -32600 | invalidRequest      | not a request frame                               |
| -32601 | methodNotFound      | no such command in this build                     |
| -32602 | invalidParams       | a parameter was missing or the wrong shape        |
| -32603 | internal            | the command raised                                |
| -32000 | unauthorized        | bearer token missing, malformed or wrong          |
| -32001 | forbidden           | authenticated, but refused on this connection     |
| -32002 | unattended          | a pending round-trip expired or lost every client |
| -32003 | incompatibleVersion | the client speaks a different protocol major      |
| -32004 | busy                | a turn is already in flight on this session       |

### Versioning

`PROTOCOL_VERSION` moves only when the wire contract changes observably. A peer
on a different **major** is refused at the door. Minor and patch are additive by
construction: a newer host may emit members an older client ignores, which is
why every reducer in this repo has an explicit ignore branch instead of
throwing on the unknown.

`hello` is the handshake: send your version, get the host's back along with the
command list this build actually serves.

---

## Commands

Full argument and result types: `packages/protocol/src/commands.ts`. The
`HOST_COMMANDS` manifest is compile-guarded against the type map, so a command
that exists in one and not the other does not build.

**Handshake** — `hello`

**Sessions** — `get_status` · `create_session` · `list_sessions` ·
`resume_session` · `delete_session` · `subscribe`

**The turn** — `chat_start` · `abort_chat` · `interject_chat`

**The five round-trips** — `respond_permission` · `respond_question` ·
`respond_brief` · `list_held_steps` · `run_held_step` · `dismiss_held_steps`

**Model and providers** — `switch_model` · `list_providers` · `save_settings`

**Research** — `research_start` · `respond_research_plan`

**System memory** — `get_system_memory` · `save_system_memory` ·
`add_memory_note` · `set_memory_schedule` · `reflect_system_memory` ·
`clear_system_memory`

---

## Streams

| Stream                  | Payload                                       | Notes                               |
| ----------------------- | --------------------------------------------- | ----------------------------------- |
| `ready`                 | status + `protocolVersion`                    | one per connection                  |
| `engine_status`         | model, provider, context, cost, posture       |                                     |
| `chat_event`            | `{ sessionId?, event: AgentTurnEvent }`       | 22 members                          |
| `research_event`        | `{ sessionId?, runId, event: ResearchEvent }` | 9 members                           |
| `permission_request`    | `{ requestId, prompt }`                       | answer with `respond_permission`    |
| `question_request`      | `{ requestId, question }`                     | answer with `respond_question`      |
| `brief_request`         | `{ requestId, brief }`                        | answer with `respond_brief`         |
| `research_plan_request` | `{ requestId, plan }`                         | answer with `respond_research_plan` |
| `auto_notice`           | `{ notice }`                                  | push; nothing to answer             |
| `held_steps`            | `{ steps }`                                   | the end-of-turn ledger              |
| `roundtrip_resolved`    | `{ requestId, kind, reason, applied }`        | drop the card you are showing       |

### The five round-trips

Every human-in-the-loop path the engine has, held by any client — not just the
terminal. Before Phase 2 the host wired exactly one of them, so `ask_user`
failed with "No interactive user is available" for every desktop and detached
run, and held steps were invisible off-terminal.

Each pending round-trip has a **timeout** (default 10 minutes, configurable) and
is **rejected when the last client disconnects**. What the host substitutes is
stated, not implied:

| Round-trip        | Unattended outcome          | Why                                                                                                                      |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| permission        | `deny`                      | the alternative is silently granting whatever a model asked for to a process nobody is watching                          |
| `ask_user`        | the "no answer" instruction | the model proceeds on its best judgment and states the assumption, instead of stalling on an answer that is never coming |
| brief (read-back) | accepted as stated          | the read-back is a chance to correct a reading, not a gate; refusing it would stop work that was never in doubt          |
| held step         | stays in the ledger, unrun  | a deferral exists precisely because it must not happen without a human                                                   |

When one resolves this way the host emits `roundtrip_resolved`, so a client
never leaves a card on screen offering a decision the host has already made.

Held steps are referred to by **id**, never by args: the arguments of a
declined call are raw and unredacted and stay in-process. Every displayed form
uses `summary`, which is bounded and secret-scrubbed.

---

## Replay and subscribe

`subscribe(sessionId, sinceSeq)` backfills from the session store, then streams
live. The result carries `settled: true` and a `seq` to resume from.

`text_delta` is never persisted, so a reconnecting client receives the
assistant's text **as settled state**, not as a keystroke-accurate replay. The
flag says so explicitly rather than letting a client mis-assemble a stream it
only half-received. Run-level events that have no row of their own (`usage`,
`fallback`, `retry`, `verification_*`, `handoff`, `step_check`,
`checkpoint_saved`) are persisted as a compact `run_trace` event.

The host also keeps a bounded per-session ring buffer of recent live frames, so
a client reconnecting mid-turn sees the tool call that is running right now and
not only the last thing written to the database.

---

## Auth

`gear serve` binds **loopback only** by default.

- A **bearer token** is minted to `~/.gear/serve.json` (0600) and is required on
  every connection. Send it as `Authorization: Bearer <token>`, as the
  `Sec-WebSocket-Protocol` value `gear.bearer.<token>`, or as `?token=`.
  Comparison is constant-time.
- An **Origin allowlist** is enforced. A browser origin that is not on it is
  refused, which is what stops a page you happen to have open from driving your
  agent.
- `--host 0.0.0.0` is opt-in and prints a warning naming what is now reachable.
- `save_settings`, login and key writes are **refused over non-loopback**
  unless the token was minted with `--allow-remote-settings`. Before Phase 2
  any client that could open the socket could call `save_settings`, which
  writes API keys.

Shutdown is graceful and leaves running session hosts alive, exactly as
`gear detach` does.

---

## `gear web` — the same client, in a browser

`gear web` is `gear serve` that also hands out the page. One process, one port,
one token.

```bash
gear web --port 7788          # loopback; open http://127.0.0.1:7788
gear web --host 0.0.0.0       # a phone on the LAN; the printed URL carries ?token=
```

One port, because a page on 7788 opening a socket on 4762 is a cross-origin
request the Origin allowlist would have to be widened for, and widening a
security allowlist to accommodate your own layout is how these things stop
protecting anything.

The token is embedded in the first page load — `window.__GEAR_SERVE__` — rather
than typed into a form. Asking a person to paste a 43-character secret into a
page the server just minted it for is theatre. The rule that keeps that honest:

| Request comes from | Gets the page with the token |
| ------------------ | ---------------------------- |
| loopback           | yes — the same user can already read `~/.gear/serve.json` |
| anywhere else      | only if the request already carries the token |

So `gear web --host` prints a URL with `?token=` in it, and a stranger on the
LAN who guesses the port gets a 401 that says why.

The client is the desktop bundle (`apps/desktop`), unchanged: the only
difference is which transport `apps/desktop/src/lib/transport.ts` picks. That is
what makes the web client free rather than a second application to maintain.

`tests/e2e` is the browser smoke — the only place Playwright is a dependency. It
stands up a fake OpenAI-compatible model, runs `gear web` against it in a temp
home, and drives the whole path in Chromium: prompt → permission card (asserted
inline, with no `[role=dialog]` on screen) → answer → the tool output in the
transcript → spans in the trace rail → export.

## Sub-agent events

A sub-agent runs the same loop the lead does and produces the same union. That
was flattened to a string at the tool boundary (`onProgress: (note: string)`),
so the fleet panel rendered parsed prose and anything the projection did not
think to include — a retry, a verification result, a handoff inside a worker —
did not exist upstream at all.

`tool_progress` now carries the child event under `child`:

```ts
{ type: "tool_progress", callId, note, state?, ok?, child?: { agentId, label?, event } }
```

`note` is a PROJECTION of `child.event` (`projectChildEvent`), so a surface that
wants only a one-line heartbeat never has to reduce a second union, and one that
wants the truth has it. The projection is exhaustive against the union, and
deliberately silent on the members that would strobe a one-line rung: token
deltas, usage, and a nested `tool_progress` (already a projection — re-projecting
it would put a sub-agent's sub-agent on the lead's status line).

Recursion stops at one level, which is what keeps the frame bounded.

## `gear -P --stream-json`

Every event as NDJSON on stdout, one JSON object per line, the envelope LAST:

```bash
gear -P "say ok" --stream-json
{"type":"text_delta","text":"ok"}
{"type":"usage","inputTokens":0,"outputTokens":0,...}
{"type":"turn_complete","stopReason":"end_turn","totalTurns":1}
{"ok":true,"text":"ok","toolCalls":0,...}
```

The envelope is compact in this mode and only in this mode: `--json` on its own
keeps the indented form a person reads, but a pretty-printed record spread over
eighteen lines is not NDJSON and a line-by-line consumer would choke on it.

Exit codes are unchanged: `0` ok, `1` failed, `3` needed permission and had
nobody to ask.

## The SDK

`@gear/sdk` is `GearClient` over a WebSocket with this protocol, re-exporting
the whole of `@gear/protocol` so a consumer installs one package. The
round-trips are first-class: register a handler and the client answers for you;
leave one unset and the host applies the unattended policy above.

See `packages/sdk/README.md` for the worked example — it is executed by
`tests/integration/engine-serve.test.ts`, so it cannot rot silently.

## Exhaustiveness — the drift law

`AgentTurnEvent` has 22 members and is consumed by five reducers: the TUI
transcript, the TUI formatter, the headless runner, the desktop transcript and
the desktop trace rail.

Adding a member is a **compile error** in every one of them until each names it,
because each ends in `assertNever`. A reducer that legitimately ignores a member
must say so in a `case` of its own — "ignored" is a decision on the record, not
the absence of one.

`tests/unit/protocol/exhaustiveness.test.ts` is the second layer: it reads each
reducer's source and asserts every manifest member appears as a `case` label,
which catches the one thing the compiler cannot — a reducer that widens its
parameter back to `any` or re-adds a bare `default`.
