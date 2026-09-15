# M4 — bounded repair and useful delegation

Written 2026-09-15 by the supervising session after M3's first branch, the verifier pass and
its fix lanes. Spec for the M4 lane. Applies
[the review's M4](guarantees-plan-review-20260914.md#m4--bounded-repair-and-useful-delegation)
on top of what exists: the pure arbiter and shadow rows (M2), `[controller] authority` with
the persisted `decision` row and the `legacy()` rollback (M3), derived criterion status and
`--acceptance` (M1, hardened by Fix lane A), and the existing task/worker/workflow execution
with ownership-aware integration, leases, checkpoints and the 47-scenario lifecycle rig.

## The one rule

**A failure has a type, and the type decides the response.** Today the loop's retries are
scattered guards with their own counters. M4 gives the controller a typed `repair` decision:
the arbiter reads the failure class from runtime facts (never from model prose) and proposes
one bounded response; the loop acts only when the class's key is in `[controller] authority`.

| class                 | what the runtime saw                                                 | response (bounded)                                                                           | never                                    |
| --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `transport`           | provider stream error, 5xx, timeout, rate wait with a retry hint     | wait per hint or backoff, retry ≤ N; then `abandoned(environment)`                           | a different provider unless `[fallback]` |
| `check_failed`        | a project check or an evaluator command exited non-zero              | one repair turn naming the check and the tail of its output; re-verify only the impacted set | rerun unrelated suites endlessly         |
| `acceptance_mismatch` | evaluator criterion `failed` at the finish gate (M3's second branch) | one repair turn naming the criterion text, never its command; then `partial`                 | a second re-prompt on the same finish    |
| `missing_dependency`  | `not-applicable`-shaped output: no runner, module not found          | say so, mark `needs_review`, no retry                                                        | install anything                         |
| `denied`              | permission denied, containment halt, spend cap, ask refused          | stop that action; report; no alternative route                                               | try another path around the boundary     |
| `no_progress`         | E9/E10/E12 signatures with no evidence/artifact change               | one nudge, then `abandoned(no_progress)` (class 5 never completes)                           | count a re-read as progress              |

Limits are **shared and durable**: attempts and repair turns are counted on the run's
`decision` rows (like M3's allowance), so a restart continues the count; spend is the gateway's
ledger; a turn refund never refunds usage. The same limits apply to the lead, workers,
compaction and fallback: a worker's repair turns come out of the run's budget.

## Delegation, verified against the combined tree

Reuse `task` / `worker` / `workflow` (the review is explicit: do not delete them). M4 adds:

- A child receives a **bounded subset of the contract**: the criteria it owns (by id), its
  owned files, its dependencies, its share of the budget. It returns artifacts and evidence
  (check runs with their revision stamps), never a verdict.
- **Integration is verified, not assumed.** After a child's patch lands, the runtime re-runs
  the checks bound to the child's criteria on the combined tree, and compares the destination
  revision to the one the child started from; if the destination moved incompatibly (the
  child's owned files changed underneath it, or its bound check fails only after integration)
  the run reports `not integrated` with the reason and keeps the user's edits. A correct patch
  on a changed destination is not "integrated".
- Child prose cannot grant acceptance: a child's `record_evidence` moves rungs only on the
  criteria it owns, through the same relatedness and authorship rules as the lead.
- Agent count is not a target: the fleet panel shows cost and failures per child; nothing
  rewards spawning.

## Exit tests (deterministic, scripted providers, the SIGKILL rig where restart matters)

| #   | Requirement                                    | Test                                                                                                                                 |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Failed checks lead to relevant bounded repairs | a red project check → exactly one repair turn naming it; the re-verify runs only that check's bound criteria's checks, not the suite |
| R2  | Unrelated tests are not rerun endlessly        | count of check executions per finish attempt is bounded and named                                                                    |
| R3  | Denied is not an invitation                    | a permission denial → no alternative command is attempted; the row says `denied`                                                     |
| R4  | Limits survive restart                         | SIGKILL after one repair turn; the resumed run gets none, ends `partial`                                                             |
| R5  | Child prose cannot grant acceptance            | a worker that reports "done" with no bound check → its criteria `unassessed`                                                         |
| R6  | Incompatible destination                       | the lead edits a file the child owns after dispatch → `not integrated`, the user's edit kept                                         |
| R7  | Exhausted repair returns a durable partial     | after the bound, the verdict is `partial` with the gap named and the text intact                                                     |
| R8  | Rollback                                       | every class key absent → byte-identical event sequences and spend to the pre-M4 tree on the branch's scenarios                       |
| R9  | Missing runner is not a failure of the work    | `bun: command not found` → `needs_review`, no retry, one sentence                                                                    |

Mutation: force the class to `transport` for every failure → R1, R3, R9 red.

## Non-goals

No mission daemon, no cross-run scheduling (M6). No change to permissions, sandbox or the
reviewer. No new authority by default: every class ships with its key absent, and M3's
`legacy()` shape is the rollback for each.
