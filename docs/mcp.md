# MCP quickstart

Rune talks to outside services over the
[Model Context Protocol](https://modelcontextprotocol.io). A connector is an MCP
server — a local subprocess over stdio, or a remote HTTP endpoint — and its
tools become tools the agent can call.

This page gets one running. For deferred tool loading, the OAuth flow, the event
stream, scopes, plugins and the rest of the protocol surface, see
[connectors.md](./connectors.md).

**Every config below says whether it has been run against the real thing.**
Rune's MCP client is four thousand lines and was, until 2026-09-08, tested only
against mocks this repository also wrote. What has since been driven live is
recorded in [evidence/mcp-live-20260908.md](./evidence/mcp-live-20260908.md);
what has not is marked unverified here rather than quietly implied to work.

---

## In one minute

```bash
rune mcp add "npx -y @modelcontextprotocol/server-filesystem ." --name files
rune mcp doctor          # did it start? how many tools? what is wrong?
rune                     # then /mcp in the session
```

`rune mcp add` writes the entry; nothing else is needed. Config lives in two
files, both with the same shape:

|                              |                                           |
| ---------------------------- | ----------------------------------------- |
| `~/.rune/mcp.json`           | user — connectors you have everywhere     |
| `<workspace>/.rune/mcp.json` | workspace — connectors this project needs |

Workspace wins on a name collision.

---

## Three configs

### 1. Filesystem — **verified live**

A local directory as a set of tools: read, write, search, tree. Free, no
account, no token.

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/project"]
    }
  }
}
```

Verified on 2026-09-08 against `secure-filesystem-server` 0.2.0 over stdio,
protocol `2025-06-18`: 14 tools listed, `list_directory` and `read_text_file`
called and answered, and a read of `/etc/passwd` refused as an error result
without taking the connector down.

**Use an absolute path, and check it.** The path is the one thing here that is
easy to get wrong and silent when you do — the server exits and all you see is
that a process exited. `rune mcp doctor` checks it for you before spawning
anything, and suggests the directory you probably meant.

Two more that need nothing but `npx`, both verified the same day:

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything", "stdio"]
    }
  }
}
```

`server-everything` is the protocol's own reference server — resources, prompts,
progress notifications, images, structured content. It is the fastest way to see
what a rich connector looks like inside Rune.

### 2. GitHub — **unverified: needs a token**

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "autoApprove": ["search_repositories", "get_file_contents"]
    }
  }
}
```

Then `export GITHUB_TOKEN=ghp_…` before starting Rune. `${VAR}` is expanded from
the environment at discovery; an unset one is warned about rather than sent as
an empty header, because a silently-empty `Authorization` is worse than a loud
failure.

**Not verified.** There is no valid GitHub token on the machine this was written
on, so this config has never been run end to end. The shape is the standard one
the server documents and the `${VAR}` expansion and `autoApprove` handling are
both covered by unit tests — but nobody here has watched it list a repository.
Treat it as a starting point, and tell us if it needs a change.

`autoApprove` takes `true` (everything) or a list of tool names. A tool the
server annotates `destructiveHint` is **always** confirmed regardless — an
auto-approve list written before a server added a delete tool must not silently
cover it.

### 3. A remote OAuth vendor — **unverified: no credentials**

```json
{
  "mcpServers": {
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp",
      "oauth": {}
    }
  }
}
```

```bash
rune mcp add notion      # resolves the URL from the bundled catalog
rune mcp login notion    # browser, PKCE, token to the OS keychain
```

`"oauth": {}` is the normal case: client registration, scopes and endpoints are
all discovered from the server's own metadata. A `clientId` is only needed when
the authorization server offers no dynamic registration.

**Not verified against any real vendor.** The OAuth 2.1 path — discovery,
dynamic client registration, PKCE, the loopback redirect, refresh, and the 401
retry — is exercised end to end by
`tests/integration/mcp-cli-oauth.test.ts` against a local OAuth-protected MCP
server, and by unit tests. No account credentials exist on this machine, so no
vendor has ever answered it. That is the largest untested surface in the
connector stack and it is stated here rather than buried.

---

## Seeing what is going on

**`/mcp`** in a session — connectors, health, dialect, tool count, and the
command that fixes each one that is not up:

```
  MCP connectors  2/3 connected · 23 tools
    ◇ files  connected · stdio · 14 tools
    ◇ memory  connected · stdio · 9 tools
    ◇ notion  needs login · http · 0 tools
      MCP HTTP 401 unauthorized
      fix  rune mcp login notion
    reconnect one  /mcp reconnect <server>
```

Tool names are deliberately not listed — a forty-tool connector turned `/mcp`
into a wall the four facts above had to be hunted out of.

`/mcp reconnect <server>` re-handshakes one connector without restarting the
session — including one that never came up, so a fixed path in `mcp.json` takes
effect immediately.

Health words mean what they say: **connected** (handshake done, pings
answering), **degraded** (up, but pings are failing), **connecting** (still
handshaking — not a problem yet), **needs login** (401, and a token would fix
it), **down** (there is a reason, and it is printed underneath).

**`rune mcp doctor`** is the headless version. It checks the config first —
without spawning anything — then starts every connector and reports real health,
exiting non-zero when any of them needs attention:

```
    Connectors
      files            up 14 tools · stdio · 2025-06-18
      typo             misconfigured — /Users/you/Projects/thing does not exist
        fix: did you mean /Users/you/Project/thing
```

**`rune doctor`** carries one MCP line, and never starts a server:

```
  ✓ mcp: 3 connectors configured, none misconfigured — live health: rune mcp doctor
```

---

## Transports

You configure a URL or a command. Which protocol dialect a remote server speaks
is Rune's problem, not yours.

| Dialect                       | When                                  | Verified live |
| ----------------------------- | ------------------------------------- | ------------- |
| stdio                         | `command` is set                      | yes           |
| Streamable HTTP (2025-03-26+) | `url` is set — tried first            | yes           |
| SSE pair (2024-11-05)         | the URL answers 404/405/406 to a POST | yes           |

The fallback is automatic and reported: `/mcp` and `rune mcp doctor` print the
dialect actually in use, so a connector quietly running on the older protocol is
visible rather than inferred.

---

## When it does not work

1. **`rune mcp doctor`** first. A misconfigured entry is named before anything is
   spawned, with the corrected path or the missing command.
2. **Absolute paths.** `.` in `args` resolves against the server's working
   directory, not yours. `rune mcp add` writes what you typed.
3. **`npx` on PATH.** Every server above is a Node package; the first run
   downloads it and needs the network.
4. **One connector never stops the others**, and never stops the session. An
   unavailable one is reported to you in `/mcp`, and to the model once per
   session as "do not plan around these tools".
