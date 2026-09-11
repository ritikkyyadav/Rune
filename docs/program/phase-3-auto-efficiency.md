# Phase 3 — make Auto efficient at equal task quality

**Written 2026-09-11 at `3c3ee67` (branch `gear/phase-0-stabilize`), read-only survey.** Nothing
under `packages/` or `crates/` was changed. No model was called, no network request was made, no
provider was billed, and nothing was written to `~/.rune/rune.db` — every database in this document
was opened `readonly: true`.

Three files were created: the analysis script `scripts/overhead-report.ts`, its output
[`docs/evidence/overhead-report-20260911.json`](../evidence/overhead-report-20260911.json), and this
design. Every number below is reproducible with:

```
bun run scripts/overhead-report.ts </dev/null
```

This is the measurement Phase 3 of [`docs/CLAUDE_CODE_HANDOFF.md:195`](../CLAUDE_CODE_HANDOFF.md)
asks for before anything is built, plus the build plan it authorises. It does not claim any
efficiency improvement; it says where the cost and the clock actually go, how confident each number
is, and what has to be instrumented before a change can be measured.

---

## 1. The instrument

`scripts/overhead-report.ts` reads two corpora and never mixes them.

| Corpus     | What                                                                                 | Size                                                                  | Attribution                            |
| ---------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------- |
| **corpus** | The founder's `~/.rune/rune.db`                                                      | 684 sessions, 26,861 events, 2,931 cost rows, **221 runs with usage** | 437 rows tagged (14.9%), rest inferred |
| **pilots** | 15 per-run databases under `.codex/**/profile/rune.db` written by the comparison rig | 161 completions across 15 controlled runs                             | **100% tagged — exact**                |

A **run** is one user turn: from a `user_msg` with no `harness` marker to the event before the next
one. A run with no cost row is excluded, which is the handoff's "every run that has usage rows".

Every field is extracted in SQL. No prompt text, tool argument, file body or provider response
entered the analysis process; the one string that does — a `run_trace` notice, which is a
harness-authored constant — is reduced to a label before it is counted, so a workspace URL in the
UI-review notice cannot reach the report.

### 1.1 What is exact

- **`CostEntry.role`** — `packages/llm-gateway/src/types.ts:360`, defined at `:243-265`, carried
  through `packages/llm-gateway/src/gateway.ts:891` into
  `packages/llm-gateway/src/cost-tracker.ts:274`, persisted at
  `packages/orchestrator/src/engine.ts:6289`. Set by nine call sites:
  `agent-loop.ts:1667` (`primary`), `auto-mode.ts:531` and `:913` (`classifier` / `supervisor`),
  `context-engine.ts:974` (`summarizer`), `engine.ts:2419` (`intent`), `engine.ts:4236` (`memory`),
  `subagent-result.ts:581` (`repair`), `worker.ts:672` and `subagent.ts:318` (`subagent`),
  `research.ts:628` (`research`).
- **Token, cache-read and cache-write counts** — the provider's own usage block.
- **Reviewer latency** — `safety_decision.timings {mechanicalMs, classifierMs, retryMs}`, computed
  at `packages/orchestrator/src/auto-mode.ts:1842`, persisted with `durationMs`, `callId` and `turn`
  at `packages/orchestrator/src/engine.ts:3367`.
- **Auto-mode detection** — a run is Auto when it contains any `safety_decision` row. Every writer
  of that event is an Auto path (`engine.ts:2241` held step, `:3152` → `:3354` the in-path review,
  `:3298` the supervisor batch, `:6135` the late verdict). A run where Auto was on but no tool was
  reviewed reads as non-Auto, which understates Auto and never overstates it.
- **Prompt composition, in BYTES** — `CostEntry.composition`
  (`packages/llm-gateway/src/types.ts:367`), measured at `agent-loop.ts:1651` before the ephemeral
  tail is attached.
- **Provider retries and their back-off** — `run_trace type='retry'` with `waitMs`.
- **Compaction** — `auto_compaction` rows with before/after tokens.
- **Free vs paid** — `CostEntry.billing`.

### 1.2 What is inferred, and how accurate the inference is

The script runs its inference on **every** row with the tag hidden, then compares it to the tag on
the 437 rows that carry one. That is a measured accuracy, not a claim.

| Rule                                                                                                  | Attributes to         |  Rows | Measured                                                             |
| ----------------------------------------------------------------------------------------------------- | --------------------- | ----: | -------------------------------------------------------------------- |
| A `safety_decision` with `classifierMs > 0` in the completion's window                                | `supervisor_review`   |    83 | **39/39** governance-tagged rows have one; **1** primary-tagged does |
| A `compaction` / `auto_compaction` row in the window                                                  | `compaction`          |    58 | —                                                                    |
| No assistant message, and the nearest preceding assistant message dispatched a worker still in flight | `workers`             |    38 | **12/12** `subagent`-tagged rows                                     |
| Empty assistant message, or a `run_trace retry` since the previous completion                         | `retries`             |    13 | —                                                                    |
| A `harness` origin marker, a re-prompting notice, or a spine `gate`/`replan` entry since the last one | `harness_followups`   |    74 | —                                                                    |
| Every tool call in the completion was plan bookkeeping                                                | `planning`            |   445 | —                                                                    |
| An assistant message with work in it                                                                  | `primary`             | 2,117 | —                                                                    |
| No assistant message persisted and nothing names another caller                                       | `primary` (weak rule) |    45 | 36/36 such rows in the labelled set are `primary`-tagged             |

The pairing rests on one ordering fact, verified against the busiest session's event stream: the
engine records a completion's cost on the gateway usage listener (`engine.ts:6274`, event at
`:6289`) **before** it drains the assistant message that completion produced (`engine.ts:5329`), so
the events between a cost row and the next cost row are exactly what that completion did.

**Agreement on the 437 tagged rows: super-class 98.2%, exact-role 83.8%.**

Super-class is the fair test — it asks whether the inference put the completion on the right side of
the only line the tag actually draws: a separate model call the harness made, versus the agent's own
turn. Exact-role penalises a split this taxonomy makes on purpose and the database does not label:
`primary`-tagged rows become `planning` (44), `harness_followups` (14) and `retries` (5) when the
sequence says so. The four genuine errors are 3 `repair` rows and 1 `memory` row, which the sequence
cannot see at all, plus 3 `primary` rows called `workers` and 1 called `supervisor_review`.

### 1.3 The one number that is weak

Per-completion **wall clock** is inferred and is the weakest figure in the report. No inference
latency is recorded anywhere, so a completion is charged the interval from the previous completion's
cost row to its own. That charges it for the tool time that preceded it, and it **overstates any
role that runs concurrently** — the out-of-band supervisor above all, whose batch review
(`auto-mode.ts:1903` → `supervisor-queue.ts:75`) is off the tool's critical path by design. Read
`byRole[].wallShare` as "share of the run's stretches that ended in this role", never as "share of
the wall clock this role caused". The exact wall-clock numbers are `reviewerBlockingShareOfRun`,
`retryWaitSecondsPerRun` and `shareOfRunAfterLastEdit`. Gap **I3** closes this.

---

## 2. The per-role overhead report

### 2.1 Auto runs — 93 runs, 2,194 completions, $28.38 at list

| Role                | Completions | Share of completions | Cost share | Wall share (weak) | Runs touched |
| ------------------- | ----------: | -------------------: | ---------: | ----------------: | -----------: |
| `primary`           |       1,568 |                71.5% |  **72.3%** |             46.9% |           91 |
| `planning`          |         358 |                16.3% |  **13.0%** |             11.7% |           64 |
| `supervisor_review` |         122 |                 5.6% |   **8.0%** |             36.7% |           15 |
| `compaction`        |          54 |                 2.5% |   **3.8%** |              1.0% |           19 |
| `harness_followups` |          57 |                 2.6% |   **2.2%** |              1.1% |           22 |
| `workers`           |          23 |                 1.0% |   **0.7%** |              1.8% |           15 |
| `retries`           |          12 |                 0.5% |     0.004% |              0.8% |            5 |

**27.7% of an Auto run's cost is not the agent doing the work.** On non-Auto runs (128 runs, 737
completions, $4.06) the same figure is 11.2%, and `supervisor_review` and `compaction` are
effectively absent.

Distributions per Auto run — the number that matters, because the totals are dominated by a handful
of nine-hour sessions:

| Per-run measure                        |       Median |              p90 |             Max |
| -------------------------------------- | -----------: | ---------------: | --------------: |
| Completions                            |       **16** |             73.2 |              82 |
| **Governance share of completions**    |    **28.1%** |            60.8% |            100% |
| Wall seconds                           |        335.9 |            3,089 |          34,797 |
| Cache hit ratio                        |        0.798 |            0.948 |           0.975 |
| Reviewer **blocking** share of the run |           0% |             7.2% |           47.1% |
| Share of the run after the last edit   | 13.1% (n=46) |            57.5% |           85.6% |
| Completions after the plan settled     |            0 | 0.047 of the run | 0.82 of the run |
| Harness follow-ups fired               |            0 |                3 |              10 |
| Compactions                            |            0 |                1 |              10 |

### 2.2 The controlled pilots — where the shares are much larger

The corpus is 683 sessions of mixed work on mixed routes. The pilots are the same task, the same
build and the same model on both arms, and they are 100% tagged. On the frontier route
(`codex/gpt-5.6-sol`) the overhead is roughly double the corpus figure:

| Pilot                                             | Completions |    List cost | `primary` | `planning` | `supervisor_review` |      s after last edit |
| ------------------------------------------------- | ----------: | -----------: | --------: | ---------: | ------------------: | ---------------------: |
| `comparison-j` csv-state-machine                  |          11 |     $0.13852 |     74.8% |  **21.3%** |            **4.0%** | 109.4 of 224.8 (48.7%) |
| `comparison-h` csv-state-machine                  |          16 |     $0.15845 |     63.9% |  **28.2%** |            **7.8%** |          54.7 of 232.0 |
| `comparison-g` responsive-project-board           |          25 |     $0.64089 |     65.6% |  **24.3%** |            **3.9%** |          17.6 of 591.5 |
| `comparison-i` csv-state-machine                  |           3 |     $0.03072 |     56.4% |  **43.7%** |                   — |                      0 |
| Free route (`ollama-turbo/gpt-oss:120b`), 10 runs |   1–17 each | $0.001–0.009 |   89–100% |     0–9.1% |              0–5.6% |                 0–17.1 |

**Pilot J's own trace note arrives at the same place by a different route.** It says completions 7
to 11 went to evidence bookkeeping and that removing the three refused-citation completions would
take the run from $0.1385 to about $0.11 — a 21% cut. This script, which never read that note,
attributes 21.3% of the run's cost to `planning`. Two independent methods, one number.

The free route is almost pure `primary` — not because it is efficient, but because the supervisor is
rarely engaged there and the runs are short enough that nothing compacts. **Free-route efficiency
numbers do not transfer to the frontier route**, and the handoff's rule against pooling the two
series holds here too.

### 2.3 Where the prompt bytes go

394 completions carry a composition record.

| Part         |      Bytes | Share |
| ------------ | ---------: | ----: |
| conversation | 25,487,926 | 54.6% |
| doctrine     | 12,017,559 | 25.7% |
| tool schemas |  8,938,761 | 19.1% |
| plan ledger  |    254,876 |  0.6% |
| task state   |      6,022 |  0.0% |

Byte-weighted, fixed overhead (doctrine + schemas) is **44.9%**. Computed **per completion** it is a
median of **56.7%**, p90 **90.3%** — and on the free-route pilots the per-completion median runs
69% to 98%. That reconciles Phase 12's "96% of a prompt is doctrine + schemas": that figure
describes the opening request of a short run, where it is right; the byte-weighted corpus figure is
diluted by long conversations. Both are true, and `run-economics.ts:44-55` already says why an
average over the two describes no request that was ever sent.

**Measured, not assumed: 4.183 bytes of assembled prompt per provider-counted prompt token** across
those 394 completions. That constant is what makes offline prompt accounting possible (§5.1). It is
a corpus-wide ratio; individual pilots range 4.1–18.9, and the two outliers (10.3 and 18.9) are the
runs carrying screenshots, where base64 bytes are not tokens.

The tool surface already defers: `tool_surface` rows record 20 advertised / 14 deferred, 5,243
tokens against 10,757 eager — 51% saved (`engine.ts:2670`, `:2684`).

### 2.4 Cache, per role

Whole corpus — all 221 runs, Auto and not, so these counts are larger than §2.1's.

| Role                | Completions | Fresh input |  Cache read | **Hit ratio** | Fresh tokens / completion |
| ------------------- | ----------: | ----------: | ----------: | ------------: | ------------------------: |
| `supervisor_review` |         122 |   1,004,623 |   6,381,127 |     **0.864** |                     8,235 |
| `retries`           |          19 |     117,532 |     603,234 |         0.837 |                     6,186 |
| `harness_followups` |          74 |     967,079 |   4,022,839 |         0.806 |                    13,069 |
| `primary`           |       2,162 |  70,794,616 | 116,990,279 |     **0.623** |                    32,745 |
| `planning`          |         445 |  16,170,213 |  16,204,836 |     **0.501** |                **36,338** |
| `compaction`        |          59 |   3,668,541 |   3,592,666 |         0.495 |                **62,179** |
| `workers`           |          50 |   1,544,742 |     850,324 |         0.355 |                    30,895 |

Two results here are load-bearing:

- **A planning completion carries more fresh input than a primary one** (36,338 vs 32,745) and
  caches worse (0.50 vs 0.62). Plan bookkeeping is not a cheap completion. On a free tier, which
  meters requests and fresh tokens rather than dollars, it is the most expensive thing the harness
  does per unit of work produced.
- **A compaction completion is the single most expensive call in the system** — 62,179 fresh tokens
  each, 59 of them. `cacheCreationTokens` is **0 on every row in the corpus**, across every role: no
  provider in use here reports cache writes, so "cache write per request" is unmeasurable today
  (gap **I5**).

### 2.5 Eras, and why they cannot yet be compared

| Era                   | Runs | Completions | Boundary                                                                                     |
| --------------------- | ---: | ----------: | -------------------------------------------------------------------------------------------- |
| `pre-step-count-fix`  |  216 |       2,889 | `< 2026-09-10T02:36:44Z` (before `897b192`)                                                  |
| `post-step-count-fix` |    2 |           2 | `897b192`: gate/nudge origins, settled-plan stand-down, recurrence detector, codex tail fold |
| `phase-2`             |    3 |          40 | `54459b0`, or the session carries a `run_trace lifecycle` row                                |

**The two post-fix eras have 42 completions between them. No before/after comparison can be made
from this corpus**, and none is made here. The fixes landed on 2026-09-10 and the founder's last
recorded session is 2026-09-10T18:32Z; almost everything in the database predates them. The
controlled pilots are the only post-fix evidence, and they are single runs. This is the strongest
argument for the zero-spend method in §5: the corpus cannot answer whether a change helped, and a
paid series to find out is not available.

### 2.6 Pricing, honestly

| Billing        |    Rows |      Paid | At list rates |
| -------------- | ------: | --------: | ------------: |
| `subscription` |   1,025 |     $0.00 |    $31.245350 |
| `free`         |   1,252 |     $0.00 |     $0.784645 |
| `metered`      |      23 | $0.406776 |     $0.406776 |
| **unknown**    | **631** | $0.067499 |         $0.00 |

**631 cost rows carry no `priced` field at all.** They predate P12.1; their dollar figure is
unknown, not zero. They are counted in completions and tokens, so every dollar total in this
document is a lower bound by exactly that many rows. 1,341 of the priced rows use an inferred rate
(`estimated: true`). Actual money spent across the whole corpus is **$0.474275**.

---

## 3. The ranking

### 3.1 By cost share (Auto runs)

| #   | Overhead                           |            Auto cost share | Completions | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------- | -------------------------: | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Plan-bookkeeping completions**   | **13.0%** (pilots: 21–44%) |         358 | A completion whose only tool calls are `todo_write` / `record_evidence` / `read_back`. The evidence ledger requires a citation per criterion and the runtime refuses a citation it cannot substantiate: `rungForCommand` at `brief.ts:470`, refusal text at `:476`. `RECORD_EVIDENCE_SCHEMA` (`brief.ts:572`) already tells the model to batch the citation into the same response as the check — `agent-loop.ts:3068` implements the same-response read — but nothing enforces it, and a refusal costs a whole completion. Pilot J spent three completions rewording one refused citation. |
| 2   | **Supervisor / classifier review** |                   **8.0%** |         122 | Two calls. In path: high-risk actions pay exactly one reasoned review plus one retry on the fallback identity (`auto-mode.ts:1561-1600`; the code's own comment records "a measured 2-4 seconds … stacked on the ~9s reasoned pass"). Out of band: `superviseInBackground` (`auto-mode.ts:1868`) enqueues onto `SupervisorQueue` (`supervisor-queue.ts:44`), which batches on a 10 ms burst window (`:77`) up to 8 distinct keys or 24,000 chars (`:86-90`). 79 `supervisor_screen` decisions in the corpus, each a completion.                                                             |
| 3   | **Compaction**                     |                   **3.8%** |          54 | `ContextEngine`'s summarizer walk (`context-engine.ts:974`, `role: "summarizer"`), triggered when the provider's reported prompt crosses the window. 73 auto-compactions: before median 66,391 tokens, after median 44,237 — a 33% reduction bought with a 62,179-fresh-token call. `auto_compaction` rows are also ~58 KB each (V3-F9), which is the shape that grew the 184 MB checkpoint table.                                                                                                                                                                                          |
| 4   | **Harness-generated follow-ups**   |                   **2.2%** |          57 | Nine tagged re-prompts in `agent-loop.ts`: gates at `:2349` (delegation-evidence), `:2426` (execution-evidence), `:2482` (fix-verified), `:2533` (product-sight), `:2604` (open-steps); nudges at `:1998` (misencoded-call), `:2049` (empty-completion), `:3975` (result-loop), `:4203` (stale). **Ten more are untagged** — see I2. Corpus firings, by label: product-sight 9, turn-budget wrap-up 8, provider rate-limit wait 8, open-steps 6, verification-retry 6, barren-breaker 5, tool-loop 4, auto-halt 3, result-loop 3, execution-evidence 2, replan 2, fix-verified 1.           |
| 5   | **Workers**                        |                   **0.7%** |          23 | `task` / `worker` dispatch (`subagent.ts:318`, `worker.ts:672`, budgets at `subagent-budget.ts:43`). Small in this corpus because delegation was barely used — and because the durable store was unwired until `0fc1c99` (V3-F1), so **zero** `delegation_checkpoint` or `delegation_lease` rows exist to measure setup and integration against (gap **I4**).                                                                                                                                                                                                                               |

Below the cut: `retries` at 0.004% of cost. That number is not the truth about retries — see §3.2 #5.

### 3.2 By wall clock

The exact measures first, because §1.3 makes the interval-based shares unreliable for anything
concurrent.

| #   | Overhead                                | Exact measure                                                                                                                                                                                                                                   | Mechanism                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Time after the last useful edit**     | Median **13.1%** of an Auto run, p90 **57.5%**, max 85.6% (n=46 of 93). Pilot J: **109.4 s of 224.8 s — 48.7%**                                                                                                                                 | Everything the finish path does after the work is done: the five evidence gates (`agent-loop.ts:2349`–`:2619`), verification (`:2251`), the wrap-up reserve (`:1454`), the second wind (`:1412`). A settled plan already stands the gates down (`:2398-2404`) — but only when `settledPlanAtWriteCount === writeCount`.            |
| 2   | **Governance completions' own latency** | **28.1%** of a median Auto run's completions (p90 60.8%)                                                                                                                                                                                        | Each governance completion is a full round trip on the same provider as the work, competing for the same rate limit. The corpus's free-tier pressure figure is fresh tokens per completion, and `planning` and `compaction` are the two worst (§2.4).                                                                              |
| 3   | **In-path reasoned review**             | 131 `classifier_reasoned` decisions: median **7.64 s**, p90 14.0 s, max 18.1 s. Plus 26 `containment` decisions: median **10.5 s**, max **32.6 s**                                                                                              | `auto-mode.ts:1561-1600`. The fast one-token stage was already removed for exactly this reason; what remains is one reasoned call plus a retry, both charged to `classifierMs` (`:1580-1590`). Only **137 of 1,517** recorded decisions are model-backed — 1,380 are mechanical at a median 1 ms, which is the cheap tier working. |
| 4   | **A reviewer that never answers**       | 12 `classifier_unavailable` decisions, median 155 ms but **max 24.0 s**                                                                                                                                                                         | `auto-mode.ts:1519`, `:1672`, `:1691`. A 24-second wait ending in "human confirmation is required" is the worst outcome the review path can produce: it costs the clock and delivers no decision.                                                                                                                                  |
| 5   | **Provider retries and rate limits**    | `run_trace` records **15** retries and 15 s of back-off. The black box records **1,417** `provider.rate_limit`, 378 `provider.fallback_triggered`, 186 `provider.terminal`, 59 `provider.stream_error`, 46 `provider.malformed_tool_json_fatal` | The two ledgers are not joined. `~/.rune/blackbox.db` knows what went wrong; `rune.db` knows what it cost; nothing relates an incident to the completion that paid for it (gap **I6**). The 0.004% cost share for `retries` is an artefact of that split, not a finding.                                                           |

### 3.3 One open question the code does not answer

Pilot J's trace attributes its two full cache misses (requests 4 and 6, 11,527 and 15,310 fresh
tokens) to the just-in-time doctrine adding a section to the system prompt. **At `3c3ee67` that
mechanism does not exist.** The system prompt changes exactly once per run — the opening→working
phase switch at `agent-loop.ts:1523-1526`, which is the request-2 _partial_ miss the same note
records — the context engine returns it byte-identical (`context-engine.ts:302`, `:392`), the JIT
doctrine rides tool results rather than the system prompt (`agent-loop.ts:3749-3782`), and
`record_evidence` is registered unconditionally (`engine.ts:1698`).

Read from the pilot's own database, both misses follow a completion that changed the **task-state
tail**: request 4 follows `read_back` (which creates the brief), request 6 follows the first passing
`bash` check (which adds a rung). On codex the tail is folded into the last tool output, and it is
rebuilt fresh every request and never stored in `this.messages` (`agent-loop.ts:1551-1556`) — so a
message that went out as `tool_output + ledger` on request N is replayed **bare** on request N+1.
That is a mid-prefix content change, and `scripts/verify-codex-tail-cache.ts`'s control loop never
changed the ledger between turns, so it could not have caught it.

That is a hypothesis with a prediction (the cache should lag exactly one tool result behind, which
most of Pilot J's requests do show) and it does **not** explain two cache reads of exactly zero.
Cache behaviour is the one thing only a live run can settle (§5.3). Until then, no claim.

---

## 4. Instrumentation gaps (Deliverable 2)

Each gap names the smallest change, the line where it would be recorded, and the existing row it
extends. **No gap needs a new coordinator or a new database.**

### I1 — A role on every usage row

**Today.** 437 of 2,931 rows (14.9%). `InferenceRequest.role` is optional
(`packages/llm-gateway/src/types.ts:360`) and `recordCost` copies it only when present
(`packages/llm-gateway/src/gateway.ts:889-892`). Nine callers set it; anything else is silently
`primary`.

**Smallest change.** Make `role` required on `InferenceRequest` (`types.ts:360`) — a type change
that makes every unattributed call a compile error rather than a silent `primary`. `recordCost`
(`gateway.ts:882`) then always writes it. Extends the existing `cost` event; no new row.

**Cost.** 4 bytes of JSON per cost row. The compile errors are the point.

### I2 — A reason on every harness-generated message

**Today.** `messageOrigins` exists (`agent-loop.ts:946`), `appendMessage` takes an origin
(`agent-loop.ts:950`), `originOf` reads it (`:957`), and `engine.ts:5344-5351` persists a tagged
user message as `user_msg.harness`. Of the twenty-one `role: "user"` messages `appendMessage` creates, two are the user's own (the
initial message at `:1118`, a mid-turn interjection at `:1096`) and nineteen are synthetic. Nine
carry an origin. **The other ten pass none, and are therefore never persisted at all:**

| `agent-loop.ts`   | What it is                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `:1033`           | `drainHarnessNotes` — struggle nudges, turn-budget note, known pitfalls, connector notes, server instructions, teammate mail |
| `:1412`           | the second wind's note                                                                                                       |
| `:1454`           | the wrap-up reserve protocol                                                                                                 |
| `:2168`           | the oversized-output re-prompt                                                                                               |
| `:2251`           | the verification-failed re-prompt                                                                                            |
| `:2288`           | the re-plan after repeated verification failures                                                                             |
| `:4011` / `:4031` | screenshot delivery (and the refusal when the provider carries no images)                                                    |
| `:4065`           | the auto-halt final-report demand                                                                                            |
| `:4126`           | the barren-breaker nudge                                                                                                     |

The corpus shows the consequence exactly: **1 of 1,210 `user_msg` rows carries an origin.**

**Smallest change.** Pass an origin string at each of those ten `appendMessage` calls, using the
existing `"<kind>:<name>"` grammar (`gate:`, `nudge:`, plus `wind:`, `wrapup:`, `halt:`, `image:`).
Nothing else moves. Extends `user_msg.harness`, which already exists.

### I3 — Request start and end timestamps

**Today.** A `cost` event carries `timestamp` (when the response landed) and nothing else. Wall
clock per completion has to be inferred from the gap between cost rows (§1.3), which cannot separate
a slow provider from a slow tool and cannot see a concurrent reviewer at all.

**Smallest change.** Record `startedAt` and `latencyMs` on the `CostEntry`
(`packages/llm-gateway/src/types.ts:880-903`), stamped in `Gateway.infer` around the provider call
(`gateway.ts:279` non-streaming, `:391` streaming) and copied in `recordCost` (`:889`). Extends the
existing `cost` event. This one change makes every wall-clock share in §2 exact, including the
concurrent ones.

### I4 — Worker start and integrate timestamps

**Today.** Zero `delegation_checkpoint` and zero `delegation_lease` rows exist in this corpus
(V3-F1: the store was unwired until `0fc1c99`). Worker startup and integration time could not be
measured at all; the `workers` row in §2.1 is dispatch-to-result and includes the child's own work.

**Smallest change.** The lifecycle event already exists — `run_trace type='lifecycle'` with a
`moment` field (`54459b0`; corpus values `start`, `budget`, `steering`, `terminal`). Emit two more
moments, `worker_start` and `worker_integrated`, from the dispatch and result paths
(`subagent.ts:318` and `worker.ts:672` are where the child's role is already set). Extends
`run_trace lifecycle`; no new event type.

### I5 — Cache read and write per request, per role

**Today.** `cacheReadTokens` is recorded and usable. **`cacheCreationTokens` is 0 on every one of
the 2,931 rows** — no provider in use reports cache writes — so "what did warming the cache cost"
has no answer, and §3.3's hypothesis cannot be tested from stored data.

**Smallest change.** Two parts, both on the existing `cost` row. (a) Record the
`cacheBreakpointIndex` actually sent (`agent-loop.ts:1662`) so a miss can be attributed to a
breakpoint that moved. (b) Record a `prefixHash` — a cheap hash of `system + tools + messages[0..n]`
computed where the composition is already measured (`agent-loop.ts:1651`) — so consecutive requests
can be compared offline and a mid-prefix change becomes visible without a provider. Extends
`CostEntry.composition`, which already has a home for per-request prompt facts.

### I6 — A `useful_edit` marker, and a link from an incident to the completion that paid for it

**Today.** Two smaller gaps that share one fix. "Time after the last useful edit" is inferred from
the last assistant message calling an edit tool, which counts an edit later reverted. And the black
box (`~/.rune/blackbox.db`, 3,284 incidents) and the cost ledger have no join: 1,417 rate-limit
incidents against 15 recorded retries.

**Smallest change.** (a) The predicate for "this call wrote something" already exists and is already
unified — `08b2439` made one predicate cover `apply_patch` too. Emit its verdict as a field on the
existing `run_trace` tool row at the point the loop already knows (`agent-loop.ts:3885`, where tool
results are appended), so "the last useful edit" is a recorded fact. (b) Add the current `callId`
and turn to the incident context the recorder already takes (`engine.ts:3343-3347` shows the shape),
so an incident can be joined to the completion it belongs to. Extends `Incident.context_json`, a
column that already exists.

---

## 5. Measuring a change without spending (Deliverable 3)

### 5.1 Prompt-size accounting per role per turn, offline

**There is no BPE tokenizer in this repo or in `node_modules`** (11 packages; none is a tokenizer).
What exists is `packages/orchestrator/src/tokenizer.ts:41` — `TokenCounter.countTokens`, the
heuristic `max(words × 1.3 + punctuation × 0.5, chars / 4)`, calibrated against real provider counts
at `:66`.

Three usable estimators, in order of preference:

1. **The measured byte ratio.** `composition.total / (inputTokens + cacheReadTokens)` over the 394
   completions that recorded both is **4.183 bytes per prompt token**. Composition is already
   measured in bytes at `agent-loop.ts:1651` and the provider's count is already on the same row, so
   this ratio is re-derivable per model, per route, whenever new rows arrive. It is exact
   arithmetic on recorded data, not an estimate of an estimate.
2. **`TokenCounter.countTokens`** for text that has no composition row, calibrated per model by
   replaying stored `(estimated, actual)` pairs through `noteCalibration` (`tokenizer.ts:66`) — the
   same path the live engine uses, so an offline estimate and a live one cannot drift.
3. **Raw bytes** where only a delta matters (did this change add or remove prompt?), with the 4.183
   ratio stated whenever a byte figure is converted to tokens. Note the caveat from §2.3: images
   break the ratio badly (the two screenshot-carrying pilots read 10.3 and 18.9).

**Can the prompt as sent be rebuilt from the events table?** Partly, and the answer matters:

| Part           | Stored?                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| conversation   | **Yes, in full.** `assistant_msg` keeps `content`, `contentBlocks` and `toolUses` with arguments; `tool_result` keeps `content` untruncated (max observed 71,938 chars).                                      |
| system prompt  | **No.** `sessions.system_prompt_hash` is populated on 74 of 684 sessions and is a hash. The assembled string lives in a local (`engine.ts:5120`) and in `lastTurnContext` (`:5134`), which is in-memory only. |
| tool schemas   | **No.** Only counts: `tool_surface` records advertised/deferred and a token estimate (`engine.ts:2684`).                                                                                                      |
| ephemeral tail | **No.** Rebuilt per request and never stored (`agent-loop.ts:1551-1556`).                                                                                                                                     |

So a stored session supports **shape** replay — how many messages, how many bytes of conversation,
how the composition moved — but not a byte-exact reconstruction of the prompt as sent. Closing that
needs I5's `prefixHash`, which makes prefix stability checkable without storing the prompt itself.

### 5.2 Step count and follow-up count on fixed scripts, through the mock server

`tests/helpers/mock-model-server.ts` is already the right instrument and needs no extension for most
of this. It scripts four roles (`MockRole` at `:116`: `lead`, `child`, `summarizer`, `utility` —
`utility` is explicitly the Auto reviewer at `auto-mode.ts:513`), and it records every request with
`system`, `messages`, `toolNames`, `raw`, `usage` and `at` (`RecordedRequest` at `:132`). `countOf`
(`:405`), `usageTotals` (`:424`) and `matching` (`:401`) are the assertions.

Deterministically exercisable there:

| Mechanism                                     | How                                                                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step count on a fixed task**                | A fixed `MockScript.lead`; `countOf("lead")` is the step count. Any change that removes a completion changes that integer.                                                                                                                               |
| **Plan-bookkeeping completions**              | Script a `record_evidence` citation the runtime will refuse (`brief.ts:476`) and count the completions before the model gets it right.                                                                                                                   |
| **Every gate and nudge**                      | Script the state each gate reads — a write with no execution, a fix-shaped brief with no verified criterion, visual files never viewed, open steps — and assert the re-prompt count. With I2 landed, assert on the persisted `user_msg.harness` origins. |
| **Reviewer call count and batching**          | `countOf("utility")` plus `SupervisorQueue`'s existing unit tests (`tests/unit/orchestrator/supervisor-queue.test.ts`).                                                                                                                                  |
| **Compaction**                                | `MockUsage.prompt` drives `ContextEngine`'s real compaction decision (`:45-60` documents the lever: `context-engine.ts:406-421`, `:1151-1159`).                                                                                                          |
| **Empty completions and misencoded calls**    | `{ kind: "empty" }` (`:83`) and scripted text-shaped tool arguments.                                                                                                                                                                                     |
| **Retries and back-off**                      | `{ kind: "status" }` (`:85`) and `{ kind: "hang" }` (`:96`).                                                                                                                                                                                             |
| **Prompt size per role per turn, byte-exact** | `RecordedRequest.raw` / `system` / `toolNames` are the real assembled request. No tokenizer estimate is needed on this path at all.                                                                                                                      |
| **Prefix stability** (§3.3)                   | Diff consecutive `RecordedRequest.raw` prefixes. A mid-prefix message whose content changed is a byte diff, observable with no provider.                                                                                                                 |

Not exercisable there:

- **Real cache behaviour.** The mock reports `cached` because the caller told it to (`MockUsage.cached` at `:60`); it has no cache.
- **Real reviewer latency distribution.** `latencyMs` / `delayMs` simulate a number; they cannot tell you what a rate-capped free reviewer actually does.
- **Whether the model's behaviour changes.** Every action is scripted. A change that makes the model need fewer steps cannot be shown here — only a change that makes the _harness_ spend fewer.
- **`GET /v1/models` context shrinking** — already documented as inert (`MODELS_CAVEAT` at `:193`).

That boundary is the whole point: §3.1's top four overheads are harness-chosen and fall on the
left-hand side. Only the cache question and the reviewer's real latency fall on the right.

### 5.3 What only a live run can measure, and the cheapest design

Live-only: prompt-cache behaviour across a real tool loop (§3.3), real reviewer latency under a
real rate limit, and provider-side retry and fallback behaviour.

**The cheapest design, costed from the series-C numbers.**

| Design                                                                          | Arms | Cost                                                                   |
| ------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------- |
| Series C as run (3 tasks × 2 runs × 2 arms, `ollama-turbo/gpt-oss:120b`)        |   12 | $0.0273 Rune + $0.0496 OpenCode at list, **$0.00 billed**              |
| Minimum decisive free-route design: 2 tasks × 2 runs × 2 arms, order alternated |    8 | ~**$0.05** at list, **$0.00 billed**                                   |
| Frontier confirmation: 1 task × 2 runs × 2 arms on `codex/gpt-5.6-sol`          |    4 | ~**$0.43** at list, billed to the subscription's quota, not to dollars |

The free route settles step count, follow-up count and completion rate at zero cost. It cannot
settle the cache question: the series-C note records that **neither route caches on
`ollama-turbo`**. Only the frontier arm can, and it costs quota rather than money.

Recommended shape, all of it already supported by `tests/eval/comparison/runner.ts`:

- one provider per series, never pooled;
- the same two tasks each time: **`csv-state-machine`**, the only one of series C's three that
  discriminated on outcome (Rune 1/2, OpenCode 0/2), and **`dependent-migration`**, which every arm
  completed and which shows the widest wall-clock gap (Rune 27 s / 39 s against OpenCode 248 s /
  92 s) — one task for completion rate, one for a clean cost and step comparison.
  `working-tree-integration` is the least informative of the three: all four arms passed and the
  spread was narrow;
- arm order alternated per run — already implemented at `tests/eval/comparison/runner.ts:207`
  (`(run + index) % 2`) — and fresh output directories;
- the same wall-clock limit and spend ceiling on both arms;
- a timeout preserved as a failure even when the artefacts pass;
- every run's `rune.db` kept, so `scripts/overhead-report.ts --db <path>` produces the per-role table for each arm.

The frontier arm should not be attempted until I1, I3 and I5 have landed. Without them it produces
one more $0.43 run whose cache misses cannot be attributed — which is exactly what happened to
Pilot J.

---

## 6. The build plan for Phase 3B (Deliverable 4)

Four lanes. **Lane 0 goes first and alone** — every other lane's effect is measured through it. The
three build lanes that follow own disjoint files and can run concurrently.

### Lane 0 — instrumentation (blocks everything)

| Item | Files                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| I1   | `packages/llm-gateway/src/types.ts`, `packages/llm-gateway/src/gateway.ts`, plus the call sites the compiler names          |
| I3   | `packages/llm-gateway/src/types.ts`, `packages/llm-gateway/src/gateway.ts`                                                  |
| I5   | `packages/llm-gateway/src/prompt-composition.ts`, `packages/orchestrator/src/agent-loop.ts` (the `measureComposition` call) |
| I2   | `packages/orchestrator/src/agent-loop.ts` (nine `appendMessage` calls)                                                      |
| I4   | `packages/orchestrator/src/subagent.ts`, `packages/orchestrator/src/worker.ts`                                              |
| I6   | `packages/orchestrator/src/agent-loop.ts`, `packages/orchestrator/src/engine.ts` (incident context)                         |

Lane 0 touches `agent-loop.ts`, which Lanes A and B also want. **Land Lane 0 first, on its own.**
Measured effect: none by design. Verified offline by re-running `scripts/overhead-report.ts` against
a mock-server run and asserting `costRowsWithRoleTag == costRows` and
`userMsgWithOriginMarker == the scripted re-prompt count`.

**User-visible:** none. **Cost:** a few dozen bytes per cost row.

---

### Lane A — the finish path

**Owns:** `packages/orchestrator/src/agent-loop.ts` (the gate block, `:2300-2650`; the finish path,
`:4000-4230`), `packages/orchestrator/src/step-evidence.ts`.

| Change                                                                                                                                                                                                                                                                                                                                    | Mechanism                                                         | Expected effect                                                  | Measured offline by                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **A1. A refusal that says what to do next.** `rungForCommand` (`brief.ts:470`) answers "nothing on record" to a command that _did_ run but was not recognised as a check. Pilot J burned three completions rewording one. Reply "ran, exit 0, not a recognised check — write it as a test file or cite a check command" instead.          | `brief.ts:476` (owned by Lane C to avoid a collision — see below) | −1 to −3 completions on any run that cites an unrecognised check | Mock script: cite an inline script, count completions to the corrected citation           |
| **A2. Batch the citation with the check by construction.** The schema already asks for it (`brief.ts:572-586`) and the loop already reads a check run in the same response (`agent-loop.ts:3068`). Make a lone `record_evidence` that follows a check in the _previous_ completion carry the citation forward rather than costing a turn. | `agent-loop.ts:3050-3090`                                         | −1 completion per criterion on multi-criterion tasks             | `countOf("lead")` on a fixed 3-criterion script                                           |
| **A3. Stand the gates down more often.** `planSettled` requires `settledPlanAtWriteCount === writeCount` (`agent-loop.ts:2398-2404`). A formatting write after a green check re-arms all five gates. Compare against the _check_ log rather than the raw write count.                                                                     | `agent-loop.ts:2392-2410`                                         | Reduces the 13.1%-median tail after the last edit                | Mock script: green check, then a cosmetic write, then finish; assert zero gate re-prompts |

**Risk to completion honesty.** A1 is the highest-risk item in the whole plan: it changes what the
runtime says about evidence. It must not change what the runtime _awards_ — `rungForCommand`'s
verdict logic (`brief.ts:470-565`) stays byte-identical; only the refusal prose changes. A3 relaxes
a gate and must keep `tests/unit/orchestrator/agent-loop-finish-gates.test.ts` green unchanged; if
any of its eight cases needs editing, the change is wrong.

**User-visible:** A1 changes text the user sees in the transcript. **Cost:** downward.

---

### Lane B — the reviewer

**Owns:** `packages/orchestrator/src/auto-mode.ts`, `packages/orchestrator/src/auto-containment.ts`,
`packages/orchestrator/src/supervisor-queue.ts`, `packages/orchestrator/src/reviewer-fallback.ts`,
`packages/orchestrator/src/auto-metrics.ts`.

| Change                                                                                                                                                                                                                                                                                                                                                                                                                  | Mechanism                                         | Expected effect                                                         | Measured offline by                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **B1. A deterministic answer beats a reviewer call.** 1,380 of 1,517 decisions are already mechanical at ~1 ms. Widen `isOrdinaryDevCommand` (`packages/orchestrator/src/shell-safety.ts`, called at `auto-mode.ts:1881`) and the `supervised_tier` clearance (`auto-mode.ts:1471-1510`) using the corpus's own decision-source histogram, so more of the 131 `classifier_reasoned` calls (median 7.64 s) never happen. | `auto-mode.ts:1471-1600`                          | −1 to −8 reviewer calls per Auto run; −7.6 s of blocked wall clock each | `countOf("utility")` on a fixed script; `tests/unit/orchestrator/auto-mode.test.ts` must stay green |
| **B2. A reviewer that cannot answer should say so fast.** 12 `classifier_unavailable` decisions, max 24.0 s, ending in "human confirmation required". Bound the reasoned call plus its retry with a single deadline rather than two independent ones (`auto-mode.ts:1573-1596`).                                                                                                                                        | `auto-mode.ts:1573-1600`                          | Caps the worst case at one deadline instead of two                      | `{ kind: "hang" }` on the `utility` role; assert the decision lands inside the bound                |
| **B3. Queue-wait visibility.** `SupervisorQueue` (`supervisor-queue.ts:44`) records no enter/leave time. Stamp both onto the `SupervisedItem` and report them in the existing `supervisor_skipped` decision (`auto-mode.ts:1479-1497`).                                                                                                                                                                                 | `supervisor-queue.ts:26-100`, `auto-mode.ts:1479` | None on cost; closes the last unmeasured reviewer number                | `tests/unit/orchestrator/supervisor-queue.test.ts:86` extended                                      |

**Risk checks that must stay intact.** The containment broker's verdicts
(`auto-containment.ts`), the halt latch (`auto-mode.ts:1078`, set at `:2040`, consumed at `:2063`), and the rule that a full queue
never denies ordinary work (`supervisor-queue.ts:34-43`, pinned by
`tests/unit/orchestrator/supervisor-queue.test.ts:105`). B1 widens what is cleared mechanically and
is the item most able to weaken safety: every widening needs a case in
`tests/unit/orchestrator/auto-mode-shell-tier.test.ts` and must leave
`bun run eval:auto-safety --offline` at or above its recorded P 90.0 / R 89.1 / F1 89.6.

**User-visible:** fewer approval pauses. **Cost:** downward. **B1 changes safety behaviour** and
needs the director's decision (§7).

---

### Lane C — the prompt and the ledger

**Owns:** `packages/orchestrator/src/prompts.ts`,
`packages/orchestrator/src/context-engine.ts`, `packages/orchestrator/src/brief.ts`,
`packages/llm-gateway/src/prompt-composition.ts`.

| Change                                                                                                                                                                                                                                                                                                                                | Mechanism                    | Expected effect                                             | Measured offline by                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **C1. A cheaper compaction call.** 62,179 fresh tokens per summarizer call, 59 calls, and the reduction is only 66,391 → 44,237 tokens. Summarise incrementally from the previous summary (`context-engine.ts:958-1000` already accepts `priorState`) rather than re-reading the whole window.                                        | `context-engine.ts:900-1010` | −30% to −60% of the summarizer's fresh input                | `MockUsage.prompt` drives real compaction; assert the `summarizer` request's byte count |
| **C2. Trim the working-phase doctrine.** Median request is 56.7% doctrine + tool schemas (p90 90.3%). The opening→working switch already drops ~6 KB (`agent-loop.ts:1515-1526`). Measure each remaining section's bytes against the corpus and move any that no working-phase turn reads into the JIT set (`prompts.ts:27`, `:355`). | `prompts.ts`                 | −X% of every request's fixed prefix, X measured not guessed | `RecordedRequest.system` byte count per turn on a fixed script                          |
| **C3. A1's refusal text.** Owned here because `brief.ts` is this lane's file; Lane A specifies it, Lane C writes it.                                                                                                                                                                                                                  | `brief.ts:470-480`           | see A1                                                      | see A1                                                                                  |

**Risk.** C2 must not remove a section the model needs on turn 2+; `tests/unit/orchestrator/agent-loop-jit-doctrine.test.ts` covers the existing JIT sections and needs one case per section moved. C1 must not weaken a summary such that a resumed run loses the spec — `tests/unit/orchestrator/context-compaction-budget.test.ts` and the `lifecycle-durability` integration suite are the guard.

**User-visible:** none. **Cost:** downward.

---

### 6.1 File ownership — no overlaps

| File                                                                                                                 | Lane 0 |  A  |  B  |           C            |
| -------------------------------------------------------------------------------------------------------------------- | :----: | :-: | :-: | :--------------------: |
| `llm-gateway/types.ts`                                                                                               |   ●    |     |     |                        |
| `llm-gateway/gateway.ts`                                                                                             |   ●    |     |     |                        |
| `llm-gateway/prompt-composition.ts`                                                                                  |   ●    |     |     | ● (after Lane 0 lands) |
| `orchestrator/agent-loop.ts`                                                                                         |   ●    |  ●  |     |                        |
| `orchestrator/engine.ts`                                                                                             |   ●    |     |     |                        |
| `orchestrator/subagent.ts`, `worker.ts`                                                                              |   ●    |     |     |                        |
| `orchestrator/step-evidence.ts`                                                                                      |        |  ●  |     |                        |
| `orchestrator/auto-mode.ts`, `auto-containment.ts`, `supervisor-queue.ts`, `reviewer-fallback.ts`, `auto-metrics.ts` |        |     |  ●  |                        |
| `orchestrator/prompts.ts`, `context-engine.ts`, `brief.ts`                                                           |        |     |     |           ●            |

`agent-loop.ts` is shared by Lane 0 and Lane A, which is why Lane 0 is sequenced first and alone.
After it lands, A, B and C are disjoint and concurrent.

### 6.2 Acceptance checks, and what covers them today

The handoff names three clauses covering six conditions (`docs/CLAUDE_CODE_HANDOFF.md:203`).

| Acceptance                                              | Covered today by                                                                                                                                                                                                                                                   | Lane at risk |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **No unbounded queue**                                  | `tests/unit/orchestrator/supervisor-queue.test.ts:71` (overflow refuses a new shape), `:155` (a repeat rides along at capacity), `:105` (a slow reviewer never denies ordinary work)                                                                               | B            |
| **No unbounded retry / empty response**                 | `tests/unit/orchestrator/agent-loop-empty-completion.test.ts:348` (retries twice, then fails loudly), `:415` (accompanying text cannot reset the ceiling), `:465` (recovery stays bounded and names its outcome)                                                   | A            |
| **No unbounded finalization loop**                      | `tests/unit/orchestrator/agent-loop-finish-gates.test.ts:113` and `:180` (each gate refuses **once**; 9 cases over 3 gates), `agent-loop-loop-detector.test.ts:118` (nudged, then bailed), `agent-loop-second-wind.test.ts:145` (winds = 0 keeps the hard ceiling) | A            |
| **No budget overspend through concurrent reservations** | `tests/unit/gateway/budget-reservations.test.ts:6` (concurrent inference reserves before any provider call), `:30` (cancellation and failure release), `:48` (unknown prices cannot masquerade as free), `:58` (reservations follow observed output)               | 0            |
| **Visible progress while waiting**                      | `tests/unit/orchestrator/agent-loop-progress.test.ts:16` (progress notes yield in order, before the tool's end event)                                                                                                                                              | B            |

Two of these are thin for what 3B changes. **B2 needs a new case**: a reviewer that hangs past its
deadline must still produce a decision and must still show progress — neither the queue tests nor
the progress test covers a hung `utility` call today. **A3 needs a red test first**: a cosmetic
write after a green check, asserted to produce zero gate re-prompts, must fail at `3c3ee67` before
the change lands.

Also carried forward from Phase 2 and unchanged by this plan: the shared ceiling across helpers,
fallback models, workers, cancellation and resume (`engine.ts:6295-6310` → `cost-tracker.reserveRequest`,
`subagent-budget.ts:43`, `turn-budget.ts:105`).

---

## 7. What the director must decide before 3B starts

1. **B1 widens what Auto clears mechanically.** It is the largest single wall-clock win available
   (131 reviewer calls at a median 7.64 s) and it is a safety-posture change. The measurable
   guardrail is `bun run eval:auto-safety --offline` staying at or above P 90.0 / R 89.1 / F1 89.6.
   Approve the change with that floor, or hold B1 and take the smaller B2/B3 wins.
2. **A1 changes evidence prose.** The refusal text is what stops a model rewording a citation for
   three completions, and it is also the sentence that keeps "verified" honest. The proposal keeps
   every verdict identical and changes only what the refusal says. Confirm that is the line.
3. **The frontier live arm costs quota, not dollars, and there is ~5% of the weekly Codex allowance
   left.** §5.3 costs it at ~$0.43 list for four arms. Either authorise one frontier pair _after_
   Lane 0 lands — or accept that the cache question (§3.3) stays open and that Phase 3 is measured
   on the free route alone.
4. **Whether `report`-shaped plans keep waiving the settled-plan gate.** Left deliberately unfixed
   at `33cea48` and pinned by a characterisation test; A3 touches the adjacent code and would be the
   cheapest moment to settle it.

---

## Appendix — reproducing every number

```
bun run scripts/overhead-report.ts </dev/null          # corpus + all 15 pilots
bun run scripts/overhead-report.ts --db <run>/profile/rune.db --no-pilots --out /tmp/one.json
npx prettier --write docs/evidence/overhead-report-20260911.json   # see below
```

`JSON.stringify(…, 2)` and Prettier disagree on one point — Prettier collapses a short array onto
one line — so regenerating the checked-in report needs that `prettier --write` after it, or
`bun run format:check` goes red on a file whose content did not change.

The script opens every database `readonly: true`, writes only its `--out` file, makes no network
request and calls no model. Output for this document:
[`docs/evidence/overhead-report-20260911.json`](../evidence/overhead-report-20260911.json), whose
`method` block carries every heuristic verbatim and whose `labelledAgreement` block carries the
confusion matrix behind the 98.2% / 83.8% figures.
