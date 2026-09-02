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

## Providers that were removed

### `copilot` — removed 2026-09-02 (P8.5, decision D5)

**Decided from evidence, not preference.** D5 said to drop GitHub Copilot
*unless the founder uses it*. The answer was in `~/.gear/gear.db`:

```
$ sqlite3 -readonly ~/.gear/gear.db \
    "select provider, count(*) from sessions group by provider order by 2 desc"
(null)|193
ollama-turbo|132
codex|115
google|111
openrouter|50

$ sqlite3 -readonly ~/.gear/gear.db "select count(*) from sessions where provider='copilot'"
0
```

Zero sessions, ever. (224 recorded events contain the string "copilot" — all of
them prose inside pasted documents about coding agents, not provider traffic.)

What it cost to keep: an undocumented internal endpoint
(`api.githubcopilot.com`), VS Code header impersonation on every request, a
hand-maintained catalogue that had gone stale, and — the one that reached other
providers — a `stream_options` exclusion in the shared OpenAI-compatible
adapter. Copilot's proxy was believed to reject the param, so its streams
reported **zero usage**: the context engine never learned the real prompt size
and compaction could not fire until the provider hard-rejected. That exclusion
is gone; every OpenAI-compatible host now asks for the usage trailer.

The removal is one commit (`P8.5`) touching only Copilot, so it can be reverted
on its own if the decision changes.

### `lmstudio` — removed 2026-09-02 (P8.6, decision D5)

It shipped `models: []` and a placeholder `local-model` default: a provider in
the picker with nothing to pick, and a model id that only worked if the user
happened to have named theirs that. It duplicated the local-runtime slot Ollama
already fills properly.

LM Studio serves an OpenAI-compatible API, so nothing is lost — reach it through
the custom endpoint instead:

```
/keys custom http://localhost:1234/v1 <the-model-you-loaded> lm-studio
```

---

## One catalogue per provider

A provider's model ids used to live in three hand-maintained tables with no
cross-check — `PROVIDER_PRESETS` (what the picker offers),
`PROVIDER_TIER_DEFAULTS` (what heavy/standard/light resolve to), and the
gateway's fallback defaults. They drifted, and each drift was a live failure:

- `ollama` fell back to `llama3` while its preset said `llama3.1`, so a
  fallback into Ollama asked for a tag most machines have not pulled;
- Groq's light tier resolved to `llama-3.1-8b-instant`, which the picker never
  listed, so the one list a person reads did not contain a model their session
  would actually run;
- `ollama-turbo`'s tier table pointed at a lineup that had 410'd — twice —
  while the preset had already been refreshed, which killed compaction for
  those sessions.

A preset can now declare `tiers` and `fallbackModel` and own its ids outright.
`ollama-turbo` is folded that way. `tests/unit/shared/provider-tables.test.ts`
holds every provider to the rule regardless of which form it uses: **every model
id any table names must be a model that provider's preset actually offers.**

### Capacity and billing

Two different questions — how much rate-limit headroom a provider has (for
fallback ordering) and who pays for a token (for the meter) — that must not
contradict each other about the same account. `ollama-turbo` was ranked `free`
capacity and billed as `subscription` at the same time. The ids Gear ships for
Ollama Cloud are the ones verified on the **default, no-subscription plan**
(subscription-gated models are deliberately omitted because they 403), so both
now say free.

---

## Reading a cache number in the product

`gear audit` and the TUI footer read one source: the cost tracker's
`cacheHitRate`, which is `number | null`. **`null` renders as "no data", never
as 0%** — a provider that reports no cache counters and a provider whose cache
missed are different facts, and conflating them is how an invented number gets
on screen.
