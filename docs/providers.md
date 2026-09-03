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

| Policy             | What it means                                                                                                                                 | On the wire                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `anthropic-style`  | The host forwards Anthropic `cache_control` breakpoints upstream. Writing the breakpoint is what creates the entry.                           | `cache_control: {type:"ephemeral"}` on the system block and on the last stable conversation turn |
| `prompt-cache-key` | The host caches prefixes automatically and accepts OpenAI's routing hint, which keeps same-prefix requests on the machine holding the prefix. | `prompt_cache_key` (a hash of system prompt + tool names; no prompt text)                        |
| `implicit`         | The host caches stable prefixes automatically and takes no cache field. Byte-stability of the prefix is the only lever.                       | nothing                                                                                          |
| `none`             | No prompt caching known for this host.                                                                                                        | nothing                                                                                          |

### Declared policy per provider

| Provider         | Adapter              | Policy                                       | Basis                                                                                                                             |
| ---------------- | -------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`      | `AnthropicProvider`  | native `cache_control`                       | reference implementation; reads `cache_creation_input_tokens` / `cache_read_input_tokens`                                         |
| `openai`         | `OpenAIProvider`     | `prompt-cache-key`                           | documented automatic prefix caching over 1024 tokens, plus the documented routing field                                           |
| `openrouter`     | `OpenRouterProvider` | `anthropic-style` (Anthropic upstreams only) | measured 2026-08-26, see below                                                                                                    |
| `google`         | `GoogleProvider`     | `implicit`                                   | **measured 2026-09-02**: 99.7% hit rate with no cache handle                                                                      |
| `deepseek`       | `OpenAIProvider`     | `implicit`                                   | host documents automatic prefix caching                                                                                           |
| `groq`           | `OpenAIProvider`     | `implicit`                                   | host documents automatic prefix caching                                                                                           |
| `xai`            | `OpenAIProvider`     | `implicit`                                   | host documents automatic prefix caching                                                                                           |
| `ollama-turbo`   | `OpenAIProvider`     | `none`                                       | **measured 2026-09-02**: no cached tokens on an identical prefix                                                                  |
| `codex`          | `CodexProvider`      | server-side                                  | the Responses backend manages its own prefix reuse                                                                                |
| `ollama` (local) | `OllamaProvider`     | KV cache, held by `keep_alive`               | local runtime; nothing is billed, but a dropped KV cache costs a full re-prefill                                                  |
| `bedrock`        | `BedrockProvider`    | `anthropic-style`                            | documented `cache_control` support; the shared Anthropic adapter emits the breakpoints. **Not measured** — no AWS credential here |
| `custom`         | `OpenAIProvider`     | `none`                                       | a user-supplied endpoint could be anything; claiming a cache it may not have would put an invented number on screen               |

An id with no entry falls to `none`. That is deliberate: a provider added
without a measurement should report "no data", never a hit rate it never earned.

### The Anthropic-upstream gate

Under `anthropic-style`, a breakpoint is only emitted when the _model_ names an
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

### Ollama (local): `keep_alive`

Ollama unloads a model — and its KV cache — five minutes after its last
request. That is shorter than an agent spends reading files and thinking, so
the cache was routinely evicted **between consecutive turns of one task**, and
every eviction re-prefills the whole transcript. On a local runtime that is not
a bill, it is wall-clock: the difference between a second and a minute on a
long context.

Every request now carries `keep_alive`, default **30m**. Configure it:

```toml
[llm.ollama]
keepAlive = "1h"     # or "-1" to hold indefinitely, "0" to unload at once
```

`GEAR_OLLAMA_KEEP_ALIVE` overrides it for one run.

`listModels` also reports each model's **real context window** now (via
per-model `/api/show`), instead of names only — every locally pulled model
previously fell to the tokenizer's conservative default and was compacted far
below its actual window.

## Measured cache behaviour

Every row below is a real pair of requests through Gear's own adapters
(`scripts/verify-cache.ts --provider <id>`): one turn to write the prefix, one
to read it back, on a ~4.8k-token prefix unique to each run so a previous run's
warm cache cannot flatter the result. **Rows that say "not measured" were not
measured** — no credential on this machine, or the provider refused. None of
them is a guess dressed as a number.

Measured **2026-09-02**.

| Provider                    | Model                     | Policy                     | Turn 1                 | Turn 2                | Hit rate     | Verdict                                          |
| --------------------------- | ------------------------- | -------------------------- | ---------------------- | --------------------- | ------------ | ------------------------------------------------ |
| `openrouter`                | `minimax/minimax-m3:free` | implicit (adapter default) | input 4250, cached 132 | input 23, cached 4359 | **99.5%**    | works                                            |
| `openrouter`                | `minimax/minimax-m3:free` | `--force-breakpoints`      | input 4250, cached 132 | input 23, cached 4359 | **99.5%**    | identical — forcing buys nothing                 |
| `google`                    | `gemini-2.5-flash`        | implicit                   | input 5099, cached 0   | input 15, cached 5085 | **99.7%**    | works, with no cache handle                      |
| `ollama-turbo`              | `gpt-oss:20b`             | was "implicit"             | input 4301, cached 0   | input 4301, cached 0  | **none**     | no cache observable → policy corrected to `none` |
| `codex`                     | `gpt-5.6-luna`            | server-side                | —                      | —                     | not measured | plan quota exhausted (429) at measurement time   |
| `ollama` (local)            | —                         | KV cache                   | —                      | —                     | not measured | no local runtime on this machine                 |
| `anthropic`                 | `claude-haiku-4-5`        | native `cache_control`     | —                      | —                     | not measured | no credential                                    |
| `openai`                    | `gpt-4o-mini`             | `prompt-cache-key`         | —                      | —                     | not measured | no credential                                    |
| `deepseek` / `groq` / `xai` | —                         | implicit (documented)      | —                      | —                     | not measured | no credential                                    |
| `bedrock`                   | —                         | `anthropic-style`          | —                      | —                     | not measured | no AWS credential on this machine                |

Live requests spent producing this table: **openrouter 5** (one refused 402,
four served), **google 2**, **ollama-turbo 2**, **codex 1** (refused 429),
everything else **0**.

### What the measurements changed

**No widening on OpenRouter.** P8.2 planned to force breakpoints per upstream
family and widen `wantsCacheBreakpoints` wherever cached tokens moved. On
`minimax/minimax-m3:free` implicit and forced are byte-for-byte identical —
99.5% either way — reproducing the 2026-08-26 `stealth/ox-alpha` result on a
current model. The gate stays narrow.

The paid upstreams (`anthropic/*`, `openai/*`, `deepseek/*`) could **not** be
tested: this OpenRouter account has never purchased credits and every paid
route returns 402. So the per-family sweep is **incomplete**, and the
`anthropic-style` policy the adapter ships still rests on the earlier
measurement rather than a fresh one.

**`ollama-turbo` was claiming a cache it does not have.** It was declared
`implicit` from documentation. Two turns of a byte-identical prefix both
reported `input=4301, cached=0`. Either the host does not cache or it does not
report a cached-token count; either way there is nothing to claim, so the
policy is now `none` and its hit rate reads **"no data"** rather than 0%.

**Google needs no explicit cache.** See below.

### Google `cachedContent`: measured, then declined (P8.3)

P8.3 planned to create explicit `cachedContents` handles for the stable prefix,
keep a `(model, prefixHash) → handle` map with a TTL, and send `cachedContent`
on each request. The instruction was to **measure with `verify-cache.ts`
first**. The measurement says not to build it:

```
$ bun run scripts/verify-cache.ts --provider google --model gemini-2.5-flash
turn 1  input=5099  cached=0     written=0
turn 2  input=15    cached=5085  written=0
PASS — the shared prefix was served from cache (5085 tokens, 99.7%).
```

Gemini's **implicit** caching already returns 99.7% of the prefix from cache,
free and automatic, on exactly the request shape the agent loop produces.
Explicit context caching would add a create/refresh/delete lifecycle, a TTL to
get wrong, a per-model minimum-token floor, and — the decisive part —
**storage billed per token-hour** for content the free path is already serving.
In a phase whose whole point is cost per task, building it would raise the
bill to buy 0.3%.

Not built. Revisit only if a model in use is found whose implicit hit rate is
poor and whose prefix is large and long-lived enough to amortise storage.

---

## Enterprise routes

Three of the providers above are also reachable through a cloud account rather
than the vendor's own console: **AWS Bedrock**, **Google Vertex AI** and **Azure
OpenAI**. For a team, that is often the only way the models are reachable at
all — the traffic has to stay inside an account with a signed agreement, a data
residency commitment and an existing bill.

Each route is an **auth-and-endpoint variant over the adapter it wraps**, not a
new transport. The Messages body, the streaming grammar, the thinking
parameters, the tool translation, the `cache_control` breakpoints and the usage
accounting are the vendor's, unchanged, in one file. What each route owns is a
URL shape and a way of proving who you are.

That is a deliberate constraint, and it is why these landed as a few hundred
lines each rather than three more adapters to keep in sync. Every future fix to
Anthropic streaming reaches Bedrock and Vertex for free; a second copy of that
parser would have drifted by the next model release.

**None of them stores a credential.** They authenticate with the machine's own
cloud chain — the same one `aws`, `gcloud` and `az` read — under a new auth
method, `chain`. `gear login bedrock` therefore reports rather than prompts: it
says whether the chain resolves and, when it does not, exactly which command
fixes it. A tool asking someone to paste a long-lived cloud credential into its
keychain would defeat the reason the route exists.

```
$ gear providers
  ●  AWS Bedrock            chain    signed in · profile default
```

### AWS Bedrock (`bedrock`)

Anthropic models through the Bedrock Messages API.

```bash
export AWS_PROFILE=work            # or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
export AWS_REGION=us-east-1
gear login bedrock                 # reports what the chain resolved; stores nothing
gear use bedrock
```

```toml
[providers.bedrock]
region = "eu-central-1"
inferenceProfile = "eu"   # "us" | "eu" | "apac" | "none"; defaults to the region's family
```

| Piece             | What Gear does                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint**      | `POST /model/{modelId}/invoke-with-response-stream` on `bedrock-runtime.<region>.amazonaws.com` (`/invoke` when not streaming)                                      |
| **Body**          | the Anthropic Messages body with `model` and `stream` removed (the path says both) and `anthropic_version: "bedrock-2023-05-31"` added                              |
| **Betas**         | an `anthropic-beta` header is translated into the body's `anthropic_beta` array, which is where Bedrock wants it — so interleaved thinking still works here         |
| **Auth**          | SigV4 over the standard chain: env vars → `~/.aws/credentials` + `~/.aws/config` with `AWS_PROFILE` → web identity (`AWS_WEB_IDENTITY_TOKEN_FILE`) → container role |
| **Streaming**     | the `vnd.amazon.eventstream` framing is decoded and re-emitted as SSE, so the shared Anthropic parser reads it unchanged                                            |
| **Errors**        | AWS answers `{"message": …}` with the class in `x-amzn-errortype`; both are re-shaped into Anthropic's error envelope so a 403 does not surface as an empty string  |
| **`countTokens`** | estimated locally — Bedrock has no count-tokens endpoint, and a 404 per measurement is worse than an estimate                                                       |
| **`healthCheck`** | "do credentials resolve", never a real completion. A probe that spends money is a bill, not a probe                                                                 |
| **Discovery**     | `gear models bedrock` calls ListFoundationModels on the control plane                                                                                               |

**IMDS is deliberately not in the chain.** The instance metadata service is the
SDKs' last rung, and off EC2 it is a request to a link-local address that never
answers — a timeout plus retries on every cold start. Gear resolves credentials
on the _no-credential_ path too (`gear providers` has to print an honest row),
so the probe is omitted. Anything running on EC2 with an instance role can
export the standard variables or name a profile; containers are covered by the
container-credentials rung, which is the case that matters in CI.

**Model ids are cross-region inference profiles.** Current Anthropic models on
Bedrock are not invokable by their bare foundation-model id; they need a
geography prefix (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and a `us.`
id is rejected outside US regions. Gear ships one catalogue of `us.` ids and
rewrites the prefix to match the configured region, so an account in Frankfurt
reaches `eu.` models without a second copy of every row in the picker. Ids that
genuinely _are_ on-demand (the 3.5 line) carry no prefix and never gain one —
adding one would turn a working call into "model not found". Set
`inferenceProfile = "none"` to send ids untouched.

**What is proven, and what is not.** There is no AWS credential on this machine,
so nothing here has made a live Bedrock call. What _is_ proven, by
`tests/unit/gateway/`:

- the SigV4 signer against AWS's own published vectors — the documented
  signing-key derivation plus the `get-vanilla`, `post-vanilla` and
  `get-vanilla-query-order-key-case` cases, asserted at the canonical request,
  the string to sign, and the signature;
- the event-stream decoder against recorded frames, including a frame split
  across reads and a corrupted checksum, with CRC-32 checked against the
  universal `crc32("123456789") == 0xCBF43926`;
- the request Gear builds — path, body, signed headers, no `x-api-key` — and a
  recorded response streaming back through the Anthropic parser with its usage
  and cache counters intact;
- the credential chain, rung by rung, against injected files and fetch.

What is **not** proven is that AWS accepts it. `GEAR_LIVE_BEDROCK=1 bun test
tests/integration/enterprise-providers.test.ts` runs that check on a machine
that has a credential, and skips with a printed reason on one that does not.

---

## Providers that were removed

### `copilot` — removed 2026-09-02 (P8.5, decision D5)

**Decided from evidence, not preference.** D5 said to drop GitHub Copilot
_unless the founder uses it_. The answer was in `~/.gear/gear.db`:

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

Then `/model custom/<the-model-you-loaded>`. The pick is remembered like any
other: `custom` has no preset — it is the escape hatch for a provider this
catalogue does not know — so the startup gate treats "is it usable?" as "is a
base URL and a key configured?" rather than looking it up. Both entry points
(the terminal and the engine host) ask the same question, so a session opened
by `gear serve` or the desktop resumes on the same endpoint the terminal does.

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

## The reasoning-depth dial, per provider

Gear has shipped a depth dial that went nowhere **twice**: Codex ran at the
server default because `reasoning.effort` was never sent while "max" sat in the
picker looking selectable, and Gemini dropped `thinking.effort` inside its
adapter, so `/effort high` on a Gemini session changed nothing. Both were
invisible from inside the process — the request looked fine and the model
answered; only the depth was quietly wrong.

Each provider names the dial differently, and one of them does not have one:

| Provider                     | Wire field                                                                      | Values                                                            | Notes                                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`                     | `reasoning_effort`                                                              | low / medium / high                                               | gpt-5 and o-series only; the family also swaps `max_tokens` for `max_completion_tokens`. Thinking off maps to the model's floor, because omitting the field is not "off" — it defaults to medium and eats the completion budget on hidden reasoning |
| `codex`                      | `reasoning.effort`                                                              | low / medium / high / xhigh / max                                 | measured against the live backend; the gpt-5.6 line rejects `minimal`, so it is floored to `low`                                                                                                                                                    |
| `google`                     | `generationConfig.thinkingConfig.thinkingBudget` (2.5) or `thinkingLevel` (3.x) | low → 4,096 · medium → 8,192 · high → 16,384 · xhigh/max → 24,576 | Gemini has no effort field: depth is a token budget. 2.5 Pro's floor is 128 and it cannot be switched off. An explicit `budgetTokens` still wins over the effort                                                                                    |
| `anthropic`                  | `thinking: { type, budget_tokens }`                                             | —                                                                 | adaptive or budgeted thinking; **no effort field exists**, and none is invented                                                                                                                                                                     |
| every OpenAI-compatible host | —                                                                               | —                                                                 | no dial; a bare `gpt-5` typed against OpenRouter keeps the classic params OpenRouter normalizes                                                                                                                                                     |

`reasoningEffortsFor(provider, model)` is the one source the model picker and
the status line read, so a dial is offered **only where the wire actually
carries it**. `tests/unit/gateway/reasoning-wire-fields.test.ts` asserts the
exact field per provider, including the providers whose correct answer is "no
field at all".

## Per-family tool descriptions

`apply_patch` was already advertised only to the gpt/o-series/codex lineage —
those models were trained on the `*** Begin Patch` envelope and nobody else has
seen it. That gate answers "should this model see this tool". A second, smaller
adapter answers "how should it be described to this model"
(`packages/tool-registry/src/model-families.ts`):

- **gpt**: `edit_file` says to prefer it over `apply_patch` for a single-file
  change — the lineage otherwise reaches for the multi-file envelope on a
  one-line edit, where one context mismatch fails the whole patch.
- **gemini**: `edit_file` says the call _is_ the change — this is the family
  most prone to describing an edit it has not made.
- **claude**: no variant. None has earned one.

A variant may only append; the base description always survives, and an
unrecognized model gets the plain text.

---

## Reading a cache number in the product

Every cost surface — `/cost`, the status line, and `gear audit` — renders a
hit rate through **one** function, `formatCacheRate` in
`packages/orchestrator/src/cost-report.ts`. Its whole job is the rule:

> **`null` renders as "no data". NEVER as "0%".**

A provider that reports no cache counters (Ollama Cloud, measured above) and a
provider whose cache genuinely missed every time are different facts. If they
produce the same screen, the reader is being shown a number nobody measured.

Rates are broken out **per provider** once a session used more than one,
because that is the axis the answer varies on: a run that fell back from a
caching provider to one with none reports a blended rate describing neither,
and the blend is always the flattering number.

`gear audit` on a real session:

```
  Cost  $10.0320 list · $0.0000 paid (subscription) · 3,980,405 in · 114,441 out
  cache  codex · 89% (31,297,024 of 35,277,429 warm) · saved $35.2092 list
```

The saving is in **list** dollars — the number comparable to a competitor's
invoice — because on a subscription route the actual spend is $0.00 and says
nothing.
