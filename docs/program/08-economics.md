# Phase 8 — Cheaper per task

**Lane A · 5–8 days · after Phase 1**

## Goal

Every metered provider reports a cache hit rate; the cost per eval task drops measurably; the provider table has no dead rows.

## Evidence (2026-09-02)

- The plumbing is end-to-end: `InferenceRequest.cacheBreakpointIndex` (`llm-gateway/src/types.ts:201`) is set by the loop at `agent-loop.ts:1180` from a stable-prefix count captured before the ephemeral tails (`:1118-1121`). Every adapter receives it.
- Anthropic: full (`anthropic.ts:352-360, 377-441`), reads cache counters. OpenAI: reads `cached_tokens` and subtracts correctly (`openai.ts:59-69`), emits no breakpoints (`forwardsCacheControl`, `:96`). Google: reads `cachedContentTokenCount` (`google.ts:400-415`), never creates `cachedContent`. OpenRouter: breakpoints only for `anthropic/*` (`openai.ts:423-425`); a measured A/B on one model showed implicit = forced (`:405-421`). Ollama: none; no `keep_alive`, so the KV cache is dropped after 5 minutes idle. Copilot: `stream_options` suppressed (`openai.ts:227`), so streams report zero usage and compaction cannot fire until the provider rejects.
- `forwardsCacheControl` is a substring match on `baseUrl` (`openai.ts:96`), unmaintainable past one host.
- `scripts/verify-cache.ts --model <id> --force-breakpoints` exists: the measurement harness is already written.
- Cost tracker (`cost-tracker.ts`) records list and actual cost, cache savings, `cacheHitRate: number | null` where null means no data (`:36-41, :247`). Budget caps test list cost (`:189-199`).
- Provider rot: `lmstudio` has `models: []` and a placeholder default (`providers.ts:442-454`); `copilot` uses an undocumented internal endpoint (`copilot.ts:28`), VS Code header impersonation (`:32-34, :91-95`), a stale catalog (`providers.ts:385-392`), no usage on streams; `ollama-turbo` has `PROVIDER_CAPACITY: free` (`providers.ts:90`) and `billingModeFor: subscription` (`types.ts:438`), which disagree; `OpenRouterProvider.healthCheck()` reads `process.env.OPENROUTER_API_KEY` instead of the constructor key (`openrouter.ts:47-56`), so an OAuth-stored key sends `Bearer undefined`; the vision gate is provider-name based (`openai.ts:548-550`); Ollama drops images silently (`ollama.ts:263-277`); the comment at `openai.ts:74-79` contradicts `openrouter.ts:28-32`.
- Model catalogue lives in three tables with no cross-check: `PROVIDER_PRESETS` (`providers.ts:222-455`), `PROVIDER_TIER_DEFAULTS` (`tiers.ts:104-176`), `PROVIDER_DEFAULT_MODELS` (`gateway.ts:17-36`).
- `apply_patch` exists and is advertised only to gpt/o1/o3/o4/codex families (`tools/apply-patch.ts:239`, `registry.ts:29-31`): the one model-family adapter in the tree.

## Work items

**P8.1 Caching table (half a day).** Replace the `baseUrl` substring with an explicit `cacheBreakpoints: "anthropic-style" | "prompt-cache-key" | "implicit" | "none"` option set at the three construction sites in `provider-registry.ts:123, 148, 168`.

**P8.2 Measure, then widen (1.5 days).** Run `verify-cache.ts --force-breakpoints` per OpenRouter upstream family (anthropic, google, openai, deepseek, qwen, meta) and widen `wantsCacheBreakpoints` only where cached tokens move. Publish the table in `docs/providers.md`.

**P8.3 Google `cachedContent` (1.5 days).** In `toGeminiRequest` (`google.ts:297-329`): create `cachedContents` for the stable prefix above the model's minimum, keep a `(model, prefixHash) → handle` map with TTL on the provider instance, send `cachedContent`, measure with `verify-cache.ts` first.

**P8.4 Ollama `keep_alive` (half a day).** `buildBody` (`ollama.ts:230-248`) sends `keep_alive: "30m"` (configurable); surface `describeModel`'s real context window; verify prefix reuse via `prompt_eval_count` (`:221-227`). Add the missing image handling or an honest "could not view" note (mirror `openai.ts:517-524`).

**P8.5 Copilot decision (half a day, per D5).** Probe whether the proxy rejects `stream_options`; if it tolerates it, delete the exclusion at `openai.ts:227` and drive the catalog from `listModels()`. If D5 says drop, remove the provider and its tables.

**P8.6 Provider consolidation (1 day).** Drop `lmstudio`; fold `ollama-turbo`'s three tables into one and reconcile capacity/billing; fix `OpenRouterProvider.healthCheck()` and `listModels()` to use the constructor key; vision gate by model capability; fix the stale comment. One test asserts the three model tables agree for every preset.

**P8.7 Model-family adapters (1 day).** Extend the family gate: per-family tool-description variants (edit tool phrasing for Codex vs Claude vs Gemini), Anthropic context-editing where available, the effort dial exposed per provider in the model tree (Codex `low..max`, Gemini thinking budget, OpenAI `reasoning_effort`). `reasoning.effort` was once never sent (memory: probe providers, don't assume); every dial gets a unit test that asserts the wire field.

**P8.8 Cost in the product (half a day).** `rune audit` shows cache hit rate and savings per provider; the desktop footer shows live cost; `cacheHitRate: null` renders as "no data", never 0%.

## Gate

```bash
bun test tests/unit/gateway/
for p in anthropic openai google openrouter codex; do bun run scripts/verify-cache.ts --provider $p; done   # hit rate non-null on all five
bun run eval -- --real --compare   # totalListCost down ≥20% vs the pre-P8 baseline on the same task set
rune providers                    # no lmstudio; copilot per D5; ollama-turbo tables agree
```

Done means: caching is a fact per provider, not a belief, and the bill per task went down on the same work.
