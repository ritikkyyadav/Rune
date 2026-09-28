# Bring Your Own Provider (BYOP) — authentication

Rune can authenticate a provider by any of five methods. The rest of Rune never
learns _how_ a provider signed in — it asks for an authenticated provider and
streams. This is an **authentication-layer** feature; existing API-key users
see zero behavior change. Since 2026-09-06 the same layer connects the
web-search engines (Tavily, Exa, Brave, …): one API-key strategy, one keychain
account shape, one `/login` — see the roster in [providers.md](./providers.md).

## Auth methods

| Method      | What it is                                                        | Providers                              |
| ----------- | ----------------------------------------------------------------- | -------------------------------------- |
| **api_key** | A bearer secret you paste or supply via env var (today's path).   | all cloud providers                    |
| **oauth**   | Browser authorization-code + PKCE (loopback redirect).            | OpenRouter, Anthropic, ChatGPT (Codex) |
| **device**  | OAuth device-code (headless / SSH-friendly).                      | GitHub Copilot                         |
| **local**   | A localhost runtime reached by URL — connectivity, no credential. | Ollama                                 |
| **chain**   | The cloud's own ambient credential chain. Rune stores nothing.    | Bedrock, Vertex AI, Azure (Entra)      |

A provider declares its supported methods; when you don't choose one, Rune
auto-selects: the first method that has stored credentials, else the provider's
default (`api_key` for cloud, `local` for runtimes).

## Commands

```
rune login [provider]        Sign in. Picks a provider + method, runs the flow, stores the result.
                              Flags: --method api_key|oauth|device|local|chain, --no-browser, --migrate
rune login <engine>          Connect a web-search engine (tavily, exa, brave, serper, …): paste the
                              key, then one real search verifies it and it answers first from now on.
rune logout <provider|engine> Forget a stored key or OAuth session.
rune providers               List every provider and every search engine, with credential status.
rune use <provider> [model]  Set the active provider (+ model) for new sessions.
rune models [provider]       List a provider's models — live discovery, cached an hour,
                              curated preset as the fallback. `--refresh` forces a call.
```

Examples:

```bash
rune login openrouter            # opens a browser, authorizes via OAuth (PKCE), stores the key
rune login anthropic             # prompts for an API key, stores it in your OS keychain
rune login openrouter --no-browser   # prints the URL to open manually (headless boxes)
rune login mistral               # any of the thirty-odd keyed hosts, by id
rune login exa                   # a search engine: paste the key, one test search proves it
rune providers                   # see who's signed in and how — models and search engines
rune use openrouter              # make OpenRouter the active provider
rune models openrouter           # live model catalog
```

## The cloud chain (`chain`)

The enterprise routes do not have a key. AWS Bedrock signs each request with
SigV4 from whatever the AWS credential chain resolves — environment variables,
`~/.aws/credentials` and `~/.aws/config` under `AWS_PROFILE`, a web-identity
token file, or a container role. Google Vertex exchanges Application Default
Credentials for a one-hour access token — a service-account JSON at
`GOOGLE_APPLICATION_CREDENTIALS` (signed RS256 assertion), the gcloud ADC file,
or the GCE metadata server. Azure OpenAI takes an Entra ID access token from
`AZURE_OPENAI_AD_TOKEN` — the one ambient credential of the three that Rune can
actually carry, since the other two re-authenticate per request inside their
adapters. The machine's cloud login _is_ the credential.

Azure also has a plain **resource key** (`AZURE_OPENAI_API_KEY`), which goes
through the credential store like any other API key — so `azure-openai` declares
both `api_key` and `chain` and picks whichever is present.

So `rune login bedrock` **reports** rather than prompts:

```
$ rune login bedrock
  Signing in to AWS Bedrock via chain
  Found AWS Bedrock credentials: profile work
  Nothing was stored — Rune reads your cloud credentials at request time.
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
and `rune providers` shows _where_ the credential was found (`profile work`)
rather than a mask of a secret Rune never held.

## Where credentials live

Rune stores secrets in the best available OS-native store, chosen automatically:

1. **macOS** → Keychain (`security`)
2. **Linux** → Secret Service / libsecret (`secret-tool`)
3. **Windows** → DPAPI (per-user, via PowerShell)
4. **fallback** → `~/.rune/credentials.json`, mode `0600`, **plaintext**

When the plaintext fallback is in use (no OS keychain available), Rune prints a
one-line notice on every write and shows it in `rune providers`:

```
⚠ credentials stored unencrypted at ~/.rune/credentials.json (no OS keychain available)
```

The secure backends shell out to first-party OS tools rather than a native
module, so they work inside the single-file `bun build --compile` release binary
with no extra dependencies.

## OAuth (OpenRouter reference)

OpenRouter documents a PKCE flow that mints a normal API key:

1. `rune login openrouter` opens `https://openrouter.ai/auth?...&code_challenge=...`
2. You approve in the browser; OpenRouter redirects to a loopback URL on
   `127.0.0.1:<ephemeral>` that Rune is listening on.
3. Rune exchanges the code + PKCE verifier at `/api/v1/auth/keys` for a key and
   stores it.

Because the result is an ordinary key, it streams exactly like a pasted key and
never expires. Security: PKCE (S256) is mandatory; the loopback binds only to
127.0.0.1; the code is useless to an interceptor without the verifier Rune holds.

### Claude: API key, Bedrock or Vertex (subscription sign-in retired)

Rune no longer signs in with a Claude Pro or Max plan. Anthropic's terms
([Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance))
say: "Anthropic does not permit third-party developers to offer Claude.ai login
into their own applications, or to route requests through Free, Pro, or Max plan
credentials on behalf of their users." The route Rune used did exactly that, so
it was removed on 2026-09-28.

Claude models remain available three ways:

- `rune login anthropic` with a console API key (`ANTHROPIC_API_KEY` works too).
- `bedrock`: Claude on AWS, signed with your AWS credential chain.
- `vertex`: Claude on Google Cloud, with Application Default Credentials.

If you signed in with a Claude plan on an earlier version, the stored token is
ignored, and `rune login` tells you why. Rune never deletes it on its own. Run
`rune logout anthropic` to remove it. That command also removes a stored
Anthropic API key, so run it before you add a new key, not after.
`rune login anthropic --method oauth` is refused with the same reason, and
`RUNE_ANTHROPIC_OAUTH_CLIENT_ID` no longer does anything.

`rune login codex` (ChatGPT sign-in) is still offered. Whether OpenAI's terms
allow it for a third-party app is an open question, recorded in
[`docs/program/compliance-subscription-routes.md`](program/compliance-subscription-routes.md).

## Config

All additive and optional. In `~/.rune/config.toml` or `<workspace>/.rune/config.toml`:

```toml
[llm]
authentication = "api_key"     # default method for all providers (optional)

[llm.openrouter]
authentication = "oauth"       # override per provider (optional)
```

When omitted, the method is auto-selected as described above.

## Migrating existing keys

`rune login --migrate` copies API keys from the legacy `~/.rune/secrets.json`
into the secure store — model providers and web-search engines alike. It never
overwrites an existing entry and **never deletes secrets.json**, so rollback is
trivial. See [byop-migration.md](./byop-migration.md).
