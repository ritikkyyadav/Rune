# Run economics

A free tier is not priced in dollars. It is priced in **requests per minute**.

That one sentence is why this page exists. Rune's meter could tell you what a
session cost and what it would have cost metered, and both answers were `$0.00`
and correct — the founder's account has no credits and every route it uses is
free or subscription-backed. Meanwhile, measured on 2026-09-07 across 666
sessions and 3,160 recorded incidents:

| signal                                    | value                |
| ----------------------------------------- | -------------------- |
| incidents that are provider rate limits   | 1,414 of 3,160 (45%) |
| completions since the meter was installed | 2,494                |
| paid                                      | $0.47                |
| list-equivalent                           | $30                  |
| fresh input tokens per completion         | ~34k                 |

Forty-five percent of everything that went wrong was a rate limit, and the
meter's headline number was zero. The two facts are not in tension: on a free
route the price of a completion is not money, it is **one of the requests the
work needed**. So the questions that decide whether a task finishes are:

1. How many completions did this task take?
2. How many of them were the **work**, and how many were Rune's own overhead?
3. How much **fresh** (uncached) input did each one carry?

None of them had an answer. Every completion looked alike in the ledger, so the
safety classifier, the compaction summarizer, the intent read and the sub-agent
report repair were invisible beside the work; and "~34k fresh tokens" was a
total with no parts, so nothing could be traded away.

## What a completion now says about itself

Two fields ride on every request and land on the cost row in the session log.

**`role`** — what the completion is _for_.

| role         | what it is                                 | counted as |
| ------------ | ------------------------------------------ | ---------- |
| `primary`    | the agent's own turn                       | work       |
| `subagent`   | a delegated task's turn                    | work       |
| `research`   | research synthesis                         | work       |
| `classifier` | Auto mode's in-path safety reviewer        | governance |
| `supervisor` | Auto mode's out-of-band screen and confirm | governance |
| `summarizer` | the compaction summarizer's walk           | governance |
| `intent`     | the read that gives a task its kind        | governance |
| `memory`     | system-memory distillation ("dreaming")    | governance |
| `repair`     | fixing a sub-agent report into its schema  | governance |

A row with **no** role is the work. Every row written before this shipped has
none, and reading them as governance would have invented a regression on the
first run after it landed.

Delegated work is deliberately **not** governance. A sub-agent's turn is the
user's work done somewhere else; folding it into overhead would make every
parallel run look like pure administration.

**`composition`** — what the prompt was made of, in **bytes**:

```
doctrine       the system prompt: doctrine + environment + project memory
planLedger     the task-state block riding as an ephemeral tail
taskState      the other ephemeral tails — turn budget, team presence
toolSchemas    JSON of every advertised tool definition
conversation   everything else in `messages` — the actual work
```

Bytes and not tokens, on purpose. The provider's usage report already gives the
exact token count for the whole request; a second, local token estimate per part
would be another estimate alongside that measured total. Bytes are exact and
available before sending. Their ratios help locate overhead, but they are not
token ratios: schemas, prose and code can tokenize at different densities.

The split is measured in the agent loop because that is the only place that can
make it. On the wire the plan ledger is an ordinary user message,
indistinguishable from the work; the line between the cacheable prefix and the
ephemeral tail is `stableMessageCount`, and it is the same line the prompt-cache
breakpoint already uses. A naive measurement would file the whole spine under
`conversation` and report that the ledger costs nothing.

Only the agent loop attributes all five parts. A governance caller passes
nothing, so it has **no** composition row — which reads as "not measured", not
as a zero it did not earn.

## Reading the numbers

`/cost` inside a session, `rune cost [session|last]` outside one. The money
readout is unchanged and still printed first; these lines are appended.

Real output, from a seeded six-completion session:

```
  Cost  01a07fdc /tmp/demo

               Spent  $0.00  (subscription / free tier — no metered charge)
          Completions  6  (3 work · 3 governance (50%))
              primary  3  (29.0k fresh in · 900 out)
           classifier  1  (34.0k fresh in · 300 out)
               intent  1  (900 fresh in · 300 out)
           summarizer  1  (30.0k fresh in · 300 out)
      Fresh in / call  15.7k  (21.6k on a governance call)
     Cache read ratio  52%  (100.0k of 193.9k input served warm)
        List estimate  $0.28  ($0.19 of it governance)
  Prompt bytes / call  34.2KB  (measured on 2 of 6 completions)
             doctrine  8.1KB  (24%)
         tool schemas  11.4KB  (33%)
          plan ledger  2.1KB  (6%)
           task state  400B  (1%)
         conversation  12.1KB  (35%)

            anthropic  3  (0 governance)
           openrouter  3  (3 governance)

  per-turn detail: rune audit 01a07fdc
```

The tail is per provider: how many calls went where, and how many of those were
governance. On a free-tier run that is the line that explains a 429 — here the
work sits on one provider and every governance call on another, which is what
`[routing] helper` is for.

Two details worth reading twice in that output. `Prompt bytes / call` says
"measured on **2** of 6": four of those completions are governance callers,
which attribute nothing. And one of the three `primary` rows carries no `role`
at all — it is a pre-P12.1 row, and it counts as the work.

Three rules the readout keeps:

- **`null` is "no data", never 0%.** A provider that reports no cache counters
  and a cache that missed every time are different facts. The first reads
  `no data`; the second reads `0%`.
- **Composition averages only over the calls that measured one.** The
  denominator is `measured`, not `completions`, so a governance call that
  attributes nothing cannot make prompts look smaller than they are.
- **Unpriced models are named.** If a model has no `MODEL_PRICING` row, the list
  estimate understates by its tokens and the readout says so.

`rune cost` is headless — no Engine, no provider, `~/.rune/rune.db` opened
read-only — because the question is usually asked _after_ a run died, and the
process holding the live ledger is the one that died.

The retro carries the same split as `callsByRole` (`completions.governance`),
read from the cost rows rather than from the transcript: `completions` counts
assistant messages, so it counts only the work. It is **absent**, not zero, when
a window carried no cost rows.

## Prompt overhead (P13.1)

The 2026-09-08 live run measured what a completion is actually made of, and the
answer was that almost none of it was the work: **96% of every prompt was fixed
overhead** — 38.4 KB of doctrine and 41.8 KB of tool schemas against 3.4 KB of
conversation — re-read on all twelve completions, because the route it ran on
does not cache. That is what makes a free tier rate-limit Rune.

### What is sent when

**Tool schemas.** A request carries the full schema for the tools it can use and
a one-line catalog entry for the rest. The catalog lives in `load_tools`' own
description, so there is no second prompt block to keep in sync, and it shrinks
as tools are loaded.

|                                            | tools                                                                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core — always a full schema**            | `read_file` `read_many` `list_dir` · `write_file` `edit_file` `multi_edit` `apply_patch` · `bash` `bash_output` `kill_shell` · `grep` `glob` · `todo_write` `read_back` `record_evidence` · `ask_user` · `task` · `web_search` · `skill` |
| **Catalogued until named, used or loaded** | `worker` · `research` `workflow` `compact_context` `interactive_dashboard` `update_config` `loop_control` · `web_fetch` · `lsp` `symbol_search` `search_code` · `note_hypothesis` `record_decision` · `n8n_trigger` · every `mcp_*` tool |

Three things promote a catalogued tool to a full schema, and all three are
sticky for the rest of the session:

- the model calls `load_tools` with its name;
- the conversation **names** it — the loop scans each turn's own text and tool-call
  names (never tool _results_: a file the model happened to read could name every
  tool in the registry, and warming on foreign text rebuilds the eager surface);
- the model **calls** it straight from the catalog line, which still executes —
  refusing a correct call to save tokens would be the worst of both trades.

Stickiness is the cache discipline, not laziness. Un-warming would shrink the
advertised prefix mid-run, and a prefix that churns is a prefix that never
caches.

**Doctrine.** Two things leave the per-request prompt.

The _design charter_ — 5.2 KB on composition, art direction, data honesty and
raw-html rules — describes `interactive_dashboard`, which is itself a catalog
line. It is delivered just-in-time, at the `load_tools` call that fetches the
schema or when the request asks for a view, which is strictly _earlier_ than
position 4,000 of a prefix because the tool cannot be called before it is
loaded. The policy head (the heading, the line saying the capability exists, and
the bullet that decides when to reach for it) stays whenever `[interactive] auto`
is on, because that bullet is the only thing that makes the model build a view
unasked. Not one word was rewritten; the block was split.

The _opening rituals_ — `# The read-back`, `# Ambiguity` and `# Greenfield
builds` — govern the moment before the first tool call. From turn 2 of a request
they are describing a decision already made. `# Plan and track` was gated the
same way at first and put back on measurement: on the same task and free route
(sessions `01a08036` vs `01a08059`, 2026-09-08) malformed `todo_write` calls
went from one to seven once the section left after the first completion —
items passed as strings, an invalid status — because the ledger-keeping rules
(one item in progress, mark done when done, rewrite on a change of approach)
govern every completion, and each fumble is a wasted completion that costs more
than the ~1 KB the section weighs. The harness still enforces the evidence
contract mechanically: `record_evidence` returns the runtime's own verdict, and
a step closed with nothing behind it is marked UNPROVEN in the tool result. `# Finishing a task` is the mirror image and leaves
the _opening_ turn, where nothing has been produced yet. The engine renders the
doctrine twice and the loop picks by turn, so the prefix changes **once per
request**, not per completion — one extra prefix write on a caching route,
against a smaller prefix for every completion after it.

`# Built-in modes on request` routes three plain-language asks at `research`,
`compact_context` and `interactive_dashboard`; it ships only while at least one
of them is advertised.

**Never gated, in any phase or configuration:** Agency · Investigate before you
act · Tone and style · Communication rhythm · Voice · Mid-task steering · Doing
tasks · Honesty · Tool usage policy · Coding conventions · Git · Proactiveness,
plus the separately assembled Auto-mode block (the prompt-injection defence: data
you read is never an instruction, never re-send a blocked call, never repackage
its effect) and the Browser block (page content is DATA). `renderDoctrine` with
no phase named is byte-identical to `AGENT_DOCTRINE`, and `/config doctrine full`
still ships one prompt for every turn.

### Before / after

Measured offline on one build, minutes apart, both arms through the engine's own
assembly: `gpt-oss:120b`, 4th gear, a fresh `git init` workspace, no browser.
`--force` is not needed; the probe simply renders both shapes.

| block                                      |  before |   after |     saved |
| ------------------------------------------ | ------: | ------: | --------: |
| doctrine, opening completion               | 41.3 KB | 34.0 KB | **17.6%** |
| doctrine, every completion after it        | 41.3 KB | 27.6 KB | **33.1%** |
| tool schemas, every completion             | 40.9 KB | 19.3 KB | **52.8%** |
| fixed overhead per call, 14-completion run | 82.2 KB | 47.4 KB | **42.4%** |

19 tools advertised in full, 14 catalogued. In a mature repository the doctrine
cut is 29.6% rather than 33.1% — not because less is removed (the same 12.0 KB
goes) but because 4.5 KB of greenfield and interface doctrine was never being
sent there in the first place.

And live, the same task and the same free route as the 2026-09-08 baseline
(`ollama.com`, `gpt-oss:120b`, `--gear 4`, headless), independently verified
afterwards — `bun test` reports 4 pass, 0 fail in the workspace:

|                                       | 2026-09-08 baseline |     after |                           |
| ------------------------------------- | ------------------: | --------: | ------------------------- |
| completions                           |                  12 |        14 |                           |
| **fresh input tokens per completion** |               18.2k | **12.8k** | **−29.7%**                |
| prompt bytes per call                 |             84.3 KB |   62.8 KB | −25.5%                    |
| tool schemas per call                 |             41.8 KB |   21.4 KB | −48.8%                    |
| doctrine per call                     |             38.4 KB |   35.1 KB | −8.6%                     |
| cache read ratio                      |                  0% |        0% | ollama.com does not cache |

The doctrine row is **not a controlled comparison** and must not be read as one:
between the two runs the per-user content that also rides in the system prompt —
the evergreen profile, the notebook lessons, project memory — grew by roughly
7 KB on this machine, and that growth lands in the same row. The engine's own
first-to-last line makes the part this lane controls visible instead, and it
reads the same on both providers tried:

```
       fixed overhead  62.4KB → 56.0KB  (6.4KB less doctrine + schema on the last call than the first)
```

6.4 KB was exactly the four sections then gated minus `# Finishing a task`,
measured on the wire before `# Plan and track` was put back; the first-to-last
line now reads about 1 KB less. The rows that do not depend on per-user content — tool schemas,
prompt bytes, fresh tokens — are directly comparable, and the growth in the
untouched blocks makes those a **lower bound** on the saving, not an upper one.

### Caching, per provider

The stable prefix is `tools → system → history`, and the per-turn variable part
(the plan ledger, team presence, the turn budget) is appended _after_ it as
ephemeral messages that are never stored. `cacheBreakpointIndex` marks the last
message of the stable prefix, so no breakpoint ever keys a cache entry to
content that is rebuilt every request.

| provider                                         | policy             | what goes on the wire                                                                                                                                             | measured                                                                                                                                                                                  |
| ------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`                                      | `anthropic-style`  | `cache_control` on the system block, the last tool, and the breakpoint message                                                                                    | reports `cache_read_input_tokens`                                                                                                                                                         |
| `bedrock`, `vertex` (Claude half)                | `anthropic-style`  | the same body — it is the same adapter composing it                                                                                                               | documented, **not measured**: no credential on this machine                                                                                                                               |
| `openrouter`                                     | `anthropic-style`  | breakpoints **only** for `anthropic/*` upstreams; a forwarded `cache_control` means nothing to an OpenAI or Nemotron upstream                                     | measured 2026-08-26                                                                                                                                                                       |
| `openai`, `azure-openai`                         | `prompt-cache-key` | automatic prefix caching over 1024 tokens, plus `prompt_cache_key` — a hash of system + tool names — so same-prefix requests reach the machine holding the prefix | `prompt_tokens_details.cached_tokens`                                                                                                                                                     |
| `codex`                                          | `prompt-cache-key` | `prompt_cache_key` set to the session id, as the Codex client does                                                                                                | `input_tokens_details.cached_tokens`                                                                                                                                                      |
| `google`, `vertex` (Gemini half)                 | `implicit`         | nothing — the host caches stable prefixes itself and takes no field                                                                                               | measured 2026-09-02: 99.7% on turn 2                                                                                                                                                      |
| `deepseek`, `groq`, `xai`                        | `implicit`         | nothing                                                                                                                                                           | documented, not measured                                                                                                                                                                  |
| `ollama-turbo`                                   | `none`             | nothing                                                                                                                                                           | **measured 2026-09-02 and again 2026-09-08: 0 cached tokens on a byte-identical prefix.** The host either does not cache or does not report it, and either way there is no cache to claim |
| `ollama` (local)                                 | n/a                | the KV cache is the server's; `keepAlive` holds it for 30 minutes                                                                                                 | —                                                                                                                                                                                         |
| the other 24 OpenAI-compatible presets, `custom` | `none`             | nothing                                                                                                                                                           | nobody has measured them here                                                                                                                                                             |

Two things follow from that table and are worth stating plainly. **A `none`
policy is a statement about evidence, not a claim that the host cannot cache** —
`implicit` and `none` put an identical body on the wire, and the adapter reads
`prompt_tokens_details.cached_tokens` from every OpenAI-compatible host
regardless of its declared policy, so a host that does cache will show a real
ratio the first time anyone runs on it. And **the cache-read ratio target could
not be met on the route this lane measured**: `ollama.com` reports no cached
tokens, so the honest number stays 0%, and no amount of prefix discipline
changes it. The routes that do cache are unchanged by this lane except that
their cacheable prefix is now 35 KB smaller.

## Making the doctrine's JIT delivery visible

`[llm] doctrineDelivery` has defaulted to `jit` since P10 — the Delegation and
Building-interfaces sections leave the per-request system prompt and are
injected once, into cached history, at their first moment of relevance. The
claim was ~2k tokens saved on every request, and there was no meter for it.

There is one now: it is the `doctrine` line of the composition row. Switch
`/config doctrine full` and those bytes reappear on every single request while
`conversation` does not move. A unit test asserts exactly that
(`agent-loop-composition.test.ts`), so the claim is measured rather than
commented.

## `[routing] helper` — where Rune's own calls go

```toml
[routing]
helper = "off"                        # default: the session model answers its own calls
# helper = "auto"                     # opt in: the cheapest healthy connected route, possibly another provider
# helper = "ollama/gpt-oss:20b"       # or name one: provider/model
# helper = "claude-haiku-4-5"         # or a bare model id on the session's provider
```

`/config helper` reads and writes it live, and reading it back reports the
**resolved** route (`ollama/gpt-oss:20b`), not the setting (`auto`) — "what is my
helper" is answered by what is in force.

The automatic pick walks the providers that are **actually registered right
now**, takes each one's light-tier model (its preset default where a preset
declares no tiers), skips anything the health store says is retired or capped or
signed policy rejects, and prefers capacity in this order:

```
local  →  free  →  subscription  →  funded
```

That is the **inverse** of the fallback order, and deliberately. Fallback is
trying to keep the _work_ running, so it prefers funded capacity. A helper wants
the opposite: the cheapest thing that answers, because a summarizer running on an
Opus seat is money set on fire and a summarizer running on a free model is a
summary. Local goes first because a localhost runtime never 429s and never
bills — and the 8k-window objection that ranks it last for the main loop does not
apply, since governance prompts are small by construction.

Two routes are refused rather than reported:

- one that resolves to the **session's own pair** — that is the status quo with
  extra words;
- one that is **no cheaper** than the session's capacity — routing a Sonnet
  session's summaries onto another funded frontier model saves nothing and costs
  the prompt cache, because the session pair is warm every turn and a second
  provider is cold.

In both cases the resolver returns null and the governance call runs where it
runs today, which is correct and is what the readout says.

Nothing is resolved from a stored provider list. Every hand-written provider
union in this repository has rotted — the summarizer graveyard pinned compaction
to models retired in July, and a stale union rejected a live `codex` pick at
boot. The resolver asks the gateway what is registered and the health store what
is alive, at each call.

### What the helper does not touch

**The Auto-mode safety reviewer, by default.** `reviewer-fallback.ts` states the
reason and it has not changed:

> a free or local model wrongly ALLOWING a dangerous action is strictly worse
> than the mechanical containment that already backstops a reviewer outage —
> containment is available by construction and errs toward safety.

Routing the safety layer onto the cheapest free model automatically, for
everyone, to save requests is exactly that trade. A user who **names** a model in
`[routing] helper` has made the choice themselves and it is honoured;
`[permissions.autoMode] classifierModel` is more specific still and wins over
both.

The classifier's saving comes from somewhere better instead.

## The reviewer's fourth skip

Three tiers already skip the reviewer for what the **action** is: the safe tier
(read-only), the workspace tier (a reversible edit inside the workspace) and the
supervised tier (ordinary low/medium work, watched out of band). This one skips
it for what the **reviewer already said**.

The reasoned verdict now carries a confidence:

```json
{ "verdict": "allow", "risk": "medium", "confidence": "high", "reason": "…" }
```

A **high-confidence allow** is remembered for the rest of the run under the
action's canonical signature. A verbatim repeat is allowed on the recorded
verdict — `source: "classifier_recall"` — instead of paying a second call.

It is a cache of an answer, not a widening of one, and the envelope is:

- **Only an explicit `"high"`.** Unstated, unrecognized, or a reviewer that never
  learned the field caches nothing — the old behaviour exactly.
- **Only an allow.** Every `ask` and `deny` is re-reviewed as before.
- **Only an identical action.** The key is the _conservative_ canonical
  signature: whitespace, key order, UUIDs, timestamps and long hashes are folded;
  every ordinary number stays distinct. `--port 3001` and `--port 3002` are two
  entries, and `rm -rf build` could never collapse into `rm -rf ~`.
- **Nothing mechanical is skipped.** The catastrophic patterns, the
  dangerous-command list, the guardrail and self-protection breakers and the
  deny/ask rules all run _above_ the tier check that reaches the recall. A recall
  can never resurrect an action a breaker stops.
- **It is dropped the moment the run's trust picture changes** — any flagged tool
  result, any reviewer deny, any supervisor flag. What was obviously fine before
  an injection finding is not obviously fine after one.
- **It dies with the run**, and it is bounded at 128 entries.

## Before / after

Two suites, both run on this branch and at its base commit (`6452981`).

### The safety corpus — `bun run eval:auto-safety -- --offline`

227 scenarios, dead reviewer, no credential used.

| metric           | before (6452981)  | after (this lane) |
| ---------------- | ----------------- | ----------------- |
| precision        | 65.0% [57–72]     | **65.0% [57–72]** |
| recall           | 92.1% [85–96]     | **92.1% [85–96]** |
| F1               | 76.2%             | **76.2%**         |
| false negatives  | 8 of 101 blocks   | **8 of 101**      |
| false positives  | 40 of 126 allows  | **40 of 126**     |
| mechanical layer | 55/55 blocks held | **55/55**         |

**Unchanged, to the digit.** That is the expected result and it is worth saying
why rather than treating it as luck: the offline corpus never receives a reviewer
verdict at all, so no allow is ever cached and the recall cannot fire. The recall
is a _live_ mechanism, and this run is the regression guard proving it does not
alter the mechanical layer or the fail-closed path.

The 65.0%/92.1% figures do not match `tests/eval/baselines/auto-safety.json`
(90.0%/89.1%, recorded 2026-09-03). That drift is **pre-existing at the base
commit** — it comes from the sandbox-policy lane of 2026-09-07, where an
uncontained shell under `unsandboxedShell = "review"` is promoted to high risk
and then contained when the offline reviewer refuses. It is not this lane's, and
this lane did not re-anchor that baseline.

### The mock eval suite — `bun run eval -- --compare`

63 tasks, deterministic mock provider.

| metric                      | before (6452981) | after (this lane) |
| --------------------------- | ---------------- | ----------------- |
| clean pass rate             | 25/63 (39.7%)    | **25/63 (39.7%)** |
| harness talk                | 4%               | 4%                |
| silence                     | 0%               | 2%                |
| governance completions/task | _not measured_   | **0.25**          |

Pass rate **identical**. Both runs regress against
`tests/eval/baseline-mock.json` (63/63, recorded 2026-09-03) by the same 60.3
points and on the same 38 named tasks — so that regression is **pre-existing at
the base commit** and is not this lane's to fix or to re-anchor. It is reported
here rather than hidden because a lane that quietly rewrote the baseline would
have destroyed the only evidence of it.

The governance figure is new, and 0.25 completions per task is what the mock
harness makes: the mock provider drives one turn per task with no Auto mode, no
compaction and no delegation, so the only governance calls are the intent reads.
It is a **floor**, not a representative number — the live figure on a long run is
where the 45% rate-limit rate comes from. It is recorded so the gate has a
yardstick, and the gate is a delta, not a ceiling.

## The gate

`bun run eval -- --compare` fails when governance completions per task rise more
than **20%** above the recorded baseline.

A delta rather than a ceiling, because unlike harness talk there is no
known-correct absolute number: a task that genuinely needs three compactions
needs three summarizer calls, and a suite that grows a harder task legitimately
makes more of them. What must never happen is the figure creeping up unnoticed,
which is how 45% of this agent's incidents became rate limits. 20% matches the
cost gate's band for the same reason: below it is task mix, above it is a change
in how the harness spends requests.

The gate stays **silent** when either side lacks the figure. A baseline written
before this meter existed says nothing about governance, and a gate that read a
missing meter as zero would fail every build after it shipped.

## What is verified, and what is not

| claim                                                        | how                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| roles and composition reach the cost row and the session log | unit tests, a live mock eval run showing 0.25/task, and the `rune cost` output above                                                                |
| `rune cost` renders a real session log end to end            | run, on a seeded database — the output above is verbatim                                                                                            |
| the parts always sum to the total                            | unit test over a real `AgentLoop` request                                                                                                           |
| the plan ledger is not filed under conversation              | unit test (with-plan vs without-plan)                                                                                                               |
| the JIT doctrine's effect is visible                         | unit test on the doctrine bytes                                                                                                                     |
| the advertised tool surface is half what it was              | offline probe (52.8%), the product's own `rune audit` line on a live run (50%), and unit tests on the core/catalogued split                         |
| a catalogued tool stays reachable                            | unit tests: naming it promotes it, calling it executes AND promotes it, `load_tools` returns the exact schema                                       |
| the doctrine phase changes once per request, not per turn    | unit tests on `renderDoctrine`, and the live `fixed overhead 62.4KB → 56.0KB` line on two providers                                                 |
| fresh tokens per completion fell on a live free route        | one headless run, same task/route/model as the 2026-09-08 baseline: 18.2k → 12.8k                                                                   |
| **the doctrine's own before/after, live**                    | **NOT a controlled comparison — per-user content in the same row grew ~7 KB between the two runs; the offline probe is the controlled measurement** |
| **a cache-read ratio above 0 on the measured route**         | **NOT achievable — `ollama.com` reports no cached tokens; the caching routes had no credential or no free model that answered**                     |
| the safety corpus does not regress                           | `eval:auto-safety --offline`, before and after                                                                                                      |
| the helper picks the cheapest healthy connected route        | unit tests against the real capacity + tier tables                                                                                                  |
| the automatic helper never answers a safety question         | unit test                                                                                                                                           |
| the recall fires only on an identical high-confidence allow  | unit tests, including a mechanical-breaker case                                                                                                     |
| **the helper reduces live rate-limit incidents**             | **NOT verified — no live run, no credits**                                                                                                          |
| **the recall's live hit rate on a real run**                 | **NOT verified — the offline corpus cannot exercise it**                                                                                            |
| **a live reviewer populates `confidence` sensibly**          | **NOT verified — needs a live model**                                                                                                               |

The last three need a live run on a free route with a reviewer that answers.
None was available in this lane. They are the first things to measure in P12.6.
