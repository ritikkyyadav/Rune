# M2 — a passive controller in shadow

Written 2026-09-14 by the supervising session at `37fca75`, after M0, M1 and the Phase 4
§2.8 lane. This is the spec for the M2 lane. It builds on
[the guard inventory](guard-inventory-20260914.md#deliverable-4--the-shadow-arbiter-mapping)
(§4.0 the six-class ladder, §4.1 guard → proposal → class, §4.2 the typed state, §4.3 which
guards shadow cleanly, §4.4 what to assert) and applies
[the review's corrections](guarantees-plan-review-20260914.md#m2--build-a-genuinely-passive-controller-in-shadow).
Existing guards keep every decision. Nothing here dispatches, refuses, spends, or writes
authoritative task state.

## The one rule

**Shadow means pure.** `decide(snapshot, event) → Decision` is a function of two values. It
cannot call a tool, sleep, mutate a counter, allocate a budget, produce a prompt, or touch the
gateway. It runs beside the guard, the guard acts as it always did, and the only output is a
bounded ledger row that says what the arbiter WOULD have decided and what the guard DID.

## Data

`RunState` (new `run-state.ts`): the read-only snapshot of §4.2, `version: 1`, assembled by a
`snapshot()` method on the loop from the locals that already exist. Fields the loop does not
hold (`spentUsd`, the ledger's criteria) come from the Engine via the existing accessors
(`contractRecord`, cost). A field that cannot be read at a site is `undefined`, never invented.

`ShadowEvent`: `{ id, runId, seq, at, guard: GuardId, class: 0..5, inputs: Record<string, unknown> }`
— `id` is `${runId}:${seq}`; `inputs` are the predicate's own booleans/counters (never message
text, never tool arguments, never credentials). One event per guard trigger, from the sixteen
guards §4.3 lists as shadowing cleanly today (E1, E2, E4, E5, E6, E7, E8, G0, G3, G4, G5,
G6, G7, G8, R17, the second wind's predicate) plus **E3/N9 halt as the proof case** and the
completion verdict (class 4, last). The nine guards §4.3 says need surgery are NOT shadowed in
M2; they get an event of kind `unshadowed` at most once per run so the summary can say what
was not seen.

`Decision`: `{ id, eventId, transition, class, reason, applied: false }` where `transition` is
one of the RunState phases (`working`, `verifying`, `repairing`, `blocked(ask|halt)`,
`complete(verdict)`, `abandoned(reason)`) or `unknown`. `unknown` is the answer when a required
input is `undefined` — a missing input is an unknown, never agreement.

`Actual`: `{ eventId, transition }` — what the guard's own code did, recorded at the same site
from the same booleans. The comparison is `decision.transition === actual.transition`.

## The ladder and the tie-breaks

Six classes, from §4.0: `0 user > 1 safety > 2 budget > 3 environment > 4 contract >
5 progress`. When several events arrive in the same step (the loop already batches: a halt
during a failing verification round; an abort during a halt; budget exhaustion beside a
verdict; provider loss beside a verdict), the arbiter takes the lowest class and records the
losers as `superseded_by`. Within a class, the earlier `seq` wins. **Class 5 never proposes
`complete`** — that single rule makes G9 (empty completion accepted as done) a recorded
disagreement, which is the point. **A terminal transition is absorbing for that run id**: a
later event on the same run decides `unknown` with reason `run already terminal`, and the
summary counts it.

Persistence definitions (recorded, not enforced in M2): retry, refund and wind counters are
logical attempts; a turn refund changes `maxTurns`, never recorded usage; `spentUsd` is
rehydrated from cost rows and is never reduced by a refund. A test pins the last clause.

## Shadow wiring

- Config `[controller] shadow = true | false`, default **true** for the lead loop, always
  false for sub-agent loops. With it false the loop emits nothing and allocates nothing.
- Rows: `shadow_decision` per event (event, decision, actual, agree, overheadUs), capped at
  **200 per run**; the 201st writes one `shadow_capped` row and the rest are counted only.
  One `shadow_summary` per run: events, agreements, disagreements, unknowns, superseded,
  unshadowed guards seen, `overheadUs {p50, p95, total}`. Both go in `RUN_TRACE_EVENTS`.
  No row carries message text, tool arguments, file contents or credentials; a test greps.
- `rune audit <session>` prints the summary as one block.

## Exit tests (each is a file; deterministic; zero model calls)

| #   | Requirement (review)                             | Test                                                                                                                                                                               |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Deterministic replay                             | `arbiter.test.ts`: the same event sequence replayed twice yields byte-identical decisions (hash), and a permuted sequence within a step yields the same winner                     |
| S2  | Injected concurrent events agree with the ladder | halt ∧ failing verification → class 1; abort ∧ halt → class 0; budget ∧ verdict `met` → budget; provider lost ∧ verdict → environment; two class-5 events → earlier seq            |
| S3  | Shadow changes neither actions nor spend         | `shadow-no-effect.test.ts`: one lifecycle scenario run with shadow on and off — identical `AgentTurnEvent` sequence (minus the rows), identical spend fingerprint, identical files |
| S4  | Discrepancies name causes                        | `shadow-report.test.ts`: over `lifecycle-durability`'s scenarios the summary's disagreements are enumerated and each names guard + expected vs actual; G9 is expected among them   |
| S5  | Missing input is unknown                         | an event with a required input `undefined` decides `unknown`, counted as unknown, never as agreement                                                                               |
| S6  | Bounded logging                                  | a run driven to 1,000 events writes 200 `shadow_decision` rows + 1 `shadow_capped` + 1 summary; no row exceeds 2 KB                                                                |
| S7  | The four verdict-less exits                      | E6, E7, E9, E11 each yield a distinct `abandoned(reason)` decision; none is `provider_lost` (E9/E11 are `unshadowed` in M2 — assert the exit's own terminal event instead)         |
| S8  | Absorbing terminal                               | an event after a terminal decision on the same run id → `unknown: run already terminal`                                                                                            |
| S9  | Refund never refunds usage                       | `spentUsd` after a refund equals the cost rows' sum                                                                                                                                |
| S10 | Overhead is measured, not asserted away          | the summary's `overheadUs` from S4's run is printed in the report with p50/p95; no threshold is claimed                                                                            |

Mutation: force `decide` to always return the guard's actual transition and S2, S4 (G9),
S5 must go red.

## Non-goals

No guard loses authority (M3 migrates one at a time behind a rollback switch). No line-count
gate. No persistence of RunState as authoritative state. No arbiter over the founder's stored
runs — their logs do not hold every predicate input (review, P2), so the evaluation corpus is
the deterministic scenarios. No change to permissions, sandbox, budgets, or the TUI.
