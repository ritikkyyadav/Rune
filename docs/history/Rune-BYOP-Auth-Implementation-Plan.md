# Rune — Bring Your Own Provider (BYOP) Authentication Layer
## Surgical Implementation Plan & Agent Execution Directive

**Target repo:** `Rune/` (product name **Rune**, internal codename **Rune** — `@rune/*` packages, `~/.alan` data dir).
**Stack:** Bun + Turbo monorepo, TypeScript. Rust crates for native tools (out of scope here).
**Release baseline:** v0.2.0.
**Author of record for this doc:** implementation-planning pass over the live codebase (July 2026).

---

## ✅ IMPLEMENTATION STATUS — 2026-07-15 (branch `feat/reliability-and-tooling`)

Built, tested, and live/compile-proven. **1123 tests pass (0 fail); all packages typecheck & prettier clean.**

| Phase | Status | Notes |
|---|---|---|
| 0 — Metadata & interfaces | ✅ | `AuthMethod`/`ProviderCapabilities`/`getProviderDescriptor`/`effectiveAuthMethods` on presets; `AuthenticationStrategy` + `CredentialStore` ports; `ModelInfo` + optional `listModels?`. |
| 1 — Credential store | ✅ | **Shell-out backends** (`security`/`secret-tool`/DPAPI) + `FileCredentialStore` fallback. **NOT `@napi-rs/keyring`** — see below. Real macOS Keychain round-trip proven; **`bun build --compile` binary proven working** with keychain. |
| 2 — API-key strategy + resolver | ✅ | `ApiKeyStrategy` + `resolveProviderCredentials`; `credentials?` threaded through `buildGateway` (absent ⇒ byte-identical legacy path). Firewall asserted by tests. |
| 3 — Local endpoint strategy | ✅ | `LocalEndpointStrategy` (connectivity); registration in `buildGateway` unchanged. |
| 4 — OAuth engine + OpenRouter | ✅ | Generic PKCE+loopback `OAuthStrategy` + `DeviceCodeStrategy` framework; **OpenRouter PKCE is the working reference** (mints an API key); `listModels()` on all 5 adapters. |
| 5 — CLI verbs | ✅ | `berne login \| providers \| use \| models` — all live-proven. |
| 6 — Slash/status polish | ◑ | `berne providers` is the full status surface (auth method + secure badge + insecure notice); added a `/keys` pointer. Deep TUI `/keys login\|logout` sub-actions **deliberately deferred** (CLI covers it). |
| 7 — Anthropic OAuth | ✅ (scaffold) | Behind `BERNE_ANTHROPIC_OAUTH=1`; anthropic stays api_key-only by default. |
| 8 — Docs + regression | ✅ | `docs/byop.md` + `docs/byop-migration.md`; `.env.example`, `bin/rune`, help updated. Cross-OS: **macOS live-tested**; Linux/Windows by-the-book, not run. |

**Deviation from plan (§5.3/§12):** shipped shell-out as the DEFAULT secure backend instead of the native `@napi-rs/keyring` — the plan's own #1 High/High risk (native N-API may not bundle in `bun --compile`). Shell-out needs zero deps and is proven in the compiled binary. The `CredentialStore` port keeps a native backend a one-file future addition.

**Config fix in passing:** widened `llm.defaultProvider` to the full `ProviderName` set (was missing groq/xai/deepseek/lmstudio/custom).

---

## 0. How to read this document

This is the *only* input an implementing agent needs. It restates the goal precisely, maps it onto the **actual** code that exists today (file paths and signatures are real, not illustrative), then specifies every new file, every modified file, the migration path, the risk register, and the test plan. Sections 9–11 are execution-ordered: build phase by phase, gate each phase on its tests, do not proceed on red.

Non-negotiable framing: **this is an authentication-layer expansion, not a provider expansion.** No new LLM providers are added. Existing API-key users must see *zero* behavior change unless they opt in.

---

## 1. Objective (restated, unambiguous)

Add a **Provider Authentication Layer** to Rune so a provider can authenticate by any of:

1. **API key** — already works; must remain byte-for-byte compatible.
2. **OAuth** — new; officially documented flows only (PKCE / authorization-code with loopback).
3. **Official provider login** — new; provider-native flows (e.g. OAuth device-code / subscription login) where the provider officially supports it.
4. **Local endpoint** — already works implicitly for Ollama/LM Studio; formalize it as a first-class "connectivity" auth method (no credential).

The rest of Rune must never learn *how* a provider authenticates. It asks for an authenticated provider and streams. Authentication is isolated behind a strategy interface and resolved at the composition root.

**Hard constraints (from the brief, kept verbatim in intent):**
- Do not remove/rewrite existing provider adapters unless necessary.
- Do not change the existing config format unless absolutely necessary (additive only).
- Do not require existing users to reconfigure.
- Never store credentials in plaintext when an OS secure store is available; if it is not, **notify the user** rather than silently writing secrets.
- Officially documented auth flows only. No scraping, no unofficial token extraction.

---

## 2. Current-state architecture (verified against source)

Rune already has a clean, registration-based, provider-agnostic gateway. BYOP slots *into* it; it does not replace it. The relevant layers:

### 2.1 Provider adapter interface — `packages/llm-gateway/src/types.ts`
```ts
export interface LlmProvider {
  name: ProviderName;
  infer(request: InferenceRequest): Promise<InferenceResponse>;
  inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent>;
  countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number>;
  healthCheck(): Promise<boolean>;
}
```
- `ProviderName` union: `anthropic | openai | openrouter | ollama | ollama-turbo | lmstudio | google | groq | xai | deepseek | custom`.
- Streaming is **already normalized** (`StreamEvent` union). Tool calling is **already normalized** (`ContentBlock` `tool_use`/`tool_result`). Usage is **already normalized** (`TokenUsage`) with a static `MODEL_PRICING` map and `CostEntry`/`CostLedger`.
- **Gap vs. brief's `Provider` interface:** no `listModels()`, `capabilities()`, `estimateUsage()`, `authenticate()`. See §4 for how each is satisfied without breaking the interface.

### 2.2 Gateway — `packages/llm-gateway/src/gateway.ts`
- `LlmGateway` is registration-based: `registerProvider(p: LlmProvider)`, `getProvider`, `getRegisteredProviderNames`, fallback/retry/backoff, `onIncident` tap, cost ledger. **Provider-agnostic already** — needs no auth knowledge. Do not add auth here.

### 2.3 Provider metadata (single source of truth) — `packages/shared/src/providers.ts`
```ts
export interface ProviderPreset {
  id: string; label: string; kind: "anthropic"|"openai-compat"|"google"|"ollama";
  defaultModel: string; docsUrl: string; envVar?: string;
  local?: boolean; baseUrl?: string; keyHint?: string;
  models?: { id: string; label: string }[];
}
export const PROVIDER_PRESETS: ProviderPreset[] = [ /* anthropic, openai, openrouter, google, groq, xai, deepseek, ollama-turbo, ollama, lmstudio */ ];
export const CUSTOM_PROVIDER_ID = "custom";
export function getPreset(id: string): ProviderPreset | undefined;
```
- `/keys`, `/providers`, the gateway builder, and the `/model` picker all read from this list. **This is where auth-method + capability metadata must be added** (additive fields).

### 2.4 Credential storage (today) — `packages/shared/src/secrets.ts`
- Stores BYOK data in **`~/.alan/secrets.json`, mode `0600`, plaintext JSON**. Shape: `{ keys: Record<id,key>, custom?: CustomEndpoint, disabled?: string[], endpoints?: Record<id,baseUrl> }`.
- Resolution precedence today: **secrets.json → config.toml → env var**.
- API surface: `loadSecrets`, `saveSecrets`, `setProviderKey`, `clearProviderKey`, `setCustomEndpoint`, `clearCustomEndpoint`, `setLocalEndpoint`, `setProviderDisabled`, `maskKey`, `secretsArePrivate`. Also holds non-LLM web-search keys (`tavily`/`brave`) and `applySearchKeysToEnv`.
- **Gap vs. brief:** plaintext only. No OS keychain. This is the single largest gap.

### 2.5 Composition root — `packages/orchestrator/src/provider-registry.ts`
- `buildGateway(opts: BuildGatewayOpts): LlmGateway` — the **one place** that turns keys → registered providers. Iterates `PROVIDER_PRESETS`, resolves each key via `resolveKey` (saved key → env var), constructs the right adapter (`AnthropicProvider`/`GoogleProvider`/`OpenAIProvider`/`OpenRouterProvider`/`OllamaProvider`), and registers it. Local runtimes register keyless when active or configured.
- `providerStatus(opts): ProviderStatusRow[]` — powers `/keys` and `/providers` (masked, never raw).
- **This is the primary insertion point for auth-strategy resolution.**

### 2.6 Engine runtime provider API — `packages/orchestrator/src/engine.ts`
- Already comments `// ─── BYOK: live provider-key management ───`.
- `gatewayOpts()`, `rebuildGateway()`, `setProviderKey()`, `setCustomEndpoint()`, `setProviderDisabled()`, `setLocalEndpoint()`, `getLocalEndpoint()`, `reconcileActiveProvider()`, `getProviderStatus()`, `switchModel()`. In-memory state: `providerKeys`, `customEndpoint`, `disabledProviders`, `localBaseUrls`. All runtime edits funnel through the single `buildGateway` path (`rebuildGateway`).

### 2.7 Config — `packages/shared/src/config.ts`
- `RuneConfig` with `llm.defaultProvider` + per-provider blocks (`anthropic`, `openai`, `openrouter`, `google`, `ollama`, `lmstudio`, plus `planner`/`executor`). Minimal TOML parser, deep-merge, `RUNE_*` env overlay. Precedence: defaults → `~/.alan/config.toml` → `<ws>/.alan/config.toml` → env.
- **Note (latent bug to fix in passing):** `llm.defaultProvider`'s union is `"anthropic"|"openai"|"openrouter"|"ollama"|"ollama-turbo"|"google"` — it omits `groq | xai | deepseek | lmstudio | custom`, which *are* valid `ProviderName`s. Widen it to full `ProviderName` while here (§8, low-risk).
- **Gap vs. brief:** no `authentication` field. Add it, optional, auto-selected when omitted.

### 2.8 CLI subcommand dispatch — `packages/orchestrator/src/bin/rune-cli.ts`
- Subcommands are dispatched near the top as `if (command === "doctor") { const { runDoctor } = await import("./blackbox-cli"); runDoctor(); process.exit(0); }` — same for `incidents`, `notebook`, `telemetry`, `detach`, `attach`. **`berne login` / `providers` / `use` / `models` mirror this pattern exactly.**
- A `CliProvider` union + `DEFAULT_MODELS` + `LOCAL_PROVIDERS` + `isCliProvider` exist here and duplicate preset data — the new subcommands should read presets instead of extending this duplication.
- Slash commands `/keys`, `/providers`, `/model` live in `bin/ui/tui.ts` (~L1087 `handleSlash`, L1213 `providers`, L2191 `openKeys`) and the classic REPL in `rune-cli.ts` (~L1455 `/providers`, ~L1564 `/keys`, ~L2037 `/model`). New CLI verbs must stay consistent with these; the slash commands get thin additions (login/logout), not rewrites.

### 2.9 Model persistence — `packages/shared/src/model-store.ts`
- `~/.alan/model.json` sidecar for last-used `{provider, model}`. Precedence: `--model/--provider` → sidecar → config → auto-detect. `berne use <provider>` writes here.

### 2.10 Tests (mirror these locations)
`tests/unit/gateway/*` (adapters, fallback, cost), `tests/unit/orchestrator/provider-registry.test.ts`, `tests/unit/orchestrator/ui-keys.test.ts`, `tests/unit/shared/secrets.test.ts`, `tests/unit/shared/providers.test.ts`. Runner: `bun test`; `vitest.config.ts` present.

---

## 3. Gap analysis (requirement → today → action)

| Brief requirement | Exists today | Gap / action |
|---|---|---|
| API-key auth | ✅ `secrets.ts` + `provider-registry` | Keep. Wrap as `ApiKeyStrategy`. |
| OAuth auth | ❌ | New `OAuthStrategy` (PKCE + loopback). Reference impl: **OpenRouter PKCE** (officially documented, returns a normal API key). |
| Official provider login | ❌ | New `DeviceCodeStrategy` / provider-specific strategy. Reference: **Anthropic subscription OAuth** (as used by Claude Code) behind a capability flag; ship only if the official flow is available on the target plan. |
| Local endpoint auth | ⚠️ implicit (Ollama/LM Studio keyless) | Formalize as `LocalEndpointStrategy` = connectivity check (`healthCheck`), no credential. |
| Per-provider declares supported methods | ❌ | Add `auth: AuthMethod[]` to `ProviderPreset`. |
| Provider metadata (caps, pricing, health) | ⚠️ partial (`models`, static `MODEL_PRICING`) | Add `capabilities` + optional `pricing` to `ProviderPreset`; expose a descriptor accessor. |
| Secure OS credential storage | ❌ (plaintext 0600 JSON) | New `CredentialStore` port + OS backend + explicit fallback notice. |
| `berne login` | ❌ | New `login-cli.ts`. |
| `berne providers` | ⚠️ `/providers` slash only | New `providers-cli.ts` (non-interactive listing). |
| `berne use <provider>` | ⚠️ `/model`, `--provider` | New verb → writes `model.json`. |
| `berne models` | ⚠️ static picker in `/model` | New verb → live `listModels()` with static fallback. |
| Normalized streaming | ✅ `StreamEvent` | None. |
| Normalized tool calling | ✅ `ContentBlock` | None. |
| Usage tracking across auth methods | ✅ `CostTracker`/`TokenUsage` | Ensure OAuth path records usage identically (it will — usage is post-auth). Add auth-method to the status readout. |
| Config `authentication:` field | ❌ | Add optional field + auto-selection. |
| Graceful error handling (expired/revoked/invalid/network/unsupported) | ⚠️ gateway handles 401/402/403/429/5xx | Extend with auth-specific recovery messages ("run `berne login <p>`"). |

---

## 4. Reconciling the brief's `Provider` interface with the real one

The brief lists `authenticate() / listModels() / chat() / stream() / toolCall() / capabilities() / estimateUsage() / healthCheck()`. Rune already satisfies most of these under different names. **Do not rewrite `LlmProvider` to match the brief literally** — that would break every adapter and violate the zero-breakage constraint. Map instead:

- `chat()` → existing `infer()`. `stream()` → existing `inferStream()`. `toolCall()` → already inside `infer`/`inferStream` via normalized `ContentBlock`. **No change.**
- `healthCheck()` → exists. **No change.**
- `authenticate()` → **deliberately NOT on the provider.** Auth lives in `AuthenticationStrategy` (§5). The provider receives the *resolved* credential/session at construction. This is the correct reading of "authentication must be isolated from the provider implementation" — putting `authenticate()` on the adapter would couple them. Documented divergence.
- `listModels()` → **new OPTIONAL method** `listModels?(): Promise<ModelInfo[]>` on `LlmProvider`, implemented per-adapter where a live endpoint exists (Ollama `/api/tags`, OpenAI-compat `/v1/models`, OpenRouter `/api/v1/models`, Anthropic `/v1/models`, Google `models.list`), with a **static fallback** to `preset.models`. Optional ⇒ existing adapters compile untouched.
- `capabilities()` → **static metadata** on `ProviderPreset.capabilities`, surfaced via a `getProviderDescriptor(id)` accessor. Not a per-adapter method (avoids rewriting 5 adapters; capabilities are provider facts, not runtime state).
- `estimateUsage()` → thin helper `estimateUsage(model, messages, tools)` = existing `countTokens()` × `MODEL_PRICING`. Lives in the gateway/descriptor layer, not the adapter.

Net: `LlmProvider` gains **one optional method** (`listModels?`). Everything else is additive metadata or a new parallel layer. Zero breaking changes.

---

## 5. Target architecture

```
Provider (preset: id, kind, auth[], capabilities, pricing)
   │
   ▼
AuthenticationStrategy         ← isolated; one per method; DI'd a CredentialStore
   authenticate()  refresh()  logout()  validate()
   storeCredentials()  loadCredentials()
   │  produces
   ▼
ResolvedCredential  { kind: "apiKey"|"bearer"|"none", secret?, expiresAt?, baseUrl? }
   │  consumed at the composition root
   ▼
buildGateway()  → constructs LlmProvider adapters with the resolved credential
   │
   ▼
LlmGateway (unchanged) → Model Discovery · Streaming · Tool Calling · Usage Tracking
```

### 5.1 New module layout
```
packages/shared/src/
  credential-store.ts        NEW  OS-secure store port + backends + fallback + migration
packages/llm-gateway/src/auth/
  types.ts                   NEW  AuthenticationStrategy, ResolvedCredential, AuthMethod, AuthError
  api-key-strategy.ts        NEW  wraps today's key resolution
  oauth-strategy.ts          NEW  generic PKCE + loopback authorization-code
  device-code-strategy.ts    NEW  OAuth device-code (headless/SSH-friendly)
  local-endpoint-strategy.ts NEW  connectivity check, no credential
  registry.ts                NEW  provider id → strategy factory (respects config override)
  index.ts                   NEW  barrel
packages/llm-gateway/src/oauth/
  openrouter.ts              NEW  OpenRouter PKCE specifics (reference implementation)
  anthropic.ts               NEW  Anthropic subscription OAuth (capability-flagged)
packages/orchestrator/src/bin/
  login-cli.ts               NEW  `berne login`
  providers-cli.ts           NEW  `berne providers` / `berne use` / `berne models`
```
Interfaces (the `AuthenticationStrategy` port and `CredentialStore` port) are defined in `llm-gateway/src/auth/types.ts` and `shared/src/credential-store.ts` respectively; concrete OS backends live in `shared`. This is dependency inversion: `llm-gateway` depends on `@rune/shared` (already does), OS-specific code stays in `shared`, auth-flow logic stays in `llm-gateway`, and the **orchestrator** wires them (DI) at the composition root.

### 5.2 The strategy interface — `packages/llm-gateway/src/auth/types.ts`
```ts
export type AuthMethod = "api_key" | "oauth" | "device" | "local";

export interface ResolvedCredential {
  kind: "apiKey" | "bearer" | "none";
  secret?: string;              // apiKey value OR bearer access token
  baseUrl?: string;             // for local/custom endpoints
  expiresAt?: number;           // epoch ms, for refreshable tokens
  meta?: Record<string, string>;
}

export interface AuthContext {
  providerId: string;
  preset: ProviderPreset;
  store: CredentialStore;       // injected
  env: NodeJS.ProcessEnv;       // injected (testability)
  // interactive I/O hooks — undefined in non-interactive/rebuild paths:
  openBrowser?: (url: string) => Promise<void>;
  prompt?: (q: string) => Promise<string>;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface AuthenticationStrategy {
  readonly method: AuthMethod;
  /** Interactive: run the full flow (browser/device/paste), persist, return creds. */
  authenticate(ctx: AuthContext): Promise<ResolvedCredential>;
  /** Non-interactive: load persisted creds; refresh if near expiry; null if none/expired. */
  loadCredentials(ctx: AuthContext): Promise<ResolvedCredential | null>;
  /** Refresh an OAuth token; no-op for api_key/local. */
  refresh(ctx: AuthContext): Promise<ResolvedCredential | null>;
  /** Cheap validity probe (format check or /models ping). Never throws. */
  validate(ctx: AuthContext, cred: ResolvedCredential): Promise<boolean>;
  /** Persist credentials to the store. */
  storeCredentials(ctx: AuthContext, cred: ResolvedCredential): Promise<void>;
  /** Delete persisted credentials (logout). */
  logout(ctx: AuthContext): Promise<void>;
}
```

### 5.3 The credential-store port — `packages/shared/src/credential-store.ts`
```ts
export type CredentialBackend = "keychain" | "secret-service" | "wincred" | "file";

export interface CredentialStore {
  readonly backend: CredentialBackend;
  readonly secure: boolean;                 // false ⇒ plaintext fallback in use
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Choose the best available backend; falls back to file with `secure=false`. */
export function openCredentialStore(opts?: { service?: string }): Promise<CredentialStore>;
```
- **Service namespace:** `"berne"` (accounts keyed as `provider:<id>` and `provider:<id>:oauth`).
- **Backends, in priority order:**
  1. **`@napi-rs/keyring`** (actively maintained, prebuilt N-API binaries) — macOS Keychain, Windows Credential Manager, Linux Secret Service in one API. First choice.
  2. **CLI shell-out fallback** if the native module can't load (see §7 risk on `bun --compile`): `security` (macOS), `secret-tool`/`libsecret` (Linux), `powershell`/`cmdkey` or DPAPI (Windows).
  3. **`FileCredentialStore`** wrapping the existing `secrets.ts` (0600 JSON) as the *last* resort, with `secure=false` so callers emit the required user notice.
- **Migration:** on first `set()` with a secure backend, opportunistically read any legacy `~/.alan/secrets.json` keys and offer to migrate (see §10). Legacy file is never deleted automatically.

### 5.4 Extended provider metadata — `packages/shared/src/providers.ts` (additive)
```ts
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  contextLength?: number;
}
export interface ProviderPreset {
  // ...all existing fields unchanged...
  /** Supported auth methods, in preference order. Default ["api_key"] (cloud) / ["local"] (local). */
  auth?: AuthMethod[];
  capabilities?: ProviderCapabilities;
  /** Optional per-provider pricing note; live pricing still comes from MODEL_PRICING. */
  pricing?: { source: "static" | "live"; note?: string };
}
```
Populate `auth` per provider: `anthropic: ["oauth","api_key"]` (oauth capability-flagged), `openrouter: ["oauth","api_key"]`, `google/openai/groq/xai/deepseek/ollama-turbo: ["api_key"]`, `ollama/lmstudio: ["local"]`. All other presets default to `["api_key"]` if `auth` is omitted, so the field is truly optional.

---

## 6. Auth resolution flow (where it plugs in)

### 6.1 Non-interactive (the hot path: startup + every `rebuildGateway`)
`buildGateway` must **not** block on browsers. Split credential resolution out:

1. New `resolveProviderCredentials(opts): Promise<Record<string, ResolvedCredential>>` in `provider-registry.ts`:
   - For each enabled preset, pick its effective `AuthMethod` (config override → first method with stored creds → preset default).
   - Call `strategy.loadCredentials(ctx)` (bounded, non-interactive; OAuth refresh allowed with a short timeout).
   - Skip providers with no credential (exactly like today's "no key ⇒ skip").
2. `buildGateway` becomes `async` (or accepts a pre-resolved credential map — **preferred**, keeps it synchronous and cheap for rebuilds). Recommended signature:
   ```ts
   export function buildGateway(opts: BuildGatewayOpts & { credentials?: Record<string, ResolvedCredential> }): LlmGateway
   ```
   When `credentials` is present, adapters are constructed from it; when absent, fall back to **today's** exact `resolveKey` behavior (env/saved key). This guarantees the legacy path is untouched if BYOP is never used.
3. Engine: `gatewayOpts()` gains a resolved-credentials field, populated once at boot and refreshed on `setProviderKey`/login events. `rebuildGateway()` stays synchronous.

### 6.2 Interactive (`berne login`)
`login-cli.ts` → pick provider (or arg) → pick method (or auto) → `strategy.authenticate(ctx)` with real `openBrowser`/`prompt`/`log` → `storeCredentials` → validate → print success + how to switch (`berne use <p>`). This is the only place `authenticate()` runs.

### 6.3 Auto-selection of method (satisfies config "authentication omitted")
Given a provider, effective method = `config.llm.<id>.authentication` if set, else the first of `preset.auth` for which `loadCredentials` returns non-null, else `preset.auth[0]`, else `"api_key"`. Local providers always `"local"`.

---

## 7. Security specifics

- **Never plaintext when avoidable.** Secure backend chosen automatically; `store.secure === false` triggers a one-line stderr notice on every write and a persistent line in `berne providers` / `/keys`: `⚠ credentials stored unencrypted at ~/.alan/secrets.json (no OS keychain available)`.
- **OAuth:** PKCE (S256) mandatory; `state` param verified; loopback redirect on `127.0.0.1:<ephemeral>`; access+refresh tokens stored in the credential store (never in `config.toml` or `model.json`); refresh performed on load when `expiresAt` within a 60s skew; on refresh failure emit a terminal, non-retryable error routed to the existing gateway error surface with recovery text `run: berne login <provider>`.
- **`bun build --compile` constraint (REAL RISK — see §12):** native N-API modules may not bundle into the standalone binary that `scripts/build-release.sh` produces. Mitigation baked into the design: `openCredentialStore` probes the native module inside a `try/catch`, and on failure walks down to CLI shell-out, then to `FileCredentialStore`. The build must be tested with `bun build --compile` on all three OSes before shipping the native path; if it can't bundle, ship shell-out as the default secure backend (no native dep) — the abstraction makes this a one-line default change.
- **Redaction:** all new log lines go through the existing masking (`maskKey`) and the telemetry/black-box redaction already in place. Tokens never logged, never sent anywhere (telemetry stays off by default; auth events recorded as *classes*, not values).

---

## 8. File-by-file change plan

### 8.1 New files
| File | Purpose |
|---|---|
| `packages/shared/src/credential-store.ts` | `CredentialStore` port, backend selection, OS backends, `FileCredentialStore` fallback, legacy-migration helper. |
| `packages/llm-gateway/src/auth/types.ts` | `AuthenticationStrategy`, `AuthContext`, `ResolvedCredential`, `AuthMethod`, `AuthError`. |
| `packages/llm-gateway/src/auth/api-key-strategy.ts` | Wraps current key resolution + `validate` (format/`/models`). |
| `packages/llm-gateway/src/auth/oauth-strategy.ts` | Generic PKCE + loopback authorization-code engine. |
| `packages/llm-gateway/src/auth/device-code-strategy.ts` | OAuth device-code flow (SSH/headless). |
| `packages/llm-gateway/src/auth/local-endpoint-strategy.ts` | Connectivity check for Ollama/LM Studio. |
| `packages/llm-gateway/src/auth/registry.ts` | provider id → strategy factory. |
| `packages/llm-gateway/src/auth/index.ts` | barrel export. |
| `packages/llm-gateway/src/oauth/openrouter.ts` | OpenRouter PKCE endpoints/params (reference). |
| `packages/llm-gateway/src/oauth/anthropic.ts` | Anthropic subscription OAuth (capability-flagged). |
| `packages/orchestrator/src/bin/login-cli.ts` | `berne login` subcommand runner. |
| `packages/orchestrator/src/bin/providers-cli.ts` | `berne providers` / `use` / `models` runners. |
| Tests: see §11. | |

### 8.2 Modified files (surgical, additive)
| File | Change |
|---|---|
| `packages/shared/src/providers.ts` | Add `AuthMethod`, `ProviderCapabilities`, `auth?`, `capabilities?`, `pricing?` to `ProviderPreset`; populate presets; add `getProviderDescriptor(id)`. **No field removed.** |
| `packages/shared/src/secrets.ts` | Keep as-is; expose it as the `FileCredentialStore` backend. Add a `migrateLegacySecrets(store)` helper. No behavior change to existing functions. |
| `packages/shared/src/index.ts` | Export new `credential-store` symbols + new provider types. |
| `packages/shared/src/config.ts` | Add optional `llm.<provider>.authentication?: AuthMethod` (and optional top-level `llm.authentication?`); widen `llm.defaultProvider` union to full `ProviderName`; no parser change (TOML already handles nested keys). |
| `packages/llm-gateway/src/types.ts` | Add **optional** `listModels?(): Promise<ModelInfo[]>` to `LlmProvider`; add `ModelInfo`. Nothing else touched. |
| `packages/llm-gateway/src/index.ts` | Export `auth/*`, `oauth/*`, `ModelInfo`. |
| `packages/llm-gateway/src/providers/{ollama,openai,openrouter,anthropic,google}.ts` | Add `listModels()` per adapter (live endpoint + graceful fallback). Optional-method ⇒ can land incrementally. |
| `packages/orchestrator/src/provider-registry.ts` | Add `resolveProviderCredentials()`; thread optional `credentials` into `buildGateway`; extend `providerStatus` rows with `authMethod` + `secure` flag. Legacy path preserved when `credentials` absent. |
| `packages/orchestrator/src/engine.ts` | `gatewayOpts()` carries resolved credentials; add `loginProvider()/logoutProvider()/listModelsLive()` passthroughs; extend `getProviderStatus()` with auth method; keep `rebuildGateway()` synchronous. |
| `packages/orchestrator/src/bin/rune-cli.ts` | Add `if (command === "login") …`, `"providers"`, `"use"`, `"models"` dispatch blocks mirroring `telemetry`/`doctor`; add usage lines to `--help`. Make new verbs read `PROVIDER_PRESETS` (retire the local `DEFAULT_MODELS`/`isCliProvider` duplication where practical). |
| `packages/orchestrator/src/bin/ui/tui.ts` | `/keys` gains `login <p>` / `logout <p>` sub-actions and shows auth method + secure/insecure store badge; `/providers` shows method per row. Thin additions only. |
| `bin/rune` (shell) | Add `login`, `providers`, `use`, `models` to the `--help` usage block. No dispatch logic (the shell forwards args to the Bun CLI). |
| `README.md` + `docs/` | Document `berne login/providers/use/models`, auth methods, keychain behavior, and the config `authentication` field. |
| `.env.example` | Note OAuth is available via `berne login`; env keys still work unchanged. |

---

## 9. Phased delivery (execution order — gate each on green tests)

**Phase 0 — Metadata & interfaces (no behavior change).**
`AuthMethod`/`capabilities` on presets; `AuthenticationStrategy` + `ResolvedCredential` + `CredentialStore` ports; `ModelInfo` + optional `listModels?`. Barrels/exports. Unit tests: preset shape, descriptor accessor. *Ship-safe: nothing wired yet.*

**Phase 1 — Credential store.**
`openCredentialStore` + native/shell/file backends + `FileCredentialStore` over `secrets.ts` + legacy migration helper + insecure-fallback notice. Tests: round-trip per backend (mock native), fallback selection, migration, `secure` flag. **Test `bun build --compile` bundling here.**

**Phase 2 — API-key strategy + resolver (behavior-preserving).**
`ApiKeyStrategy`; `resolveProviderCredentials`; thread `credentials` into `buildGateway`; engine carries them. **Acceptance: with no OAuth configured, existing API-key + env-var flows behave identically** (the whole legacy `provider-registry.test.ts` suite passes unmodified). This phase is the backward-compat firewall.

**Phase 3 — Local endpoint strategy.**
Formalize Ollama/LM Studio as `LocalEndpointStrategy` (connectivity via `healthCheck`). No functional change for users; removes special-casing debt. Tests: local register/skip parity with today.

**Phase 4 — OAuth engine + OpenRouter reference.**
Generic PKCE/loopback `OAuthStrategy` + `device-code-strategy` + `oauth/openrouter.ts`. `berne login openrouter` end-to-end (mock IdP in tests). Refresh-on-load. Tests: PKCE params, state check, loopback capture, token persist/refresh/expiry, error routing.

**Phase 5 — CLI verbs.**
`login-cli.ts`, `providers-cli.ts` → `berne login | providers | use | models`; `--help` + shell usage. `berne models` live discovery with static fallback. Tests: dispatch, `use` writes `model.json`, `providers` output shape, `models` fallback.

**Phase 6 — Slash-command + status polish.**
`/keys login|logout`, method + secure badge in `/keys` and `/providers`; usage readout shows Current Provider · Model · **Auth Method** · Est. tokens · Est. cost. Error surfaces get auth-recovery text. Tests: ui-keys additions.

**Phase 7 — Anthropic subscription OAuth (capability-flagged).**
`oauth/anthropic.ts` behind `preset.auth` including `oauth` only if the official flow is confirmed available on the target plan; otherwise leave scaffolded + documented. Tests: flag on/off, no leakage into default path.

**Phase 8 — Docs, migration notes, full regression.**
README/docs, `.env.example`, **Migration Notes (§10)**, run the entire suite + a manual matrix (env-key user, secrets.json user, fresh OAuth user, local-only user) on macOS/Linux/Windows.

---

## 10. Migration strategy & backward-compatibility guarantees

**Guarantees (must all hold, asserted by tests):**
1. A user with only `GOOGLE_API_KEY`/`ANTHROPIC_API_KEY`/etc. in env: **unchanged**. `buildGateway` without `credentials` uses today's `resolveKey`.
2. A user with `~/.alan/secrets.json`: **unchanged**. The file store reads it; precedence stays keychain → secrets.json → config.toml → env (keychain simply prepended; if empty/insecure-unavailable, identical to today).
3. `config.toml` without `authentication`: **unchanged** — method auto-selected to `api_key`/`local`.
4. Existing slash commands `/keys`, `/providers`, `/model` and flags `--provider`/`--model`: **unchanged**.
5. `ProviderName`, `LlmProvider` (only gains an *optional* method), `ProviderConfig`, `PROVIDER_PRESETS` existing fields: **unchanged**.

**Migration (opt-in, non-destructive):**
- First run after upgrade with a secure backend available: detect legacy `secrets.json` keys, print `found N API keys in secrets.json — migrate to <keychain>? (berne login --migrate)`. On confirm, copy into the store; **never delete** `secrets.json` (rollback safety); mark migrated.
- No secure backend: keep using `secrets.json` exactly as today; print the one-line insecure notice.
- OAuth is strictly additive: absent until the user runs `berne login <provider>`.

**Migration Notes deliverable (§Deliverable 10 in brief):** a `docs/byop-migration.md` stating the five guarantees above, the precedence chain, the insecure-fallback behavior, and an explicit "no action required for existing users."

---

## 11. Test plan (locations mirror existing suite)

- `tests/unit/shared/credential-store.test.ts` — backend selection, mocked native round-trip, shell-out parse, file fallback, `secure` flag, legacy migration.
- `tests/unit/gateway/auth/api-key-strategy.test.ts` — resolution precedence, validate, no-cred skip.
- `tests/unit/gateway/auth/oauth-strategy.test.ts` — PKCE (S256) generation, `state` verification, loopback code capture (mock server), token store/refresh/expiry-skew, error → terminal event mapping.
- `tests/unit/gateway/auth/local-endpoint-strategy.test.ts` — connectivity pass/fail parity with current Ollama/LM Studio registration.
- `tests/unit/gateway/list-models.test.ts` — per-adapter live parse + static fallback.
- `tests/unit/orchestrator/provider-registry.test.ts` — **extend, don't rewrite**: assert credential-map path == legacy path when no OAuth; assert `resolveProviderCredentials` selection.
- `tests/unit/orchestrator/provider-cli.test.ts` — `login`/`providers`/`use`/`models` dispatch + `model.json` write + fallback output.
- `tests/unit/orchestrator/ui-keys.test.ts` — **extend**: method column, secure badge, login/logout sub-actions.
- `tests/integration/byop-e2e.test.ts` — mock IdP: `login` → store → `use` → chat records usage → `logout`; assert an env-key-only run is byte-identical pre/post feature (snapshot of registered providers + first request).

**Definition of done:** whole suite green on macOS/Linux/Windows; `bun build --compile` produces a working binary with a functioning secure store (or documented shell-out default); manual four-persona matrix passes; docs + migration notes merged.

---

## 12. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Native keychain module won't bundle in `bun build --compile` | High | High | Port abstraction + shell-out backend + file fallback; test compile in Phase 1; make shell-out the default secure backend if native fails. |
| OAuth loopback server blocked (corp firewall/headless) | Med | Med | `device-code-strategy` fallback; `--no-browser` prints URL to paste. |
| Making `buildGateway` async breaks the fast rebuild path | Med | High | Keep it sync; pass a pre-resolved `credentials` map; resolution happens once at boot / on login, not per rebuild. |
| Provider OAuth availability overstated (e.g. Anthropic plan-gated) | Med | Med | Ship framework + OpenRouter reference; Anthropic behind `preset.auth` flag; only enable when the official flow is verified. |
| Token refresh races during a live stream | Low | Med | Refresh on *load* before building the gateway, with 60s skew; never mid-stream; expired mid-stream → existing 401 path → non-retryable "run berne login". |
| Secrets migrated then legacy file leaks | Low | Med | Never auto-delete; mask in all output; `secretsArePrivate()` check retained. |
| Scope creep into "new providers" | Med | Med | Explicit non-goal; PR checklist forbids new `ProviderName` values. |

---

## 13. Realistic assessment (forward-looking)

- **Now (this task):** framework + API-key parity + local + **OpenRouter OAuth (PKCE)** as the one fully-working OAuth reference + keychain-with-fallback + the four CLI verbs is achievable and production-quality. This is the correct scope.
- **The honest hard parts** are not the abstraction — they're (a) OS keychain inside a `bun --compile` binary and (b) each provider's *actual* official OAuth availability. Both are de-risked above by fallbacks and capability flags. Do not let either block the framework landing.
- **2-year horizon:** with `AuthMethod` + `AuthenticationStrategy` in place, adding a new provider's OAuth is a single strategy file + one preset field — the extensibility the brief demands. Anthropic/Google subscription logins slot in as they become officially documented.
- **Overreach to avoid:** implementing unofficial/session-token logins for providers that only offer API keys. Declaring `api_key` for those is the correct, durable answer; anything else is a maintenance liability and violates the brief.

---

## 14. Agent execution directive (condensed)

> Implement BYOP for Rune per this plan. **Do not add providers.** Build Phases 0→8 in order; gate each on its tests (`bun test`); never proceed on red.
> 1. Land metadata/interfaces (Phase 0) — additive only.
> 2. Build the `CredentialStore` with native → shell-out → file(0600) fallback; test `bun build --compile` bundling.
> 3. Wrap today's key resolution as `ApiKeyStrategy`; introduce `resolveProviderCredentials`; thread an optional `credentials` map through `buildGateway`. **Prove the env-key/secrets.json paths are byte-identical to `main`** before touching OAuth.
> 4. Formalize local endpoints; add the generic OAuth (PKCE+loopback, device-code fallback) with **OpenRouter** as the working reference.
> 5. Add `berne login | providers | use | models`, mirroring the existing `telemetry`/`doctor` dispatch; wire `/keys login|logout` and status badges.
> 6. Anthropic OAuth behind a capability flag only if the official flow is confirmed.
> 7. Docs + migration notes; full cross-OS regression + four-persona manual matrix.
> Keep `LlmGateway` auth-agnostic. Keep `rebuildGateway` synchronous. Officially documented flows only. Notify on insecure fallback; never store plaintext when a secure store exists. Every credential access goes through `CredentialStore`; every log line through existing redaction.

---

*Appendix A — canonical current file map (verified):* `packages/llm-gateway/src/{types,gateway,index,cost-tracker}.ts` + `providers/{anthropic,openai,openrouter,google,ollama}.ts`; `packages/shared/src/{providers,secrets,config,model-store,index}.ts`; `packages/orchestrator/src/{provider-registry,engine,commands}.ts` + `bin/{rune-cli,ui/tui,ui/keys}.ts`; `bin/rune` (`berne` symlink). Data dir `~/.alan/` holds `secrets.json`, `model.json`, `config.toml`.
