# Context

Every turn re-sends the whole conversation. That single fact decides an agent's
cost curve, its latency, and — once a run is long enough — whether it still
knows what it is doing. This page describes what Gear keeps, what it throws
away, and how the throwing-away is measured.

## The three carriers

A long run's memory lives in three places, and they fail differently.

| carrier              | holds                                                   | survives compaction because                              |
| -------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| the **task spine**   | goal, plan with receipts, files written, clarifications | it is re-injected fresh every request, never stored      |
| the **working set**  | the verbatim recent turns                               | compaction only cuts the head                            |
| the **merged state** | everything before the cut, as one structured block      | each compaction updates it rather than re-summarizing it |

The spine is the source of truth for the plan (see
[`plan-ledger.md`](plan-ledger.md)); the summary refers to the plan rather than
restating it, and the summarizer is told so in its own system prompt. The
harness also keeps a fourth, invisible carrier: the freshness ledger of file
hashes, so an edit after a compaction still applies without a re-read.

## Compaction, in tiers

Compaction escalates. It never jumps straight to "summarize almost everything".

1. **Evict old tool-result bodies.** The cheapest useful thing: tool results are
   the bulk of an agentic transcript and the least re-readable part of it. The
   block stays in place, so no `tool_use`/`tool_result` pair is ever orphaned.
   Only results large enough to be worth reclaiming are touched, and what is
   left behind is a head-and-tail **excerpt**, not an anonymous hole — a result
   the run can no longer identify is a result it cannot decide to re-run.
2. **Keep a token-budgeted verbatim tail.** 30% of the model's real window, in
   tokens. A message count is the wrong unit: six messages of a tool-heavy run
   is a rounding error against a 200k window, and six _huge_ messages are larger
   than the whole budget.
3. **Summarize the head into the merged state.** One round trip, on the light
   tier where one is configured, bounded by a wall clock and the turn's abort.

The trigger is 70% of the model's real context window, measured from
provider-reported usage where the provider reports it. Compaction aims to land
at 50%, comfortably under the trigger, so the next turn does not immediately
re-compact.

## The merged state, not a summary of a summary

Each compaction hands the summarizer the **prior state** as accumulated state to
update, and the new segment as transcript. It never feeds its own previous
summary back as text to compress: that is recursively lossy — each pass
paraphrases the paraphrase, and by the third compaction the session's original
goals are prose about prose. The state uses fixed section labels
(goals, key facts, actions, decisions, current state and next step) precisely so
successive compactions can merge into a structure instead of re-writing one.

This is the fix for Gap 6 of the competitive assessment
(`docs/history/Berne-Competitive-Assessment.md`). `tests/eval/tasks-compaction.ts`
measures it directly: no compaction may contain a prior state in its transcript
half, exactly one summary marker may exist in the working set, and the merged
state may not run away across compactions.

## What is measured

`bun run eval -- --tasks context` runs the compaction-quality family. It scripts
a long session against a mock provider with `mock-model` registered at a 60,000
token window, drives a **faithful summarizer** (one that carries forward every
fact it is handed and invents nothing, so anything lost was lost by the harness,
not by a model), and asserts against the request the provider actually received:

- decisions the user stated and facts tool results taught, all before the first
  compaction, are still there after the last one;
- the goal, every plan step open and closed, and every file written are still
  there;
- an edit issued after compaction applies with no hash and no re-read;
- the results the next step needs came through verbatim;
- no compaction re-summarized its own summary, and each request fit the
  summarizer's own window;
- evicted results stay identifiable, and evictions do not destroy results too
  small to be worth reclaiming;
- every compaction frees a real share of the working set, and none collapses
  the tail to a stub.

Numbers, before and after, live in [`benchmarks.md`](benchmarks.md) under
"P10.8".

## Utilization, after the fact

`gear audit` prints a **Context** section for a session: per-turn occupancy
against the model's window, the share served from cache, and every compaction
with its before/after sizes and what it dropped. It is read from the persisted
usage rows, not from a live counter — the process holding a counter is often the
one that died. A turn whose provider reported no usage renders as `no data`,
never as zero.

## Provider-side context editing

Some providers offer to do part of this server-side. Where the API the gateway
targets exposes it, it belongs behind the cache-policy table in
[`providers.md`](providers.md) as an opt-in, alongside the measured evidence for
every other provider claim. What is and is not available today is recorded
there.
