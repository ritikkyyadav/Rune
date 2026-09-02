# Bring Your Own Provider (BYOP) — authentication

Gear can authenticate a provider by any of four methods. The rest of Gear never
learns _how_ a provider signed in — it asks for an authenticated provider and
streams. This is an **authentication-layer** feature: no new LLM providers are
added, and existing API-key users see zero behavior change.

## Auth methods

| Method      | What it is                                                        | Providers                              |
| ----------- | ----------------------------------------------------------------- | -------------------------------------- |
| **api_key** | A bearer secret you paste or supply via env var (today's path).   | all cloud providers                    |
| **oauth**   | Browser authorization-code + PKCE (loopback redirect).            | OpenRouter, Anthropic, ChatGPT (Codex) |
| **device**  | OAuth device-code (headless / SSH-friendly).                      | GitHub Copilot                         |
| **local**   | A localhost runtime reached by URL — connectivity, no credential. | Ollama, LM Studio                      |

A provider declares its supported methods; when you don't choose one, Gear
auto-selects: the first method that has stored credentials, else the provider's
default (`api_key` for cloud, `local` for runtimes).

## Commands

```
gear login [provider]        Sign in. Picks a provider + method, runs the flow, stores the result.
                              Flags: --method api_key|oauth|device|local, --no-browser, --migrate
gear providers               List every provider, its auth method, and credential status.
gear use <provider> [model]  Set the active provider (+ model) for new sessions.
gear models [provider]       List a provider's models — live discovery, static fallback.
```

Examples:

```bash
gear login openrouter            # opens a browser, authorizes via OAuth (PKCE), stores the key
gear login anthropic             # prompts for an API key, stores it in your OS keychain
gear login openrouter --no-browser   # prints the URL to open manually (headless boxes)
gear providers                   # see who's signed in and how
gear use openrouter              # make OpenRouter the active provider
gear models openrouter           # live model catalog
```

## Where credentials live

Gear stores secrets in the best available OS-native store, chosen automatically:

1. **macOS** → Keychain (`security`)
2. **Linux** → Secret Service / libsecret (`secret-tool`)
3. **Windows** → DPAPI (per-user, via PowerShell)
4. **fallback** → `~/.gear/credentials.json`, mode `0600`, **plaintext**

When the plaintext fallback is in use (no OS keychain available), Gear prints a
one-line notice on every write and shows it in `gear providers`:

```
⚠ credentials stored unencrypted at ~/.gear/credentials.json (no OS keychain available)
```

The secure backends shell out to first-party OS tools rather than a native
module, so they work inside the single-file `bun build --compile` release binary
with no extra dependencies.

## OAuth (OpenRouter reference)

OpenRouter documents a PKCE flow that mints a normal API key:

1. `gear login openrouter` opens `https://openrouter.ai/auth?...&code_challenge=...`
2. You approve in the browser; OpenRouter redirects to a loopback URL on
   `127.0.0.1:<ephemeral>` that Gear is listening on.
3. Gear exchanges the code + PKCE verifier at `/api/v1/auth/keys` for a key and
   stores it.

Because the result is an ordinary key, it streams exactly like a pasted key and
never expires. Security: PKCE (S256) is mandatory; the loopback binds only to
127.0.0.1; the code is useless to an interceptor without the verifier Gear holds.

### Anthropic subscription OAuth

`gear login anthropic` (method `oauth`) runs the same authorization-code + PKCE
shape against Anthropic's endpoints: the browser opens the claude.com authorize
page, and the loopback callback exchanges the code at the platform token
endpoint. The resulting subscription credential is stored in the credential
store and refreshed automatically. `--method api_key` remains available for
console API keys.

This reuses Anthropic's own first-party public client id (the OpenCode-style
approach) — set `GEAR_ANTHROPIC_OAUTH_CLIENT_ID` to override it if Anthropic
rotates the id. `gear login codex` follows the same pattern for ChatGPT
subscription sign-in.

## Config

All additive and optional. In `~/.gear/config.toml` or `<workspace>/.gear/config.toml`:

```toml
[llm]
authentication = "api_key"     # default method for all providers (optional)

[llm.openrouter]
authentication = "oauth"       # override per provider (optional)
```

When omitted, the method is auto-selected as described above.

## Migrating existing keys

`gear login --migrate` copies API keys from the legacy `~/.gear/secrets.json`
into the secure store. It never overwrites an existing entry and **never deletes
secrets.json**, so rollback is trivial. See [byop-migration.md](./byop-migration.md).
