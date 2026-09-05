# Phase 4 — Connect anything

**Lane C · 12–16 days · P4.1 must land before P4.3**

## Goal

`rune mcp add notion` authenticates in the browser and the next session can call Notion. A 40-tool server does not cost 40 schemas per request. A third party can publish a plugin and a user can install it from a URL.

## Evidence (2026-09-02)

- Transports: stdio (`tool-registry/src/mcp/transport.ts:25-202`) and streamable HTTP (`:216-345`, POST + SSE parsing, session id, `MCP-Protocol-Version`, DELETE teardown). No legacy SSE transport; no GET server→client stream.
- Auth: static headers with `${ENV}` interpolation only (`discovery.ts:62-78`). A 401/403 becomes a thrown string (`transport.ts:263-269`): no `WWW-Authenticate` parsing, no `/.well-known/oauth-protected-resource`, no dynamic client registration, no token store, no refresh. Every remote connector in the vendored catalog (`skills/*/.mcp.json`: Notion, Slack, Linear, Atlassian, GitHub, PagerDuty, Datadog, gcal, gmail) is OAuth-protected and therefore cannot connect.
- A complete OAuth 2.1 engine exists and is unused here: `packages/llm-gateway/src/auth/oauth-strategy.ts` (`OAuthFlow` `:52-88`, `generatePkce` `:24`, loopback capture `:105+`), used by Anthropic, Codex, OpenRouter, Copilot. Token vault: `packages/shared/src/credential-store.ts:31` (Keychain / libsecret / DPAPI, 0600 fallback).
- Only `tools/list`, `tools/call`, `ping`, `initialize` are spoken (`types.ts:113-125`). Resources, prompts, elicitation, sampling, roots, completions: absent (`client.ts:290-301` answers `-32601`; `capabilities: {}` at `:178`). Server `instructions` are typed (`types.ts:78`) and discarded. Tool `annotations` are typed and unused for permissioning (permission is binary `autoApprove`, `client.ts:649`). Argument validation is `required`-presence only (`client.ts:579`).
- Config is `.rune/mcp.json` in the workspace (`discovery.ts:120`); no user scope; no `[mcp]` section in `RuneConfig` (`packages/shared/src/config.ts:8-470`). No `rune mcp` command; `/mcp` is read-only and tells the user to hand-edit the file (`rune-cli.ts:1960-1985`).
- Failures are silent under the TUI: `McpClient` emits a typed `McpEvent` stream (`types.ts:89-102`) that the engine never subscribes to (`engine.ts:1687-1693` passes no `onEvent`), and `logger.ts:101` suppresses stderr while `RUNE_TUI_ACTIVE=1`. The model is told nothing when a server is down.
- No deferred tool loading: `toLlmTools` (`registry.ts:86-100`) ships every schema every request; doctrine JIT exists only for prose (`config.ts:47`, `engine.ts:4640-4663`). `prompts.ts:207-222` measures the fixed overhead at 14,617 tokens.
- `custom-loader.ts` (210 lines) is dead code: exported, tested, never instantiated. `plugins.ts` supports `.rune/plugins/<name>/plugin.json` with hooks, mcp, commands, auto-discovered skills; no install command; `PluginDiscovery.errors` (`plugins.ts:52-54`) are never displayed; no `runeVersion`, permissions or integrity fields.
- `ast_query` (`tools/ast-query.ts`) is regex tables, subsumed by `symbol_search` + `grep` + `lsp`, and still costs schema tokens every request.

## Work items

### P4.1 Deferred tool loading (2 days)

- The prompt carries a tool catalog (name + one line) for deferred tools; a `load_tools` (or `tool_search`) built-in returns full schemas on demand and registers them for the rest of the run. MCP tools deferred by default; built-ins stay eager except `ast_query` (retired) and `n8n_trigger`.
- `rune audit` reports schema tokens per request before/after; target ≥ 40% reduction on a session with two connectors.

### P4.2 OAuth 2.1 for MCP (3 days)

In `HttpTransport` (`transport.ts:246-269`): on 401 parse `WWW-Authenticate`; fetch protected-resource metadata and authorization-server metadata; dynamic client registration when offered; PKCE S256; loopback capture via the existing engine; tokens stored under `mcp:<server>` in the credential store; refresh on expiry; on refresh failure emit `server-needs-auth` and mark the server's tools unavailable rather than failing the session. `rune mcp login <server>` runs the flow explicitly; `rune login` learns about connectors.

### P4.3 `rune mcp` (2 days)

`add <name|url|command> [--scope user|workspace] [--header K=V] [--env K]`, `remove`, `list` (with auth and health status), `login`, `logout`, `enable`, `disable`, `doctor`. Catalog resolver: the 20 vendored `skills/*/.mcp.json` entries indexed at load, plus the public MCP registry when reachable; `rune mcp add notion` resolves name → URL → auth mode. User scope `~/.rune/mcp.json`; workspace wins on collision. Optional typed `[mcp]` section for defaults (timeouts, default scope).

### P4.4 MCP client completeness (2.5 days)

Legacy SSE transport (2024-11-05) for older servers; GET server→client stream; `resources/list|read|subscribe` exposed as a `read_resource` tool and as `@server:uri` mentions in the composer; `prompts/list|get` exposed as slash commands; elicitation mapped to the `ask_user` round-trip through the protocol; server `instructions` injected once per session; tool `annotations.readOnlyHint` → read category (parallel-safe, auto in rune ≥2) and `destructiveHint` → classifier tier; argument validation against `inputSchema` (types, enums, formats).

### P4.5 Failure surfacing (1 day)

Pass `onEvent` at `engine.ts:1687`; render `server-ready/down/restarted/needs-auth/tools-changed` in the TUI status line and the desktop sidebar badge; one harness note to the model when a server it was told about is unavailable ("connector notion is unavailable: needs login"), never repeated within a session. `rune mcp doctor` prints the same.

### P4.6 Plugins (2.5 days, per D6)

- `PluginManifest` gains `runeVersion` (semver range), `permissions` (declared hosts, path scopes, whether hooks may block), `integrity` (sha256 of the tree), `source`. Unify discovery: hooks, mcp, commands, skills all by convention with optional declaration.
- `rune plugin add <npm|git|path>`, `remove`, `list`, `enable`, `disable`; verify integrity; print `PluginDiscovery.errors`; `invalidatePlugins()` clears the four one-shot latches (`engine.ts:1629, 1650, 1669, 1735`) and reruns discovery without restart.
- v1 plugins are declarative: skills, commands, MCP servers, hooks. Executable tools stay first-party; `custom-loader.ts` is wired only for `.rune/tools` in the user's own workspace, behind `[extensions] localTools = true`, or deleted if D6 says so.

### P4.7 Housekeeping (half a day)

Retire `ast_query`; keep `n8n_trigger` gated; `client.ts:203` `declaredOtherCaps` no longer skips tool discovery for servers that also declare resources/prompts.

## Gate

```bash
bun test tests/unit/tools/mcp* tests/unit/orchestrator/plugins*
rune mcp add notion && rune mcp login notion     # browser OAuth completes, token in the credential store
rune -P --stream-json "list my three most recent Notion pages" | grep '"tool_call_start".*mcp_notion'   # live, behind RUNE_LIVE_CONNECTOR_TEST=1
rune audit last | grep "schema tokens"           # per-request schema tokens reported; ≥40% lower than pre-P4.1 baseline with two connectors
rune plugin add https://github.com/<org>/<demo-plugin> && rune mcp list   # plugin contributes a skill and an MCP server
rune mcp doctor                                   # a stopped server shows as down in the TUI and the desktop
```

Done means: connecting a service is one command, a dead connector is visible, and adding connectors does not tax every request.
