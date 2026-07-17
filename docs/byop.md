# Bring Your Own Provider (BYOP) — authentication

Berne can authenticate a provider by any of four methods. The rest of Berne never
learns *how* a provider signed in — it asks for an authenticated provider and
streams. This is an **authentication-layer** feature: no new LLM providers are
added, and existing API-key users see zero behavior change.

## Auth methods

| Method | What it is | Providers |
|---|---|---|
| **api_key** | A bearer secret you paste or supply via env var (today's path). | all cloud providers |
| **oauth** | Browser authorization-code + PKCE (loopback redirect). | OpenRouter (reference); Anthropic behind a flag |
| **device** | OAuth device-code (headless / SSH-friendly). | framework ready; no provider wired by default |
| **local** | A localhost runtime reached by URL — connectivity, no credential. | Ollama, LM Studio |

A provider declares its supported methods; when you don't choose one, Berne
auto-selects: the first method that has stored credentials, else the provider's
default (`api_key` for cloud, `local` for runtimes).

## Commands

```
berne login [provider]        Sign in. Picks a provider + method, runs the flow, stores the result.
                              Flags: --method api_key|oauth|device|local, --no-browser, --migrate
berne providers               List every provider, its auth method, and credential status.
berne use <provider> [model]  Set the active provider (+ model) for new sessions.
berne models [provider]       List a provider's models — live discovery, static fallback.
```

Examples:

```bash
berne login openrouter            # opens a browser, authorizes via OAuth (PKCE), stores the key
berne login anthropic             # prompts for an API key, stores it in your OS keychain
berne login openrouter --no-browser   # prints the URL to open manually (headless boxes)
berne providers                   # see who's signed in and how
berne use openrouter              # make OpenRouter the active provider
berne models openrouter           # live model catalog
```

## Where credentials live

Berne stores secrets in the best available OS-native store, chosen automatically:

1. **macOS** → Keychain (`security`)
2. **Linux** → Secret Service / libsecret (`secret-tool`)
3. **Windows** → DPAPI (per-user, via PowerShell)
4. **fallback** → `~/.alan/credentials.json`, mode `0600`, **plaintext**

When the plaintext fallback is in use (no OS keychain available), Berne prints a
one-line notice on every write and shows it in `berne providers`:

```
⚠ credentials stored unencrypted at ~/.alan/credentials.json (no OS keychain available)
```

The secure backends shell out to first-party OS tools rather than a native
module, so they work inside the single-file `bun build --compile` release binary
with no extra dependencies.

## OAuth (OpenRouter reference)

OpenRouter documents a PKCE flow that mints a normal API key:

1. `berne login openrouter` opens `https://openrouter.ai/auth?...&code_challenge=...`
2. You approve in the browser; OpenRouter redirects to a loopback URL on
   `127.0.0.1:<ephemeral>` that Berne is listening on.
3. Berne exchanges the code + PKCE verifier at `/api/v1/auth/keys` for a key and
   stores it.

Because the result is an ordinary key, it streams exactly like a pasted key and
never expires. Security: PKCE (S256) is mandatory; the loopback binds only to
127.0.0.1; the code is useless to an interceptor without the verifier Berne holds.

### Anthropic subscription OAuth (experimental, off by default)

Anthropic's subscription OAuth is **scaffolded but disabled** — its exact
parameters are not shipped enabled until verified. Enable the framework with:

```bash
export BERNE_ANTHROPIC_OAUTH=1
```

With the flag unset, `anthropic` is `api_key`-only and nothing about the Anthropic
path changes.

## Config

All additive and optional. In `~/.alan/config.toml` or `<workspace>/.alan/config.toml`:

```toml
[llm]
authentication = "api_key"     # default method for all providers (optional)

[llm.openrouter]
authentication = "oauth"       # override per provider (optional)
```

When omitted, the method is auto-selected as described above.

## Migrating existing keys

`berne login --migrate` copies API keys from the legacy `~/.alan/secrets.json`
into the secure store. It never overwrites an existing entry and **never deletes
secrets.json**, so rollback is trivial. See [byop-migration.md](./byop-migration.md).
