# M1 — acceptance semantics before enforcement

Written 2026-09-14 by the supervising session, against HEAD `4869e4c` plus the F-5B lane
(the two reproduced contract defects, `not-applicable-on-parent`, the relatedness gate on
`record_evidence`, and verdict kind `none`). This is the spec for the M1 lane. It extends
`contract.ts`, `brief.ts` and `@rune/protocol`'s round-trip types; it creates no second store
and activates no controller. Read [the review](guarantees-plan-review-20260914.md#m1--define-acceptance-semantics-before-enforcement)
for the requirements this satisfies.

## The one idea

Today one fact — the rung — is asked to answer three questions: _did a check pass_, _is this
change why it passes_, and _is the criterion accepted_. `BriefLedger.record` refuses `verified`
without a parent-commit failure, and `computeVerdict` requires every criterion at `verified`,
so a legitimate new feature can never be `met`, and an unrelated green command could be
(F1). M1 stores the **facts** separately and **derives** acceptance from them:

| Fact                     | Where it lives today                         | M1                                                                                   |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| A command ran and passed | `CheckLog` (`CheckRun`)                      | unchanged, plus a stable `executionId` per run                                       |
| The check speaks to X    | `checkRelatedness` at citation time (F-5B)   | recorded on the evidence (`unrelated` when refused; `bound` otherwise)               |
| The tree moved since     | `Evidence.head/dirty/digest`, `demoteStale…` | unchanged; read by status derivation instead of only demoting the rung               |
| This change is WHY       | `parentCommitFailed` → rung `verified`       | kept exactly, as **attribution** — reported, never required for acceptance           |
| Who stated the criterion | nobody (every criterion is the read-back's)  | `source: "user" \| "inferred" \| "evaluator"`, `required`, `id`, contract `revision` |
| Is it accepted           | `rung === "verified"`                        | `criterionStatus()` → `unassessed \| satisfied \| failed \| stale \| needs_review`   |
| How the run ended        | `turn_complete.stopReason`                   | also on the `verdict` row as `execution`, separate from `kind`                       |

The rung ladder keeps its meaning (`observed` ran once, `reproduced` ran twice, `verified`
failed on the parent). Nothing that reads a rung today breaks. What changes is that the
verdict stops reading the rung as acceptance.

## Data (additive; every field optional on the wire, legacy rows still parse)

`Criterion` gains:

- `id?: string` — stable across amendments. Assigned by the runtime at promotion
  (`c1`, `c2`, … within a contract); an amendment that keeps a criterion's text keeps its id.
- `source?: "user" | "inferred" | "evaluator"` — `read_back` criteria are `inferred`. `user`
  is a criterion the person stated (the `--acceptance` file's `source: "user"` entries, or an
  edited brief through `BriefDecision.edited`). `evaluator` is an independent acceptance
  check the model never sees. Absent means `inferred`.
- `required?: boolean` — absent means `true`. Only `user` origin can make one optional; the
  read-back schema has no such field, so the model cannot.
- `method?: { kind: "command"; command: string } | { kind: "review" }` — for `evaluator`
  criteria, the command the runtime runs itself. `review` marks a criterion only a person
  can settle; it derives `needs_review` and is never `satisfied` by the runtime.

`Evidence` gains:

- `executionId?: string` — the `CheckRun` this evidence was priced from (`chk-<n>` in the log).
- `verifier?: string` — `"check-log@1"` (a model-run command read from the log),
  `"parent-probe@1"` (attribution), `"acceptance-command@1"` (the runtime ran an evaluator
  criterion's own command). Producer output and verifier assessment are separate records:
  the check's summary stays on the `CheckRun`; the assessment is the evidence.
- `result?: "passed" | "failed"` — what the verifier saw. Today evidence exists only for a
  pass; M1 records a failed acceptance command too, so `failed` is a status with a receipt.
- `env?: string` — a short fingerprint (`bun`/`node` version, platform) so a claim can be
  told from a claim taken on a different toolchain. Cheap, and it is what the review means
  by "relevant environment/config fingerprint"; do not build a dependency graph here.

`TaskContract` gains:

- `revision: number` — 1 at intake, +1 on every amendment that changes the digest.
- `constraints: string[]` — the `leave` list plus every `user`-sourced constraint, carried
  forward by `carryForward` and never dropped by a model amendment.
- `amendments: Array<{ revision; at; origin: "model" | "user" | "runtime"; added: string[]; kept: string[]; removed: string[] }>`
  — `kept` names the `user`/`evaluator` criteria a model read-back omitted and the runtime
  retained. A model amendment can add `inferred` criteria and reword its own; it cannot
  remove or optionalise `user`/`evaluator` ones. Only `user` origin removes.
- `uncovered: string[]` — required criteria with no bound evidence at verdict time, named
  in the verdict's gaps as `no check bound`.

`CompletionVerdict` gains `execution: { stopReason: string; status: TaskLifecycleStatus }`
on every kind, and `CriterionOutcome` gains `status`, `source`, `required` and
`attribution: "regression" | "none"`. `met` requires **every required criterion
`satisfied`**, no red check, no open step. `partial`/`unmet`/`none` as F-5B left them.

## Derivation (pure, in `contract.ts`)

```
criterionStatus(criterion, checks, now: StampedRevision | null):
  method.kind === "review"                         → needs_review
  no evidence                                      → unassessed
  evidence.unrelated                               → unassessed   (set aside moves nothing)
  evidence.result === "failed"                     → failed
  the bound check's LATEST run failed              → failed       (by executionId, else by normalizeCommand)
  now given and evidence has head/digest and the
    tree moved under it (demoteStaleCriteria's
    own test, not a copy of it)                    → stale
  evidence cannot be dated (no head AND no digest)  → needs_review
  otherwise                                        → satisfied
```

Legacy rows (no `executionId`, no `result`): `verified`/`reproduced` with a fresh revision →
`satisfied`; `observed` → `needs_review` (it may be an execution receipt, and the review says
map conservatively, never upgrade a saved session); `suspected` → `unassessed`.

`accepted(c) = c.required === false || status === "satisfied"`. Attribution is
`"regression"` iff `evidence.parentCommitFailed`. It is printed beside the status; it gates
nothing.

## Evaluator criteria: the independent oracle

Headless gets `--acceptance <file>`; `Engine` config gets `acceptance?: AcceptanceSpec[]`
with `{ id, text, command, required?: boolean, source?: "user" | "evaluator" }`. Rules:

- Loaded at intake into the contract as criteria; **never rendered into any prompt** and
  never listed by `read_back`'s reply. The file may live outside the workspace.
- `record_evidence` refuses to move an `evaluator` criterion ("settled by the runtime's own
  run, not by citation"). Only the acceptance runner writes its evidence.
- At the finish gate — the same point `verdictFor` is computed, before the final
  compaction — the runtime runs each evaluator command once, through the tool registry's
  `bash` (same sandbox, same cwd, `verifyTimeoutMs`), records a `CheckRun` with
  `kind: "check"` and an `executionId`, and records evidence `verifier: "acceptance-command@1"`
  with `result`. A non-zero exit is `failed` with the tail of the output as `detail`.
- **Advisory in M1.** A failed evaluator criterion makes the verdict `partial` with the gap
  named; it does not refuse the finish or re-prompt. The one bounded acceptance re-prompt is
  M3's first migrated branch, once the false-positive/false-negative cases below pass.
- An evaluator command that cannot run (`not-applicable`-shaped output, missing runner)
  derives `needs_review`, never `satisfied` and never `failed`.

## Exit tests (each is a file; each drives the real Engine with a scripted provider)

| #   | Requirement from the review                                                         | Test                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | A known omitted feature fails independent acceptance despite green tests            | `tests/integration/acceptance-omission.test.ts`: two evaluator criteria, model does one, its own tests green → `partial`, the omitted one `failed`, `execution.status = end_turn` |
| T2  | A legitimate new feature passes without a failing parent                            | `acceptance-new-feature.test.ts`: new test file that reads the touched file, cited once, parent probe `not-applicable` → `satisfied`, `attribution: none`, verdict `met`          |
| T3  | Unrelated green checks cannot satisfy it                                            | F-5B's promoted forgery test + a unit case: `unrelated` evidence derives `unassessed`                                                                                             |
| T4  | Constraints survive amendments and restart                                          | `task-contract-amendments.test.ts`: `user` criterion omitted by a read-back → `kept`; SIGKILL + resume through `tests/helpers/scenario.ts` → `constraints` and `revision` survive |
| T5  | A stale or unmapped criterion stays unaccepted                                      | unit in `contract.test.ts` (digest moved → `stale`; no head/digest → `needs_review`) + integration: an edit after evidence → verdict `partial`, gap `stale`                       |
| T6  | Partial output keeps its usefulness and honest status                               | budget exit with one `satisfied` criterion: verdict `partial`, `execution.status = budget`, the model's text intact in the envelope                                               |
| T7  | An explanation is delivered with its limits stated, no failing parent needed        | F-5B's promoted question test (`none`, reason names the limit)                                                                                                                    |
| FP  | False positive: evaluator command that exits 0 without running anything             | `bun test nothing.test.ts` shape → `needs_review`, never `satisfied`                                                                                                              |
| FN  | False negative: a correct change whose evaluator command fails for a missing runner | derives `needs_review`, the gap says why, verdict `partial` not `unmet`                                                                                                           |

Mutation: force `criterionStatus` to `satisfied` and T1, T3, T5, FP must go red.

## Readers

- `verdictLine`: `[verdict] met — 3 of 3 accepted (1 regression-attributed)`;
  `[verdict] partial — 2 of 3 accepted; gap: the CSV header is unchanged (failed: exit 1)`.
- `rune audit`: one row per criterion: id, source, status, attribution, verifier, executionId.
- The TUI close block (`bin/ui/read-back.ts`): status word replaces the rung as the leading
  mark; the rung glyph stays as the receipt's strength. Touch this file only after the F-4
  lane's commits land, and keep the change to the close block.
- The headless envelope: `verdict` already structured; add nothing to `text` (F6 stays open).

## Non-goals

No arbiter, no gate refusal, no repair policy, no line-count gate, no change to permissions,
sandbox or budgets. `verified`'s meaning is unchanged. Saved sessions are not rewritten. The
model still proposes criteria; the runtime still decides what a citation is worth.
