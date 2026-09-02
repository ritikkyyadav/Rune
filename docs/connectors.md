# Connectors

Gear talks to outside services over the [Model Context Protocol](https://modelcontextprotocol.io).
A connector is an MCP server: a local subprocess (stdio) or a remote HTTP
endpoint. This page is what you need to connect one, what it costs, and what
happens when it breaks.

---

## Deferred tool loading

A connector is not free. Every tool it exposes ships its full JSON schema on
**every request** for the life of the session — connect two 20-tool servers and
you are paying for forty schemas per turn whether or not the run ever touches
one.

Gear defers them. A deferred tool is registered and callable; it is simply
advertised as one catalog line instead of a full schema:

```
load_tools — Load the full schemas for tools that are available but not yet
described in detail. Call this with the names you need BEFORE calling them; the
schemas stay loaded for the rest of the session. Tools you can load:

[notion]
  mcp_notion_search — Search the Notion workspace by text query
  mcp_notion_fetch  — Fetch a page or database by id
  …
```

The model calls `load_tools` with the names it wants, gets the full schemas
back, and those tools are advertised normally for the rest of the run — so the
second call to a loaded tool costs nothing extra.

**What defers, by default**

|                      |                                                                |
| -------------------- | -------------------------------------------------------------- |
| MCP tools (`mcp_*`)  | deferred — this is the unbounded set                           |
| `n8n_trigger`        | deferred — opt-in integration, rarely reached                  |
| every other built-in | eager — the core loop; a round-trip costs more than the schema |

Deferring `read_file` to save 200 tokens would buy an extra round-trip on nearly
every turn. The gate is deliberately on the set that grows without bound.

When nothing is deferred, `load_tools` is not advertised at all: a session with
no connectors pays nothing for the mechanism.

**Measured.** Two mock 20-tool servers, `tests/unit/tools/mcp-schema-tokens.test.ts`:

```
schema tokens: before=9601 after=968 reduction=89.9%
```

`gear audit` reports the same number for a real session:

```
  Schema tokens  968 per request · 12 advertised · 40 deferred · 89% below 9,601 eager
```

`null` is not zero: a session recorded before this landed has no
`tool_surface` event and the line is simply absent.

---

## Authentication (OAuth 2.1)

Every remote connector in the vendored catalog — Notion, Slack, Linear,
Atlassian, GitHub, PagerDuty, Datadog, Google Calendar, Gmail — is
OAuth-protected. Gear speaks the MCP authorization spec (2025-06-18) and the
RFCs it cites:

| Step                                                                   | Spec          |
| ---------------------------------------------------------------------- | ------------- |
| `401` + `WWW-Authenticate: Bearer resource_metadata=…`                 | MCP auth spec |
| `/.well-known/oauth-protected-resource`                                | RFC 9728      |
| `/.well-known/oauth-authorization-server` (OIDC discovery as fallback) | RFC 8414      |
| dynamic client registration                                            | RFC 7591      |
| PKCE S256 (required — `plain` is refused, not downgraded to)           | RFC 7636      |
| resource indicator, so the token is audience-bound to that one server  | RFC 8707      |

The redirect is captured on an ephemeral `127.0.0.1` loopback — the same engine
`gear login` uses for Anthropic, Codex, OpenRouter and Copilot.

**Where tokens live.** Under `mcp:<server>` in the OS credential store: macOS
Keychain, libsecret on Linux, DPAPI on Windows, and a `0600` file only when
none of those is reachable (Gear says so when it falls back).

**When a token expires.** The transport refreshes and retries once, silently.
You do not see it.

**When a refresh fails.** The _connector_ becomes unavailable — never the
session. Its tools stop being advertised, the status line shows it, `gear mcp
doctor` names it, and the model is told once. The rest of the run continues as
if the connector were simply absent. This is the case that used to take the
whole session down.

```
gear mcp login notion       # runs the flow
gear mcp logout notion      # forgets the token
```

**Opting out.** An entry that already carries its own `Authorization` header is
left alone — a hand-written `${TOKEN}` is an explicit choice and outranks a
discovered flow. `"oauth": { "enabled": false }` disables it outright, and
`"oauth": { "clientId": "…" }` supplies a pre-registered client for the
authorization servers that offer no dynamic registration.

**Proved against a real server.** `tests/helpers/mock-oauth-mcp-server.ts` is a
local OAuth-protected MCP server that verifies PKCE server-side and rejects a
reused code, a mismatched `redirect_uri` or a missing bearer the way a real one
does. `tests/unit/tools/mcp-oauth.test.ts` drives the whole flow against it with
the browser click replaced by a direct fetch of the authorization URL.

---

## `gear mcp`

```
gear mcp add <name|url|command> [--scope user|workspace] [--header K=V] [--env K=V] [--name N]
gear mcp remove <name> [--scope …]
gear mcp list [--catalog]
gear mcp login <name>
gear mcp logout <name>
gear mcp enable <name> / disable <name>
gear mcp doctor
```

No Engine boot and no provider validation — like `gear doctor`, this is instant.
`list` and `doctor` do start the servers, because reporting real health is their
whole job.

**Resolving a name.** `gear mcp add notion` consults two sources, in order:

1. The 20 vendored `skills/*/.mcp.json` files — 58 distinct connectors with the
   URLs each vendor publishes. This catalog was already in the repo and unused.
2. The public MCP registry, when it answers. Purely additive, and every failure
   is soft: offline, slow, or an unfamiliar shape all mean "the bundled catalog
   is what you get", never an error you have to work around.

The bundled catalog wins on a name collision — a registry entry that shadowed
`notion` with something else would be a supply-chain surprise.

An entry with no published endpoint (Snowflake, Databricks, Benchling in the
vendored files) is reported as such rather than written out as a broken server.

**Two scopes.**

|                              |                                           |
| ---------------------------- | ----------------------------------------- |
| `~/.gear/mcp.json`           | user — connectors you have everywhere     |
| `<workspace>/.gear/mcp.json` | workspace — connectors this project needs |

Workspace wins on collision, and `gear mcp list` says which file each entry came
from and whether it shadows the other. The narrower scope is the more deliberate
one.

**`disable` keeps the entry.** The point is to stop paying for a connector
without losing configuration that took a sign-in to produce.

**`remove` keeps the token.** Deleting a credential is not something a `remove`
should do silently; the command says the token is still there and names
`gear mcp logout`.

## `[mcp]` in config.toml

```toml
[mcp]
defaultScope = "workspace"   # where `gear mcp add` writes without --scope
timeoutSecs  = 30            # per-request tools/call timeout
registry     = true          # consult the public MCP registry when resolving
deferTools   = true          # false ships every schema on every request (pre-P4.1)
```

---

## When a connector breaks

The MCP client has always emitted a typed lifecycle stream. Nothing subscribed,
and `logger.ts` suppresses stderr while the TUI owns the screen — so a connector
that died was silent to the user _and_ to the model, which kept planning around
tools that were gone.

One event now has three consumers:

| Surface                 | What it shows                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| TUI status line         | a `notice`, through the same flow grammar every other harness message uses — no new dialect                                |
| `gear status` / desktop | `mcp.down` names each unusable connector and why (`needs-auth` or `down`), never a bare count                              |
| the model               | one harness note, **once per session**: "these connectors are configured but unavailable — do not plan around their tools" |

`gear mcp doctor` prints the same, plus the command that fixes each one.

The note is said once. Repeating it every turn would train the model to skim
harness notes, which costs more than the connector did.

Events: `server-ready`, `server-down`, `server-needs-auth`, `server-restarted`,
`tools-changed`. Per-call `progress` and `log` stay on the tool-progress channel
— repeating them in the status line would turn a signal into texture.

**One broken connector never stops the others**, and never stops the session.

---

## The rest of the protocol

Gear used to speak four methods: `initialize`, `tools/list`, `tools/call`,
`ping`. Everything else was answered `-32601`.

**Resources** — the documents, pages and records a server exposes read-only —
become two things:

```
read_resource                       one tool spanning EVERY connector
@notion:notion://page/abc123        a mention in the composer
```

One tool, not one per server: a user with four connectors gets one schema, not
four, and the model does not have to know which server owns a URI before it can
read anything. Called with no `uri` it lists what every connected service
exposes, so the model never has to guess a URI scheme it has not seen.

A `@server:uri` mention in a message is expanded into the resource before the
turn. An unknown mention stays literal text — an email address is not a
resource, and guessing would be worse than doing nothing.

**Prompts** become slash commands, `/server:prompt`. Positional arguments match
the prompt's declared argument names in order, `name=value` pairs are honoured,
and a trailing multi-word argument does not need quoting.

**Elicitation** — a server asking the _user_ for input mid-call — maps onto the
`ask_user` round-trip the harness already owns, so a connector's question lands
in the same picker as the agent's own. One question surface, not two. With no
handler wired (headless, CI) the connector is declined promptly rather than
blocked on a person who is not there. Gear declares the `elicitation` capability
on `initialize`, because a server reading an empty capabilities object never
asks and the feature is dead however well the handler works.

**Server instructions** were typed since the first handshake and thrown away
every time. A server saying "search before you delete" is telling the model
something no tool description carries; it is injected once per session.

**Annotations** shaped permission and category, which were previously binary:

| Hint              | Effect                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readOnlyHint`    | read category, parallel-safe, no prompt                                                                                                               |
| `destructiveHint` | write category, **always** confirms — even under `autoApprove`, because a list written before a server added a delete tool must not silently cover it |

**Argument validation** now runs against the full `inputSchema`: types, enums,
`required`, ranges, lengths, patterns, the common string formats, arrays, and
one level of nesting. A wrong type used to travel to the server, cost a round
trip, and come back as prose the model often could not act on. Caught locally it
is precise and free — and it names the parameter, what was expected, and (for a
hallucinated argument on a closed schema) what the real ones are. Anything the
validator does not understand is ignored rather than guessed at: the server is
still the authority, and rejecting a valid call is far worse than letting an
unusual one through.

**Transports.** Streamable HTTP (2025-06-18) with the optional `GET`
server→client stream, plus the legacy two-endpoint SSE transport (2024-11-05)
for older deployments. A server that offers no `GET` stream answers 405 and the
session carries on — that stream is additive.

---

## Plugins

A plugin is one installable bundle of the four extension kinds:

```
.gear/plugins/<name>/
  plugin.json          manifest
  skills/<s>/SKILL.md  auto-discovered, attributed to <name>
  mcp.json             connectors
  commands/<c>.md      slash commands
  hooks.json           hooks
```

```
gear plugin add ./my-plugin              a local path
gear plugin add https://github.com/…      a git repository
gear plugin add @scope/gear-plugin-x      an npm package
gear plugin list / remove / enable / disable
```

Plugins existed as this convention with no way to get a directory there, and
`PluginDiscovery.errors` were computed on every scan and shown nowhere — so an
installed-but-refused plugin looked exactly like one nobody had installed.
`gear plugin list` prints the refusals, and so does the status line.

**v1 plugins are declarative** (D6): skills, commands, MCP servers, hooks.
Nothing here installs executable tools. `npm` bundles are fetched with `npm
pack` and untarred, so no install script runs.

**The manifest gained four fields.**

| Field         | What it does                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gearVersion` | semver range; a plugin that does not fit is refused with a reason, rather than loaded and left to fail somewhere less legible. An unparseable range is treated as satisfied — our limitation should not become the author's problem                           |
| `permissions` | `hosts`, `paths`, `blockingHooks`. **Disclosure, not enforcement** — printed at install and in `list`, and said to be unenforced. Executable third-party tools stay out of v1 precisely because a declaration is not a sandbox                                |
| `integrity`   | `sha256` over the tree. A digest that no longer matches means the files changed since installation, and the plugin is refused: a plugin contributes hooks that run shell commands, and "probably fine" is not a standard to run someone else's commands under |
| `source`      | where it came from                                                                                                                                                                                                                                            |

`disable` keeps the bundle and stops its contributions. Because the manifest is
part of the hashed tree, toggling recomputes the digest.

**`invalidatePlugins()`** re-scans and re-runs all four loaders without a
restart — installing a plugin mid-session used to do nothing until the next
process, and nothing said so. All four latches clear together on purpose: a
plugin contributes across them, and a partial refresh leaves a bundle
half-installed, which is worse than not refreshing at all. MCP servers are
stopped rather than merely re-scanned, because their subprocesses and HTTP
sessions belong to the old plugin set.

## Local executable tools

`custom-loader.ts` was 210 lines of exported, tested, never-instantiated code.
It is wired now for exactly one case — **the user's own workspace**:

```toml
[extensions]
localTools = true   # load executable tools from <workspace>/.gear/tools
```

Off by default. A plugin can never point at it: a declaration is not a sandbox,
and running a stranger's code needs one.

---

## Housekeeping

**`ast_query` is retired.** It was regex tables pretending to be an AST query,
fully subsumed by `symbol_search` + `grep` + `lsp`, and it cost schema tokens on
every request to do worse than the tools beside it. Its row in the cost table
stays, so sessions recorded before the retirement still price their calls
instead of silently costing zero.

**`n8n_trigger` stays gated** — hidden entirely without `N8N_BASE_URL`, and a
catalog line rather than a schema when configured.

**`declaredOtherCaps` no longer skips tool discovery.** The handshake used to
skip `tools/list` whenever a server declared _any_ capability without a `tools`
key. A server advertising resources and prompts _and_ tools, in a shape we
mis-read, silently exposed nothing — the skip saved one request and cost the
entire point of the connection. Discovery is now always attempted; a server with
genuinely no tools answers with an empty list or a `-32601`, both of which were
already tolerated. (Landed with P4.4, where the handshake lives.)

**Deferral fails safe.** With no `load_tools` registered there is nothing that
could turn a catalog line back into a schema, so every tool is advertised in
full instead. Saving tokens is never worth making a registered tool unreachable.
