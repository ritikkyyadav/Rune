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
   This tier runs **before any summarizer**, so for everything it touches there
   is no other record — which is why two rules govern it. Only results over
   2,000 characters are touched (destroying a 430-byte spec read to reclaim
   ~230 bytes is all cost), and what is left behind is a 600-character
   head-and-tail **excerpt**, not an anonymous hole: the path or headline at the
   top and the error or exit status at the bottom, for about 4% of a 15KB
   result. A result the run can no longer identify is a result it cannot decide
   to re-run.
2. **Keep a token-budgeted verbatim tail.** 30% of the model's real window, in
   tokens. A message count is the wrong unit: six messages of a tool-heavy run
   is a rounding error against a 200k window, and six _huge_ messages are larger
   than the whole budget. A count floor of six messages survives as a floor —
   but it yields at 1.25× the budget, and the pair-safe snap walks _forward_
   when walking backward would keep more than the budget allows.
3. **Summarize the head into the merged state.** One round trip, on the light
   tier where one is configured, bounded by a wall clock and the turn's abort.

The trigger is 70% of the model's real context window, measured from
provider-reported usage where the provider reports it. Compaction aims to land
at 50%, comfortably under the trigger, so the next turn does not immediately
re-compact.

Three rules keep a compaction worth its round trip:

- **A head that is a sliver is not folded.** Under 15% of the working set, the
  summarizer is not called at all; eviction gets a turn instead, and otherwise
  the answer is an honest "nothing to compact".
- **A compaction that would not shrink the working set is discarded.** A merged
  state can be larger than the few small messages it replaces; applying it pays
  a round trip to make the prompt bigger and loses the verbatim text as well.
- **An explicit compaction cuts harder than an automatic one.** The 30% tail is
  the automatic policy, conservative because nobody asked. `compact_context`
  and an over-limit rejection were asked to free room now, so they keep the
  recent exchange and fold the rest. `gear audit` labels which policy produced
  a given tail, because the two are not comparable.

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
with its before/after sizes, what it dropped and what asked for it. It is read
from the persisted usage rows, not from a live counter — the process holding a
counter is often the one that died.

```
  Context  23 turns measured · peak 82% of 100,000 (81,600) · last 82% · cache 75% · window assumed for some turns
    #97    ███████···  72% 71,700 / 100,000 · cache 75% (window assumed)
    #103   ████████··  75% 75,000 / 100,000 · cache 75% (window assumed)
    #113   ████████··  82% 81,600 / 100,000 · cache 75% (window assumed)
    #52    compacted 25,591 → 17,735 (-31%) · old tool-result bodies, kept as excerpts · auto (high-water mark, 30% tail)
    #74    compacted 17,635 → 10,772 (-39%) · 25 messages folded into the merged state · requested (compact_context, cuts to the recent exchange)
```

A turn whose provider reported no usage renders as `no data`, never as zero, and
the whole section says so when no turn reported anything:

```
  Context  23 turns · no data — no provider on this run reported input usage
```

Two honesty notes are carried rather than smoothed over. **"window assumed"**
marks turns whose model matched no rule in the window table, so the denominator
is the conservative default rather than a known number. And a compaction's tail
is only comparable to another's when the same policy sized it, which is why the
trigger is on the line: `auto` keeps 30%, `requested` and `overflow` cut to the
recent exchange. Rows written before this landed say "trigger not recorded"
instead of being assigned one.

## Provider-side context editing

Some providers offer to do part of this server-side. Where the API the gateway
targets exposes it, it belongs behind the cache-policy table in
[`providers.md`](providers.md) as an opt-in, alongside the measured evidence for
every other provider claim.

**Today it does not.** The gateway is pinned to `@anthropic-ai/sdk@0.39.0`,
which sends `anthropic-version: 2023-06-01`, calls the stable
`client.messages.create`, declares no `context_management` field, and whose
`AnthropicBeta` union ends at `output-128k-2025-02-19`. There is nothing to
opt into without inventing a wire shape. The full check, and what would have to
change first, is in
[`providers.md` § Provider-side context editing](providers.md#provider-side-context-editing-not-offered-by-the-api-this-gateway-targets-p108).

Tier 1 above is the same idea run client-side, and it ships.
