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
