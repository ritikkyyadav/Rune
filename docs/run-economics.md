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
would be a guess stacked on an exact number. Bytes are exact, they are what the
caller can measure before sending, and the **ratios** — which is the entire
question — are the same either way.

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

```
        Completions  12   (7 work · 5 governance (42%))
         classifier  3    (34.0k fresh in · 120 out)
         summarizer  2    (30.0k fresh in · 900 out)
      Fresh in / call  18.0k   (32.0k on a governance call)
    Cache read ratio  61%     (740.0k of 1.20M input served warm)
      List estimate  ~$1.42   (~$0.51 of it governance)
 Prompt bytes / call  34.2KB  (measured on 7 of 12 completions)
           doctrine  8.1KB   (24%)
       tool schemas  11.4KB  (33%)
        plan ledger  2.2KB   (6%)
         task state  0.4KB   (1%)
       conversation  12.1KB  (35%)
```

Then, per provider, how many calls went where and how many of those were
governance — on a free-tier run that is the line that explains a 429: one
provider carrying both the work and the overhead.

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
helper = "auto"                       # default: the cheapest healthy connected route
# helper = "off"                      # or "session" — run them on the session model, as before
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

| claim                                                        | how                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| roles and composition reach the cost row and the session log | unit tests + a live mock eval run showing 0.25/task      |
| the parts always sum to the total                            | unit test over a real `AgentLoop` request                |
| the plan ledger is not filed under conversation              | unit test (with-plan vs without-plan)                    |
| the JIT doctrine's effect is visible                         | unit test on the doctrine bytes                          |
| the safety corpus does not regress                           | `eval:auto-safety --offline`, before and after           |
| the helper picks the cheapest healthy connected route        | unit tests against the real capacity + tier tables       |
| the automatic helper never answers a safety question         | unit test                                                |
| the recall fires only on an identical high-confidence allow  | unit tests, including a mechanical-breaker case          |
| **the helper reduces live rate-limit incidents**             | **NOT verified — no live run, no credits**               |
| **the recall's live hit rate on a real run**                 | **NOT verified — the offline corpus cannot exercise it** |
| **a live reviewer populates `confidence` sensibly**          | **NOT verified — needs a live model**                    |

The last three need a live run on a free route with a reviewer that answers.
None was available in this lane. They are the first things to measure in P12.6.
