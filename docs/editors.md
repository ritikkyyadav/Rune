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

| Gear                                                | ACP                                                     |
| --------------------------------------------------- | ------------------------------------------------------- |
| `text_delta`                                        | `agent_message_chunk`                                   |
| `thinking_delta`                                    | `agent_thought_chunk`                                   |
| `tool_call_start`                                   | `tool_call` (with a `kind`, so shells look like shells) |
| `tool_call_end`                                     | `tool_call_update`, `completed` or `failed`             |
| `todo_updated`                                      | `plan`                                                  |
| permission request                                  | `session/request_permission`                            |
| `turn_complete`                                     | the `session/prompt` result                             |
| usage · retry · fallback · compaction · checkpoints | **nothing** — see below                                 |

That last row is a decision, not a gap. ACP v1 has five update kinds and Gear's
turn union has twenty-two; the members left out are harness bookkeeping, and an
editor that rendered them would show a person a stream of things they cannot
act on. `gear audit <sessionId>` is where that record lives, and it is complete.

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

Zed cannot be driven from CI, so the harness is the gate:

```bash
bun test tests/integration/acp.test.ts
```

It spawns `gear acp`, speaks JSON-RPC over its stdio as a client, and walks the
whole path — `initialize` → `session/new` → `session/prompt` → a permission
request it answers → completion — against a fake model with everything else
real. The client in that file is hand-written against the ACP shapes rather than
built on a Gear type, deliberately: a test that shares its types with the thing
under test can only catch inconsistency, never a wrong mapping.

**Not verified inside Zed on this machine.** The settings snippet above is
written from the ACP contract, not from a session someone ran; the first person
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
