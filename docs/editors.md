# Gear in your editor

Two ways in, and they are different in kind.

- **ACP** (`gear acp`) — Zed and anything else that speaks the Agent Client
  Protocol spawns Gear and talks JSON-RPC over its stdio. The editor draws the
  conversation, the tool calls and the permission dialogs in its own UI.
- **VS Code** (`apps/vscode`) — a thin extension that hosts the `gear web`
  bundle in a webview. The UI is Gear's, including the trace rail, and the
  extension supplies the editor bindings around it.

---

## Zed, through ACP

`gear acp` is an Agent Client Protocol server on stdio. It is a translation
layer, not a second engine: underneath it is the same supervisor `gear serve`
is — one `engine-host` process per session, spoken to over the Gear protocol.

Add this to Zed's `settings.json`:

```jsonc
{
  "agent_servers": {
    "Gear": {
      "command": "gear",
      "args": ["acp"],
      "env": {},
    },
  },
}
```

From a source checkout, before `scripts/install.sh` has put `gear` on the path:

```jsonc
{
  "agent_servers": {
    "Gear": {
      "command": "bun",
      "args": ["/path/to/Alan/packages/orchestrator/src/bin/gear-cli.ts", "acp"],
      "env": {
        "GEAR_TOOLS_BIN": "/path/to/Alan/target/release/gear-tools",
      },
    },
  },
}
```

Then open the agent panel and pick **Gear**. There is nothing to authenticate:
Gear holds its own provider credentials (`gear login`), so `authMethods` is
empty and the editor never sees a key.

### What the editor gets

**Methods.** `gear acp` implements six of ACP's agent-side methods and none of
the optional ones:

| ACP method               | Implemented | Notes                                                                                                             |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `initialize`             | yes         | answers protocol version 1, `authMethods: []` (Gear holds its own provider credentials)                           |
| `authenticate`           | yes, no-op  | there is nothing for an editor to authenticate                                                                    |
| `session/new`            | yes         | one `engine-host` process per session                                                                             |
| `session/prompt`         | yes         | resolves on `turn_complete`; text and `resource` blocks are read, image and audio are not                         |
| `session/cancel`         | yes         | aborts the turn; the pending prompt answers `stopReason: "cancelled"`                                             |
| `session/load`           | **no**      | `loadSession: false` is declared rather than half-implemented — Gear's `subscribe` replay is not ACP's contract   |
| `session/list`·`/delete` | no          | not advertised                                                                                                    |
| `session/set_mode`       | no          | gears are set in Gear, not per-turn by the editor                                                                 |
| terminals · `fs/*`       | no          | Gear runs its own tools through `gear-tools` and its own sandbox; it does not ask the editor to run things for it |

Client-side, it calls exactly one: **`session/request_permission`** — for a
permission, and for an `ask_user` that has options (see below).

**Events.** All 22 members of `AgentTurnEvent`, and what an editor receives for
each. `tests/unit/orchestrator/acp-mapping.test.ts` asserts this table row by
row and fails if a member is added without a decision.

| Gear event               | ACP update                  | Why                                                                                                                                            |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_delta`             | `agent_message_chunk`       |                                                                                                                                                |
| `thinking_delta`         | `agent_thought_chunk`       |                                                                                                                                                |
| `tool_call_start`        | `tool_call`                 | with a `kind`, so shells look like shells                                                                                                      |
| `tool_call_end`          | `tool_call_update`          | `completed` or `failed`, with the result as a content block                                                                                    |
| `todo_updated`           | `plan`                      | entries keep Gear's status; ACP has no notion of the evidence behind one                                                                       |
| `error`                  | `agent_message_chunk`       | in the transcript, not a thought: it is addressed to the person                                                                                |
| `notice`                 | `agent_thought_chunk`       |                                                                                                                                                |
| `context_warning`        | `agent_thought_chunk`       |                                                                                                                                                |
| `verification_started`   | `agent_thought_chunk`       | with the attempt number                                                                                                                        |
| `verification_completed` | `agent_thought_chunk`       | **with the verdict** — an editor told only "verification completed" reads as reassurance for a run that failed                                 |
| `step_check`             | `agent_thought_chunk`       | passed / FAILED / skipped, with the step                                                                                                       |
| `replanning`             | `agent_thought_chunk`       | with the trigger and reason                                                                                                                    |
| `handoff`                | `agent_thought_chunk`       | with the state of work, which is the entire content of the event                                                                               |
| `turn_complete`          | the `session/prompt` result | it ends the prompt rather than being an update within it                                                                                       |
| `tool_call_args_delta`   | **dropped**                 | ACP carries `rawInput` as a whole value; a partial-JSON fragment would give the editor a `rawInput` that does not parse                        |
| `stream_reset`           | **dropped**                 | it means "retract what you drew". ACP chunks are append-only and there is no retraction — see the known gap below                              |
| `fallback`               | **dropped**                 | which provider served the tokens is bookkeeping; `gear audit` has it                                                                           |
| `retry`                  | **dropped**                 | same, and a backoff an editor cannot act on                                                                                                    |
| `usage`                  | **dropped**                 | ACP v1 does have `usage_update` now — see the known gap below                                                                                  |
| `compaction`             | **dropped**                 | ACP's `compaction_update` is marked UNSTABLE and may only be sent to a client that advertised `session.compaction`; Gear does not negotiate it |
| `checkpoint_saved`       | **dropped**                 | harness bookkeeping                                                                                                                            |
| `tool_progress`          | **dropped**                 | a sub-agent heartbeat; ACP has no shape for a nested agent, and the terminal draws it on a status rung, not the transcript                     |

Also arriving from the engine and **not** in that union: `held_steps` becomes a
message (below), `auto_notice` and `roundtrip_resolved` become thought chunks,
and `ready` · `engine_status` · `research_event` · `research_plan_request` have
nothing in ACP v1 to carry them.

`gear audit <sessionId>` is where the complete record lives, including every
row marked dropped.

**Two known gaps, stated rather than implied.**

- **`usage`.** When this mapping was written ACP v1 had five update kinds; it
  now has fifteen, and one of them is a stable `usage_update` (`used`, `size`,
  optional `cost`) that Gear's `usage` event could fill. It is not sent yet:
  an update kind an older client does not know fails the whole notification in
  a schema-validating client, and there is no Zed here to try it against.
- **`stream_reset`.** When a provider stream is abandoned mid-response and
  re-streamed, the terminal drops the partial text. An ACP client cannot: there
  is no way to un-send an `agent_message_chunk`, so a Zed transcript will show
  the abandoned prose followed by the re-streamed prose.

Both are in `docs/program/backlog.md`.

### The permission dialog is the point

The agent stops, Zed shows the request with the tool, its arguments and the
options, and the person answers **in the editor**. Without it an editor
integration would have to run Gear in 4th gear to get anything done, which is
the opposite of what an editor integration is for.

A **cancelled dialog is a deny.** So is a closed editor, and so is an answer
this build does not recognise. That is the same rule the host applies when
nobody is attached at all, and the alternative is reading silence as consent.
`tests/integration/acp.test.ts` asserts it.

### `ask_user` has no ACP primitive

ACP v1 gives an agent no way to ask a free-text question, so:

- **A question with options** is offered as a permission request whose options
  are the answers. The person is genuinely choosing, which is what the
  round-trip is for.
- **A question with no options** is answered immediately with the host's
  documented "no answer" instruction — the model proceeds on its best judgment
  and states the assumption — rather than stalling the editor for ten minutes
  on a dialog that cannot be drawn.

Both are announced in the transcript, so what was asked and what was assumed are
visible rather than inferred.

The **read-back** (`brief_request`) is accepted as stated and shown as a thought
chunk. That is already the host's unattended policy for a brief, so applying it
at once costs nothing and saves a stall; a person who disagrees says so in the
next message, which is what a read-back is for.

**Held steps** arrive as a message listing what Auto mode declined to run
unattended. They stay unrun. Approving one is `gear` work today — the ledger is
in the terminal, the desktop and the web client — because ACP has no shape for
"a decision that outlived the turn".

### Verifying it without Zed

Zed cannot be driven from CI, so two suites are the gate — and they are gates of
different kinds.

```bash
bun test tests/integration/acp-conformance.test.ts   # the protocol's own client
bun test tests/integration/acp.test.ts               # Gear's policy, by hand
```

**`acp-conformance.test.ts` drives `gear acp` with the reference client** from
the Agent Client Protocol project — `@agentclientprotocol/sdk`, Apache-2.0,
published by the same people who write the specification. That client parses
every inbound frame through the schema generated from the protocol's own JSON
Schema, so a `session/update` whose shape Gear invented is a validation failure
rather than a blob some editor might have rendered. It walks `initialize` →
`session/new` → `session/prompt` → a `session/request_permission` it answers →
`stopReason`, then cancels a turn mid-permission, then runs two sessions on one
agent process and checks the updates for each are routed to that session's id.

It caught one mapping bug on its first run: `todo_write` contains the word
"write", so `toolKind` classified every plan update as a file **edit**.

**`acp.test.ts` is still here and still hand-written**, because it asserts what
no third-party client knows to check: that a cancelled permission dialog is a
**deny**. A conformance client proves the shapes are the protocol's; only a test
that knows Gear's policy proves the policy.

**Still not verified inside Zed on this machine.** Two independent clients now
drive the server, but neither is an editor: the `settings.json` snippet above is
written from the ACP contract, not from a session someone ran. The first person
with Zed installed should confirm it and say so here.

---

## VS Code

See [`apps/vscode/README.md`](../apps/vscode/README.md). In short:

```
Gear: Open Panel                the web client in a webview
Gear: Send Selection to Gear    the selection, with its file and line range
Gear: Open Trace for This File  what this session did to the file you are on
Gear: Set Server Token          a token for a configured server, in SecretStorage
```

The extension starts `gear serve --web` on demand, attaches to a `gear serve`
already running on this machine, or uses the one at `gear.serverUrl`. The status
bar shows the gear and the session cost — and shows nothing where there is no
cost data, rather than `$0.00`.

The token is never a setting: settings sync between machines and get committed
in `.vscode/settings.json`, and this one is remote code execution with your
provider credentials attached. It reaches the page in the URL fragment, and the
webview's CSP narrows `frame-src` to the single origin being framed.

It is **not published to the marketplace** — that is a founder action under D1.
Build the `.vsix` and install it by hand:

```bash
bun install
bun run --cwd apps/vscode package      # produces gear-<version>.vsix
code --install-extension apps/vscode/gear-0.3.0.vsix
```

**Not verified inside VS Code on this machine** either: the extension
typechecks, bundles, packages and its logic is unit-tested, but nobody has
loaded the .vsix in a running editor here.

## JetBrains

Deferred. The program says so (`docs/program/00-program.md` §7): JetBrains is a
third UI toolkit for a surface two others already cover, and ACP is the cheaper
answer if a JetBrains ACP client appears.
