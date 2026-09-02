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
