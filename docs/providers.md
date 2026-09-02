# Providers

What Gear can talk to, how each host handles prompt caching, and what has
actually been measured rather than assumed.

The provider list itself lives in one place — `packages/shared/src/providers.ts`
(`PROVIDER_PRESETS`). This page is the economics side of it: caching policy,
measured cache behaviour, and the decisions behind rows that were removed.

---

## Prompt caching

A cached prompt prefix is the single largest lever on cost per task: an agent
run re-sends its whole transcript every turn, so a working cache turns a linear
cost curve into a nearly flat one. Whether a host caches, and what it wants on
the wire, is now **declared** per provider in
`packages/llm-gateway/src/providers/cache-policy.ts` rather than inferred from
the base URL.

| Policy | What it means | On the wire |
|---|---|---|
| `anthropic-style` | The host forwards Anthropic `cache_control` breakpoints upstream. Writing the breakpoint is what creates the entry. | `cache_control: {type:"ephemeral"}` on the system block and on the last stable conversation turn |
| `prompt-cache-key` | The host caches prefixes automatically and accepts OpenAI's routing hint, which keeps same-prefix requests on the machine holding the prefix. | `prompt_cache_key` (a hash of system prompt + tool names; no prompt text) |
| `implicit` | The host caches stable prefixes automatically and takes no cache field. Byte-stability of the prefix is the only lever. | nothing |
| `none` | No prompt caching known for this host. | nothing |

### Declared policy per provider

| Provider | Adapter | Policy | Basis |
|---|---|---|---|
| `anthropic` | `AnthropicProvider` | native `cache_control` | reference implementation; reads `cache_creation_input_tokens` / `cache_read_input_tokens` |
| `openai` | `OpenAIProvider` | `prompt-cache-key` | documented automatic prefix caching over 1024 tokens, plus the documented routing field |
| `openrouter` | `OpenRouterProvider` | `anthropic-style` (Anthropic upstreams only) | measured 2026-08-26, see below |
| `google` | `GoogleProvider` | explicit `cachedContent` handles | reads `cachedContentTokenCount` |
| `deepseek` | `OpenAIProvider` | `implicit` | host documents automatic prefix caching |
| `groq` | `OpenAIProvider` | `implicit` | host documents automatic prefix caching |
| `xai` | `OpenAIProvider` | `implicit` | host documents automatic prefix caching |
| `ollama-turbo` | `OpenAIProvider` | `implicit` | OpenAI-compatible host; no documented cache field |
| `codex` | `CodexProvider` | server-side | the Responses backend manages its own prefix reuse |
| `ollama` (local) | `OllamaProvider` | KV cache, held by `keep_alive` | local runtime; nothing is billed, but a dropped KV cache costs a full re-prefill |
| `custom` | `OpenAIProvider` | `none` | a user-supplied endpoint could be anything; claiming a cache it may not have would put an invented number on screen |

An id with no entry falls to `none`. That is deliberate: a provider added
without a measurement should report "no data", never a hit rate it never earned.

### The Anthropic-upstream gate

Under `anthropic-style`, a breakpoint is only emitted when the *model* names an
Anthropic upstream (`anthropic/...`). `cache_control` is an Anthropic-shaped
field; a host proxying it to an OpenAI upstream either drops it or rejects the
request.

Measured on OpenRouter, `stealth/ox-alpha`, cold prefix, 2026-08-26
(`scripts/verify-cache.ts`, with and without `--force-breakpoints`):

```
implicit  turn 1 cached=64 → turn 2 cached=4288  (input 4316)
forced    turn 1 cached=64 → turn 2 cached=4288  (input 4318)
```

Identical hit rate. The explicit field is accepted rather than rejected, but
buys nothing and costs the tokens it serializes to. Widening the gate is a
measurement, not a guess.

<!-- MEASURED-CACHE-TABLE -->

---

## Reading a cache number in the product

`gear audit` and the TUI footer read one source: the cost tracker's
`cacheHitRate`, which is `number | null`. **`null` renders as "no data", never
as 0%** — a provider that reports no cache counters and a provider whose cache
missed are different facts, and conflating them is how an invented number gets
on screen.
