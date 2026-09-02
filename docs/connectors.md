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

| | |
|---|---|
| MCP tools (`mcp_*`) | deferred — this is the unbounded set |
| `n8n_trigger` | deferred — opt-in integration, rarely reached |
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

| Step | Spec |
|---|---|
| `401` + `WWW-Authenticate: Bearer resource_metadata=…` | MCP auth spec |
| `/.well-known/oauth-protected-resource` | RFC 9728 |
| `/.well-known/oauth-authorization-server` (OIDC discovery as fallback) | RFC 8414 |
| dynamic client registration | RFC 7591 |
| PKCE S256 (required — `plain` is refused, not downgraded to) | RFC 7636 |
| resource indicator, so the token is audience-bound to that one server | RFC 8707 |

The redirect is captured on an ephemeral `127.0.0.1` loopback — the same engine
`gear login` uses for Anthropic, Codex, OpenRouter and Copilot.

**Where tokens live.** Under `mcp:<server>` in the OS credential store: macOS
Keychain, libsecret on Linux, DPAPI on Windows, and a `0600` file only when
none of those is reachable (Gear says so when it falls back).

**When a token expires.** The transport refreshes and retries once, silently.
You do not see it.

**When a refresh fails.** The *connector* becomes unavailable — never the
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

| | |
|---|---|
| `~/.gear/mcp.json` | user — connectors you have everywhere |
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
