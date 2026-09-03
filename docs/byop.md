# Bring Your Own Provider (BYOP) — authentication

Gear can authenticate a provider by any of five methods. The rest of Gear never
learns _how_ a provider signed in — it asks for an authenticated provider and
streams. This is an **authentication-layer** feature: no new LLM providers are
added, and existing API-key users see zero behavior change.

## Auth methods

| Method      | What it is                                                        | Providers                              |
| ----------- | ----------------------------------------------------------------- | -------------------------------------- |
| **api_key** | A bearer secret you paste or supply via env var (today's path).   | all cloud providers                    |
| **oauth**   | Browser authorization-code + PKCE (loopback redirect).            | OpenRouter, Anthropic, ChatGPT (Codex) |
| **device**  | OAuth device-code (headless / SSH-friendly).                      | GitHub Copilot                         |
| **local**   | A localhost runtime reached by URL — connectivity, no credential. | Ollama                                 |
| **chain**   | The cloud's own ambient credential chain. Gear stores nothing.    | Bedrock, Vertex AI, Azure (Entra)      |

A provider declares its supported methods; when you don't choose one, Gear
auto-selects: the first method that has stored credentials, else the provider's
default (`api_key` for cloud, `local` for runtimes).

## Commands

```
gear login [provider]        Sign in. Picks a provider + method, runs the flow, stores the result.
                              Flags: --method api_key|oauth|device|local|chain, --no-browser, --migrate
gear providers               List every provider, its auth method, and credential status.
gear use <provider> [model]  Set the active provider (+ model) for new sessions.
gear models [provider]       List a provider's models — live discovery, cached an hour,
                              curated preset as the fallback. `--refresh` forces a call.
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

## The cloud chain (`chain`)

The enterprise routes do not have a key. AWS Bedrock signs each request with
SigV4 from whatever the AWS credential chain resolves — environment variables,
`~/.aws/credentials` and `~/.aws/config` under `AWS_PROFILE`, a web-identity
token file, or a container role. Google Vertex exchanges Application Default
Credentials for a one-hour access token — a service-account JSON at
`GOOGLE_APPLICATION_CREDENTIALS` (signed RS256 assertion), the gcloud ADC file,
or the GCE metadata server. Azure OpenAI takes an Entra ID access token from
`AZURE_OPENAI_AD_TOKEN` — the one ambient credential of the three that Gear can
actually carry, since the other two re-authenticate per request inside their
adapters. The machine's cloud login _is_ the credential.

Azure also has a plain **resource key** (`AZURE_OPENAI_API_KEY`), which goes
through the credential store like any other API key — so `azure-openai` declares
both `api_key` and `chain` and picks whichever is present.

So `gear login bedrock` **reports** rather than prompts:

```
$ gear login bedrock
  Signing in to AWS Bedrock via chain
  Found AWS Bedrock credentials: profile work
  Nothing was stored — Gear reads your cloud credentials at request time.
```

and when nothing resolves it names the fix instead of asking for a secret:

```
  No AWS credentials found. Run `aws configure`, export
  AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or select a profile with AWS_PROFILE …
```

Storing nothing is the feature, not a gap. A team whose reason for routing
through their own cloud is that model traffic must stay inside their account
does not want a second copy of that credential in a coding tool's keychain —
so `storeCredentials` and `logout` are both deliberate no-ops for this method,
and `gear providers` shows _where_ the credential was found (`profile work`)
rather than a mask of a secret Gear never held.

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
