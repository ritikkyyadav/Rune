# The guard inventory (Phase 5A, 2026-09-14)

> **Reconciliation, 2026-09-14 (M0).** This inventory was read at `912f99a` and
> re-pinned at `943efee`. Four commits have moved the guards since, and the line
> numbers below are NOT re-pinned to them; read this note first.
>
> - `385ff70` closed insertion point 3: the four verdict-less exits (E6, E7,
>   E9, E11) now yield `turn_complete` through one `terminal()` helper
>   (`agent-loop.ts`, 18 `yield this.terminal(…)` sites at `977789a`) with
>   true stop reasons `loop_detected` / `barren` / `budget` / `provider_lost`,
>   and N7 (`engine.ts`) no longer invents `provider_lost`; its residue is
>   `stalled`. Completion-order rows 12 and 15 are therefore one row.
> - `4869e4c` implemented insertion points 1 and 2: `createContract` at
>   intake (`engine.ts:5038`), `contract` rows deduped by digest
>   (`persistContract`, `engine.ts:6702`), the `verdict` row beside the
>   terminal row (`engine.ts:6002`), and `verdictFor` in the finish block.
>   Advisory: no guard in §1 moved.
> - `42e7c62` / `977789a` (F-5B, the interrupted lane finished) changed what
>   row 16 measures: `record_evidence` is now gated by `criterionScope` +
>   `checkRelatedness`, a parent run can be `not-applicable-on-parent`, the
>   verdict has a `none` kind for question/plan/chat shapes with no criteria
>   and no writes, and `failingChecks` keys on `normalizeCommand`.
> - The "one thing to get right first" (`Criterion.required`) is decided by
>   [M1](m1-acceptance-semantics.md) differently from the recommendation
>   here: `required` exists but only `user` origin can set it false; the model
>   still cannot weaken a criterion. §3b row 16 — `complete` counts only
>   `verified` — is what M1 replaces with a derived status.
> - Sizes at `977789a`: `agent-loop.ts` 5,253 lines, `engine.ts` 7,776.
>   No guard was deleted or migrated; nothing in §1 is superseded.

**Read at `912f99a`, re-pinned at `943efee`.** The brief named `b5aef39`. Five
integrator commits landed while this lane read (`c0936d5`, `912f99a`, `407e5be`,
`415ab86`, `943efee`). **None touches a guard.** `c0936d5` adds a
`ChildAgentEvent` field to the progress-pump item type
(`agent-loop.ts:3430-3437`); the other four are UI and settings.
`git diff 912f99a..943efee` over every file cited here is empty except
`bin/ui/read-back.ts` (+9/-2) and `bin/ui/tui.ts` (+23/-0), and those two
citations have been re-pinned to `943efee`. Everything else — `agent-loop.ts`,
`engine.ts`, `brief.ts`, `turn-refunds.ts`, `turn-budget.ts`, `lifecycle.ts`,
`task-state.ts`, `reliability-policy.ts`, `protocol/roundtrips.ts` — is
byte-identical across the range, so every guard line number below is stable.
All citations are from `git show <rev>:<path>`, never the working tree. `packages/orchestrator/src/agent-loop.ts` is 5,185 lines;
`engine.ts` is 7,627.

**The headline.** The audit said "roughly ten independent guards". There are
**24 named guards inside `agent-loop.ts` alone** and **38 across the loop and
the helpers it calls**, plus 13 distinct terminal exits from one `while` loop.
Four of those 13 exits emit no `turn_complete` at all, so the run's own
terminal verdict is invented afterwards by `engine.ts:5883-5885`. That is the
"nothing arbitrates" the audit described, and it is worse than described.

**Vocabulary used below.** END = the turn/run stops here. EXTEND = the budget
moves. REDIRECT = the model is re-prompted, nudged, refused, or paced but the
run continues. GATE = a finish is refused or waived.

---

## Deliverable 1 — the inventory

### 1.1 END — the thirteen terminal exits of one `while` loop

The loop header is `agent-loop.ts:1744-1748`:

```
while (
  turn < this.config.maxTurns ||
  (haltReportPending && !haltReportGranted) ||
  secondWind()
)
```

| #   | Name                           | file:line                                                            | Trigger (exactly what it reads)                                                                                                                                     | Decision                                                                                        | State kept (lost on restart)                                                                                                                                                                            | Gears                                                     | Tests                                                                      | Ledger row                                                 |
| --- | ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| E1  | Turn ceiling                   | `agent-loop.ts:1744` (condition), `:4897-4913` (exit)                | `turn >= this.config.maxTurns`, after `secondWind()` declines                                                                                                       | END `max_turns` + handoff                                                                       | `turn`, `this.turnsUsed`, `config.maxTurns` (mutated in place by refunds and winds) — **all in-memory**; only `turn_complete.totalTurns` ever left the loop before `getBudgetProgress()` (`:1037-1043`) | all                                                       | `agent-loop-endurance.test.ts`, `turn-budget.test.ts`                      | `loop.max_turns` (warn)                                    |
| E2  | Abort                          | `:1750-1755`, `:2167-2171`, `:2297-2302`, `:3172-3176`, `:4674-4679` | `signal.aborted` at five checkpoints                                                                                                                                | END `aborted` + handoff                                                                         | none                                                                                                                                                                                                    | all                                                       | `agent-loop-interject.test.ts`                                             | —                                                          |
| E3  | Supervisor halt                | latch `:3367`; report requested `:4689-4718`; run ends `:2497-2508`  | `PermissionCheckResult.halt.reason` from the broker (`:93`), first halt in a batch wins                                                                             | buys one tool-less turn, then END `halted`                                                      | `haltNotice`, `haltReportPending`, `haltReportGranted` — in-memory                                                                                                                                      | Auto (broker only runs in Auto)                           | `agent-loop-halt.test.ts`, `tests/integration/engine-halt-to-loop.test.ts` | `loop.auto_halt` (error), `loop.auto_halt_reported` (warn) |
| E4  | Empty-completion counter       | `:2407-2461`                                                         | `stopReason === "end_turn"` with no text ever this run, or no text since the last tool batch; or `claimedToolUseButNone`                                            | 3rd (or 2nd) strike → END `provider_lost`                                                       | `emptyCompletions`, `anyTextThisRun`, `textSinceLastTools`, `anyWritesThisRun` — in-memory                                                                                                              | all                                                       | `agent-loop-empty-completion.test.ts`                                      | `provider.empty_completion` (warn→error)                   |
| E5  | Consecutive provider errors    | `:2270-2281`, `:2303-2315`; exit `providerLostEnd` `:1373-1396`      | `consecutiveErrors >= config.maxConsecutiveErrors` (default 3, `:303`); reset to 0 on any clean stream `:2323`                                                      | END `provider_lost` — **unless** every planned step is done, then END `end_turn` (`:1375-1382`) | `consecutiveErrors` — in-memory                                                                                                                                                                         | all                                                       | `agent-loop-provider-lost.test.ts`, `agent-loop-fallback.test.ts`          | `provider.stream_error`, `loop.consecutive_errors`         |
| E6  | Non-retryable provider error   | `:2174-2178`                                                         | `result.retryable === false` and no parseable retry window                                                                                                          | END on an `error` event — **no `turn_complete`**                                                | none                                                                                                                                                                                                    | all                                                       | `agent-loop-quota-stop.test.ts`                                            | handoff `error` only                                       |
| E7  | Budget admission error         | `:2287-2292`                                                         | `BudgetExceededError` / `BudgetPricingError` thrown by the gateway before the call                                                                                  | END on an `error` event — **no `turn_complete`**                                                | none                                                                                                                                                                                                    | all                                                       | not found                                                                  | handoff `error` only                                       |
| E8  | Truncation retries             | `:2540-2569`                                                         | `stopReason === "max_tokens"` more than `maxTruncationRetries` (default 2, `:261`)                                                                                  | END `max_tokens`                                                                                | `misencodedCalls`, truncation counter — in-memory                                                                                                                                                       | all                                                       | `agent-loop-truncation.test.ts`                                            | —                                                          |
| E9  | Loop detector (batch)          | nudge `:3110-3139`; bail `:3140-3159`                                | `batchSignature(pendingToolCalls)` seen ≥3× with the **same `writeCount`** and the **same `resultSig`** (`:3106-3109`), after `maxStuckNudges` (default 1) is spent | END on an `error` event — **no `turn_complete`**                                                | `recentToolSignatures` (10 entries), `stuckNudges`, `writeCount` — in-memory                                                                                                                            | all                                                       | `agent-loop-loop-detector.test.ts`, `agent-loop-verify-cycle.test.ts`      | `loop.stuck_nudge` (warn), `loop.infinite_loop` (error)    |
| E10 | Result-recurrence detector     | nudge `:4586+`; bail `:4556-4585`                                    | the same `resultSignature` back ≥4× at an unchanged `writeCount` across _varying_ calls, after 1 nudge                                                              | END `stalled` + handoff                                                                         | `recentResultSigs` (12 entries), `resultLoopNudges` — in-memory                                                                                                                                         | all                                                       | `agent-loop-recurrence-escalation.test.ts`                                 | `loop.result_loop` (warn), `loop.stalled` (error)          |
| E11 | Barren-turn breaker            | bail `:4728-4746`; nudge `:4747-4776`                                | 3 consecutive turns where `planned.every(p => p.deterministicallyRefused)` — human refusals excluded by `userDecision` (`:95-101`)                                  | END on an `error` event — **no `turn_complete`**                                                | `barrenTurns`, `barrenNudges` — in-memory                                                                                                                                                               | all (fires mostly in Auto)                                | `agent-loop-breaker.test.ts`                                               | `loop.barren_nudge` (warn), `loop.barren_turns` (error)    |
| E12 | Progress breaker (stale turns) | `:4800-4826`; nudge `:4827+`                                         | `staleTurns >= maxStaleTurns*2` (default 6→12): no write, no accepted plan change, no unseen `resultKey`                                                            | END `stalled` + handoff                                                                         | `staleTurns`, `staleNudges`, `seenResults` (a `Set` of every result key this run) — in-memory                                                                                                           | **lead loop only** (`if (this.config.taskState)` `:4785`) | `agent-loop-progress.test.ts`                                              | `loop.stale_nudge` (warn), `loop.stalled` (error)          |
| E13 | Normal finish                  | `:3068-3071`                                                         | `stopReason !== "tool_use"` and every gate below passed                                                                                                             | END `end_turn`, or `open_steps` if E13 was reached with open todos (`:3020`)                    | `stopReason` accumulated in-memory                                                                                                                                                                      | all                                                       | `agent-loop-finish-gates.test.ts`                                          | —                                                          |

**E6, E7, E9 and E11 emit no `turn_complete`.** `engine.ts:5883-5885` then
reconciles: `this.liveStatus = signal.aborted ? "aborted" : runError ?
"provider_lost" : "end_turn"`. Since all four yield an `error` event, which
sets `runError` at `engine.ts:5442`, **a loop-detector kill, a barren-turn
kill, a budget-admission refusal and a genuine provider outage all record
identically as `provider_lost`.** The lifecycle vocabulary
(`lifecycle.ts:270-280`) has nine statuses and no spelling for "the harness
stopped this run".

### 1.2 EXTEND — the budget movers

| #   | Name                     | file:line                                                                                              | Trigger                                                                                                                                                              | Decision                                                                              | State kept                                                                                                      | Gears                                                                                        | Tests                                                                         | Ledger row                   |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------- |
| X1  | Turn refunds             | `turn-refunds.ts:56-83`; applied in the incident funnel `agent-loop.ts:1108-1136`; constructed `:1532` | an `IncidentClass` in `REFUNDABLE_INCIDENTS` (`turn-refunds.ts:28-51` — 11 classes) reported during a turn; at most once per turn; cap = `ceil(baseMaxTurns * 0.25)` | `config.maxTurns += 1`                                                                | `granted`, `lastRefundedTurn`, `this.currentTurn` — in-memory; the mutated `config.maxTurns` is never persisted | all **except** clocked sub-agents (`turnBudgetNotice` → constructed with base 0, `:1532`)    | `agent-loop-turn-refund.test.ts`, `agent-loop-citation-carry-forward.test.ts` | `loop.turn_refunded` (debug) |
| X2  | Second wind              | `:1716-1742`, evaluated lazily in the loop header `:1747`                                              | `turn >= maxTurns` AND `windsUsed < maxSecondWinds` AND `taskState.hasOpenTodos()` AND `counts.done > windDoneAtStart` AND `!quotaWallSighted` AND `!signal.aborted` | `config.maxTurns += baseMaxTurns`, re-arms the wrap-up reserve, queues a harness note | `windsUsed`, `windDoneAtStart`, `pendingWindNote`, `this.secondWindsUsed` — in-memory                           | lead loop only (needs `taskState`); `maxSecondWinds` default 0, engine grants 2 to main runs | `agent-loop-second-wind.test.ts`                                              | `loop.second_wind` (warn)    |
| X3  | Halt report turn         | `:1746` (`haltReportPending && !haltReportGranted`), latched `:1794`                                   | a halt landed on or after the last turn                                                                                                                              | one extra turn past the ceiling, tools stripped (`:1879`)                             | `haltReportGranted`                                                                                             | Auto                                                                                         | `agent-loop-halt.test.ts`                                                     | —                            |
| X4  | Crash-resume inheritance | `turn-budget.ts:105-126` (`applyInheritance`), input from `lifecycle.ts:445-470` (`inheritedBudget`)   | previous run's persisted lifecycle row is not `end_turn` and had open steps                                                                                          | **narrows** the next run: `maxTurns - turnsUsed`, `secondWinds - windsUsed`, floor 1  | reads the persisted `run_trace`/`lifecycle` row — the **only** guard state that survives a restart              | lead loop                                                                                    | `turn-budget.test.ts`, `tests/integration/engine-lifecycle-restart.test.ts`   | reads `run_trace`            |
| X5  | Conversational budget    | `turn-budget.ts:57-78` (`turnBudgetForMessage`)                                                        | message ≤140 chars, single line, matches `SMALLTALK_RE` or is a verb-free question                                                                                   | **narrows** to `CONVERSATIONAL_MAX_TURNS` (8) and injects a "answer and stop" note    | none (per message)                                                                                              | lead loop                                                                                    | `turn-budget.test.ts`                                                         | —                            |

### 1.3 GATE — where "done" is refused or waived

These run in strict source order inside the `stopReason !== "tool_use"` block
(`agent-loop.ts:2576-3071`). **Order is the arbitration.** Each is
`<counter> < 1`, so each refuses exactly once per run.

| #   | Name                                                                                 | file:line                                                          | Trigger                                                                                                                                                                                                   | Decision                                                                                                                           | State kept                                                                                                                                                 | Gears                                                                                                     | Tests                                                                | Ledger row                                                                                                  |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| G0  | Pending interjection                                                                 | `:2578-2582`, again `:3053-3057`                                   | `hasPendingInterjections()`                                                                                                                                                                               | REDIRECT — the finish is cancelled, the user's new text folded in                                                                  | queue                                                                                                                                                      | all                                                                                                       | `agent-loop-interject.test.ts`                                       | —                                                                                                           |
| G1  | Verification (project checks)                                                        | `:2585-2650`                                                       | `config.verifier` present AND `editsSinceVerify` AND `verifyAttempts < maxVerifyAttempts` (default 3, `:2585`)                                                                                            | runs the checks scoped to `taskState.writtenFiles`; on red, re-prompts and `continue`                                              | `verifyAttempts`, `editsSinceVerify`, `verifyStillFailing`, `projectChecksPassed` — in-memory; the result goes to `taskState.noteVerification` (persisted) | all with a verifier; sub-agents run without one                                                           | `agent-loop-verify.test.ts`, `agent-loop-verify-cycle.test.ts`       | `loop.verification_failed` (warn) + `gate:verification-failed` message tag                                  |
| G2  | Replan nudge                                                                         | `:2651-2690`                                                       | verify attempts exhausted AND `verifyStillFailing` AND `replanNudges < maxReplanNudges` (default 1)                                                                                                       | resets `verifyAttempts = 0`, demands a different approach — worst case `maxVerifyAttempts × (maxReplanNudges+1)` verification runs | `replanNudges`                                                                                                                                             | all                                                                                                       | `agent-loop-verify-cycle.test.ts`                                    | `loop.replan_nudge` (warn)                                                                                  |
| G3  | Delegation-evidence gate                                                             | `:2696-2765`                                                       | `delegatedScopes.length > 0` AND at least one scope has **zero** reads (`isPathInside`, `:2705-2707`) AND `delegationNudges < 1`                                                                          | REFUSE the finish once                                                                                                             | `delegatedScopes`, `readPaths`, `delegationNudges` — in-memory                                                                                             | all                                                                                                       | `agent-loop-delegation-gate.test.ts`                                 | `loop.delegation_gate` (warn) + `taskState.logEvent("gate", …)` + tag `gate:delegation-evidence`            |
| G4  | **Execution-evidence gate**                                                          | `:2770-2845`; message tag **`gate:execution-evidence`** at `:2833` | `!planSettled` AND `anyWritesThisRun` AND `!executedSinceWrite` AND `!projectChecksPassed` AND `executionNudges < 1`                                                                                      | REFUSE the finish once                                                                                                             | `anyWritesThisRun`, `executedSinceWrite`, `writeCount`, `executionNudges` — in-memory                                                                      | all                                                                                                       | `agent-loop-evidence.test.ts`, `agent-loop-finish-gates.test.ts`     | `loop.evidence_gate` (warn)                                                                                 |
| G4w | Settled-plan waiver                                                                  | `:2788-2800` (computed), `:2794-2800` (logged)                     | `planCounts.total > 0 && open === 0 && unproven === 0 && settledPlanAtWriteCount + settledPlanExcusedWrites === writeCount`                                                                               | **stands G4, G5 down** — a gate disabler, not a gate                                                                               | `settledPlanAtWriteCount`, `settledPlanExcusedWrites`, `lastEvidencedWriteCount` — in-memory; withdrawn on a red check at `:3949-3953` and `:2624-2626`    | lead loop                                                                                                 | `agent-loop-settled-plan.test.ts`, `agent-loop-write-excuse.test.ts` | `taskState.logEvent("gate", "plan complete with evidence…")`                                                |
| G5  | **Fix-verified gate** ("fix-shaped task with zero verified criteria — refused once") | `:2847-2901` (header `:2847`, predicate `:2855-2863`)              | `ledgerStatus()` non-null AND `!planSettled` AND `ledger.total > 0` AND `ledger.verified === 0` AND `anyWritesThisRun` AND `fixVerifiedNudges < 1` AND `isFixShaped(taskState.currentRequest())` (`:442`) | REFUSE the finish once                                                                                                             | `fixVerifiedNudges` — in-memory; `ledgerStatus` is an engine closure over the brief ledger (persisted)                                                     | all with a brief                                                                                          | `brief-ledger.test.ts`, `agent-loop-finish-gates.test.ts`            | `loop.fix_verified_gate` (warn) + tag `gate:fix-verified`                                                   |
| G6  | Product-sight gate                                                                   | `:2903-2948`; follow-up notice `:2949-2968`                        | `visualReview.required` AND `snapshot().status !== "reviewed"` AND `productSightNudges < 1`                                                                                                               | REFUSE once; afterwards writes the unresolved review into task state and only _notices_                                            | `visualReview` snapshot, `productSightNudges`                                                                                                              | all                                                                                                       | `visual-verification` tests, `agent-loop-finish-gates.test.ts`       | `loop.product_sight_gate` (warn) + tag `gate:product-sight`                                                 |
| G7  | Open-steps gate                                                                      | `:2970-3022`                                                       | `taskState.hasOpenTodos()`; first time `openStepNudges < 1`                                                                                                                                               | 1st: REFUSE once. 2nd: **allow the finish but overwrite `stopReason = "open_steps"`** (`:3020`)                                    | `openStepNudges` — in-memory; the todo list itself is persisted                                                                                            | lead loop only                                                                                            | `agent-loop-finish-gates.test.ts`, `agent-loop-task-state.test.ts`   | `loop.open_steps_gate` (warn), `loop.open_steps` (warn) + two `logEvent("gate", …)` + tag `gate:open-steps` |
| G8  | Step-ledger refusal (plan ledger)                                                    | `:3907-3935`, verdict from `taskState.setTodos()`                  | a `todo_write` marking a step `completed` whose evidence the ledger refuses (`verdict.refused`, kinds incl. `check_failed`)                                                                               | rewrites the tool result to `success: false` — the completion is discarded                                                         | the ledger lives in `taskState` (persisted); `acceptedPlan` in-memory                                                                                      | lead loop                                                                                                 | `agent-loop-step-ledger.test.ts`, `agent-loop-report-step.test.ts`   | `loop.step_refused` (warn)                                                                                  |
| G9  | Empty-completion **acceptance**                                                      | `:2461-2478`                                                       | `workStands = narratedEarlier                                                                                                                                                                             |                                                                                                                                    | anyWritesThisRun` at the strike limit                                                                                                                      | **lets a run finish with no closing message at all** — the one gate that converts a failure into a `done` | same counters as E4                                                  | all                                                                                                         | `agent-loop-empty-completion.test.ts` | `provider.empty_completion` (warn) |
| G10 | Final compaction                                                                     | `:3024-3052`                                                       | `contextEngine.shouldCompact()` on the way out                                                                                                                                                            | may rewrite `messages` before the finish                                                                                           | context engine state                                                                                                                                       | all                                                                                                       | `agent-loop-usage-compaction.test.ts`                                | `context.budget_overflow` on failure                                                                        |

### 1.4 REDIRECT — nudges, breakers, tripwires, pacing

| #   | Name                           | file:line                                                                                                                         | Trigger                                                                                                                               | Decision                                                                                                                           | State kept                                               | Gears                            | Tests                                                                       | Ledger row                                                       |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| R1  | Wrap-up reserve                | `:1802-1840`                                                                                                                      | `maxTurns >= 20` AND `turn >= ceil(maxTurns*0.85)`, **or** `quotaWallSighted`; AND `taskState.hasOpenTodos()` AND `!turnBudgetNotice` | injects the close-out protocol once per ceiling; re-armed by a second wind (`:1727`)                                               | `wrapUpInjected`, `quotaWallSighted`                     | lead loop only                   | `agent-loop-endurance.test.ts`                                              | `loop.wrapup_reserve` (warn)                                     |
| R2  | Per-turn budget line           | `:1946-1970`                                                                                                                      | `config.turnBudgetNotice`                                                                                                             | tells a sub-agent the turn count every request                                                                                     | none                                                     | sub-agents only                  | `subagent-budget.test.ts`                                                   | —                                                                |
| R3  | Repeated-call circuit breaker  | `:3370-3398`                                                                                                                      | `failedCalls.get(breakerSignature(tool, args)) >= 2`                                                                                  | refuses the call **without running it**; counts as `deterministicallyRefused` → feeds E11                                          | `failedCalls` map — in-memory                            | all                              | `agent-loop-breaker.test.ts`                                                | `loop.repeated_call_refused` (warn)                              |
| R4  | Same-shape breaker             | note at 3 `:4361-4379`; refusal at 5 `:3403-3430`; reset on any success `:4382-4384`                                              | `failureShapeSignature(tool, error)` unchanged across consecutive failures; manufactured refusals excluded (`:4356`)                  | 3 → harness note; 5 → refuse before running (feeds E11). Special-cases `ask_user`: "write the question as prose and END YOUR TURN" | `sameShapeFailure {key, tool, count, noted}` — in-memory | all                              | `agent-loop-breaker.test.ts`                                                | `loop.same_shape_failures`, `loop.same_shape_refused` (warn)     |
| R5  | ask_user option salvage        | `ask-user.ts:85-135`                                                                                                              | malformed `options` on an `ask_user` call                                                                                             | salvages rather than rejects — the orbit fix (9 rewordings / 7 minutes, 2026-08-31)                                                | none                                                     | all                              | `ask-user` tests                                                            | —                                                                |
| R6  | Plan tripwire                  | `:4204-4226`                                                                                                                      | a successful write/worker call with `!taskState.hasOpenTodos()` and (`filesWrittenCount() >= 2` or `toolCallsThisRun >= 6`), once     | prefixes a note to that call's own result                                                                                          | `planNudges`                                             | lead loop                        | `agent-loop-task-state.test.ts`                                             | `loop.plan_nudge` (warn)                                         |
| R7  | Greenfield-clarify tripwire    | `:4271-4295`, predicate `:4244-4252`                                                                                              | first successful write creates a new top-level dir AND `clarificationCount() === 0` AND `ask_user` is registered                      | prefixes a clarify-first note                                                                                                      | `greenfieldNudges`                                       | not 4th gear (ask_user withheld) | `agent-loop-greenfield.test.ts`                                             | `loop.greenfield_nudge` (warn)                                   |
| R8  | Art-direction tripwire         | first write `:4253-4268`; plan time `:3872-3890`                                                                                  | a visual file written (or a visual-looking plan) with `clarificationCount() === 0`, once per run via a shared counter                 | prefixes the art-direction question                                                                                                | `artDirectionNudges`                                     | needs `ask_user`                 | `agent-loop-art-direction.test.ts`, `agent-loop-plan-art-direction.test.ts` | `loop.art_direction_nudge` (warn)                                |
| R9  | JIT doctrine                   | `:4304-4340`, config `:167-174`                                                                                                   | first sub-agent report / first interface write / first dashboard write                                                                | prefixes the doctrine section to that tool result, once per session                                                                | the engine's once-per-session set                        | `[context] doctrine = jit`       | `agent-loop-jit-doctrine.test.ts`                                           | —                                                                |
| R10 | Struggle nudges                | `struggle-detector.ts:62-95` (signals), drained `agent-loop.ts:1356-1362`                                                         | same file edited 4×, same search 3×, per run per key                                                                                  | injects a harness note; sets `replanReason` → a `replanning` event                                                                 | per-run maps in the detector — in-memory                 | lead loop                        | `struggle-detector.test.ts`                                                 | `struggle.thrash_edits`, `struggle.thrash_search`                |
| R11 | Rate-limit wait                | `:2141-2172`                                                                                                                      | `retryable === false` AND `rateLimitWaitSecs(error)` parses AND `rateWaits < maxRateWaits` (default 2)                                | sleeps the window, sets `quotaWallSighted = true` (which arms R1 and vetoes X2), retries                                           | `rateWaits`, `quotaWallSighted` — in-memory              | all                              | `agent-loop-quota-stop.test.ts`                                             | `provider.rate_limit_wait` (warn)                                |
| R12 | Overflow compaction            | `:2220-2262`                                                                                                                      | the provider rejects the prompt as over-limit AND `overflowCompactions < maxOverflowCompactions` (default 2)                          | force-compacts and retries                                                                                                         | `overflowCompactions`                                    | all                              | `context-compaction-budget.test.ts`                                         | `context.budget_overflow`                                        |
| R13 | Misencoded-call retry          | `:2365-2380`                                                                                                                      | `misencoded && misencodedCalls < 2`                                                                                                   | re-issues the tool call                                                                                                            | `misencodedCalls`                                        | all                              | `agent-loop-malformed-call.test.ts`                                         | —                                                                |
| R14 | Effort latch                   | `latchEffort(...)` called from G1–G7, R4, G8, E3                                                                                  | `effortRouting === "conservative"` and any sign of difficulty                                                                         | raises reasoning effort to the ceiling for the rest of the run                                                                     | latch flag — in-memory                                   | lead loop (engine default)       | `agent-loop-effort-routing.test.ts`                                         | —                                                                |
| R15 | Citation carry-forward         | `:4478-4502`                                                                                                                      | a batch that is only `record_evidence` and every call succeeded, citing a check run in the previous completion                        | refunds the turn via X1                                                                                                            | `citationsCarriedForward`                                | all                              | `agent-loop-citation-carry-forward.test.ts`                                 | `loop.citation_carried_forward` (debug) + `logEvent("check", …)` |
| R16 | Auto containment               | `auto-containment.ts:52` (`"extend" \| "contain" \| "redirect" \| "defer" \| "halt"`), deferral `:916`, no-isolation defer `:651` | the classifier/containment verdict on a tool call                                                                                     | rewrites the action (dry run), defers it to a held step, or halts (→ E3)                                                           | `AutoMode.deferrals` (`auto-mode.ts:1113`) — in-memory   | Auto only                        | `auto-containment.test.ts`, `auto-mode.test.ts`                             | auto-mode decision rows; `auto-metrics.ts:181` counts held steps |
| R17 | Sub-agent cost/deadline budget | `subagent-budget.ts:25-45`                                                                                                        | list-price spend or wall clock past the effort preset (`quick` $0.50/3 min, `standard` $2/10 min, `thorough` $6/25 min)               | ends the child's loop and **returns what it has** — a stop, not a failure                                                          | per-child, in-memory                                     | sub-agents only                  | `subagent-budget.test.ts`                                                   | —                                                                |
| R18 | Delegated turn ceiling         | `delegated-sessions.ts:476-485`                                                                                                   | a resumed child at a tool boundary with `budget.turnsUsed`                                                                            | narrows the child's ceiling by what it already spent                                                                               | reads the child's persisted checkpoint                   | sub-agents only                  | `subagent-budget.test.ts`                                                   | —                                                                |

### 1.5 Engine-side guards (`engine.ts`)

| #   | Name                           | file:line                                                                                        | Trigger                                                                                                                         | Decision                                                                                                                                                                                                                                                          | State kept                                                                                                                  | Gears               | Tests                                                                    | Ledger row                                                                                    |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| N1  | Session spend cap              | config `engine.ts:851`; enforced `:6352-6368`; latch `:1357`; teardown `:5821`, `:6078-6091`     | `maxSessionCostUsd > 0 && tracker.getLedger().totalListCostUsd >= cap`, session attributed via `AsyncLocalStorage` (`:6354`)    | latches `costCapTripped`, calls `this.currentAbort?.abort()` — **the engine, not the loop, ends the run**; `runError` set at `:5821`, `endRun("turn_failed")` `:6043`                                                                                             | `costCapTripped` in-memory; the cap itself rehydrates from `cost` events `:6274-6328`; reservations (`:6661`) are in-memory | all                 | `eval-cost-gate.test.ts`, `cost-report*.test.ts`                         | `cost` event `:6347-6350`; error + `run_trace` `:6078-6091`                                   |
| N2  | Request reservation            | `:6367` `tracker.reserveRequest(request, cap)`                                                   | projected cost of the _next_ request crosses the cap                                                                            | refuses the request before it is sent                                                                                                                                                                                                                             | reservation map — in-memory                                                                                                 | all                 | `cost-report-economics.test.ts`                                          | —                                                                                             |
| N3  | Tool pacer                     | `:2106-2109` (constructed, **on by default**), `:3066-3092` (first gate in the permission check) | `resolveRateLimit(...)` over per-minute windows; read-category tools exempt                                                     | `wait` → `abortableSleep(pace.waitMs)` **invisibly** (the model never sees it); `refuse` only when the wait would exceed `maxWaitMs`                                                                                                                              | `ToolRateLimiter` windows `:1358` — in-memory, a restart allows a fresh burst                                               | all                 | not found for the engine wiring; `tool-registry/rate-limiter` unit tests | `tool.rate_paced` (debug, `:3079`)                                                            |
| N4  | Reliability policy resolution  | `:4994` `policyForModel(session.model, config.reliability)`; into the loop `:5278-5288`          | per run                                                                                                                         | sets `maxTurns` (default **80**), `secondWinds` (default **2**), `maxConsecutiveErrors` (3; **4** for budget-family models), `maxStuckNudges`, `maxRateWaits`, `maxOverflowCompactions`, `maxEmptyCompletionRetries`, `maxTruncationRetries`, `maxVerifyAttempts` | resolved fresh per run from config                                                                                          | all (identical)     | `reliability-policy` tests                                               | —                                                                                             |
| N5  | Conversational narrowing       | `:4996`, consumed `:5056`, `:5240`, `:5246`, `:5336`, `:5427`                                    | `turnBudgetForMessage`                                                                                                          | 8-turn ceiling, **`maxSecondWinds: 0`**, repo map skipped, intent classifier denied a model call                                                                                                                                                                  | none                                                                                                                        | all                 | `turn-budget.test.ts`                                                    | —                                                                                             |
| N6  | Crash inheritance              | `:4807` (`previousRunWasInterrupted`), `:5006-5011` (`applyInheritance`)                         | last `checkpoint` was `session_started` with no `session_ended` AND the last lifecycle row is not `end_turn` AND had open todos | narrows turns and winds; **never extends**                                                                                                                                                                                                                        | reads persisted events                                                                                                      | all                 | `engine-lifecycle-restart.test.ts`, `lifecycle-durability.test.ts`       | `notice` at `:5036`                                                                           |
| N7  | Terminal status reconciliation | `:5883-5888`                                                                                     | `liveStatus === "running"` at teardown (i.e. no `turn_complete` arrived)                                                        | `aborted` / **`provider_lost`** / `end_turn`; then `end_turn` + open todos → `open_steps`                                                                                                                                                                         | `liveStatus` `:1330`                                                                                                        | all                 | `engine-lifecycle-projection.test.ts`                                    | terminal `lifecycle` row `:5891-5898`, then `checkpoint "session_ended"` `:5903-5906`         |
| N8  | Spine safety net               | `:5853-5861`                                                                                     | `(runError \|\| signal.aborted) && hasOpenTodos() && !handoff`                                                                  | writes a handoff so a hard throw still records where work stood                                                                                                                                                                                                   | —                                                                                                                           | all                 | `lifecycle-durability.test.ts`                                           | `task_state`                                                                                  |
| N9  | Auto halt latch                | latch `:3196-3207`; served `:3147-3159`; released `:6214-6217`                                   | reviewer verdict `deny` with `haltRun`                                                                                          | every non-exempt tool returns `allowed:false` **plus `halt:{reason}}`** — the channel E3 reads; halt-exempt tools (`todo_write` etc.) still run; **nothing is re-reviewed**                                                                                       | `autoHalt` `:1385` — **in-memory; a restart forgets an active halt**                                                        | Auto only (`:3135`) | `engine-halt-to-loop.test.ts`, `auto-mode.test.ts`                       | `safety_decision` `:3399+`                                                                    |
| N10 | Late supervisor halt           | `:6154-6210`                                                                                     | `takePendingSupervisorHalt()` after the run's `finally`                                                                         | too late to stop anything: bumps `sessionInjectionFindings` (**sticky across runs**, `:6168-6171`), writes the row, and queues a next-turn harness note `:6200-6204`                                                                                              | `sessionInjectionFindings` `:1387`, `pendingTurnNotes` `:1288` — **both in-memory and silently dropped on restart**         | Auto                | `auto-mode-recording.test.ts`                                            | `loop.auto_halt` (error, `context:{late:true}`), `safety_decision` `source:"supervisor_late"` |
| N11 | Injection screen               | `:3474-3494` (`processToolResult`)                                                               | `autoModeSafety.screenToolResult(...)` adds a warning                                                                           | raises the scrutiny floor for the rest of the session; fed back at `:3055-3057`                                                                                                                                                                                   | `sessionInjectionFindings` — in-memory                                                                                      | Auto                | `auto-mode.test.ts`                                                      | —                                                                                             |
| N12 | Deferrals → held steps         | `:6093-6153`                                                                                     | `activeAutoRun.getDeferrals()` at run end                                                                                       | durable `auto_deferrals` row first, then one `held_step` pending decision each; with no approver, a harness note listing up to 6                                                                                                                                  | `AutoMode.deferrals` (`auto-mode.ts:1113`) — in-memory until the row is written                                             | Auto                | `auto-metrics.test.ts`                                                   | `auto_deferrals` `:6104-6116`, `held_step_outcome` `:3345-3358`                               |
| N13 | Held-step false positive       | `:3364`                                                                                          | a held step the user approved then **ran unchanged**                                                                            | measurement only                                                                                                                                                                                                                                                  | —                                                                                                                           | Auto                | `auto-metrics.test.ts`                                                   | `auto.supervisor_false_positive` (warn)                                                       |
| N14 | Gear demotion                  | `:1945-1949`                                                                                     | mode is `auto` but Auto config is disabled                                                                                      | demotes to `gear-1`, clears `trustWorkspace`                                                                                                                                                                                                                      | —                                                                                                                           | Auto                | `auto-mode.test.ts`                                                      | —                                                                                             |
| N15 | Reviewer fallback              | `:2009-2022` `pickFallbackReviewer`                                                              | the primary reviewer call fails                                                                                                 | decorrelated fallback across `heavy`/`standard`; never widens when policy pinned the classifier; `null` → mechanical containment backstops                                                                                                                        | provider health                                                                                                             | Auto                | `auto-mode-reviewer-recall.test.ts`                                      | `provider.*` incident tap `:6978-7020`                                                        |
| N16 | Delegation pool                | `:1349-1351`, `:6793-6796`; config `:1091-1099`                                                  | `subagents.maxParallel` (default 8, clamped 1–16)                                                                               | queues `task`/`worker` dispatches                                                                                                                                                                                                                                 | pool — in-memory                                                                                                            | all                 | `delegation-pool` tests                                                  | —                                                                                             |
| N17 | Schema-violation scrub         | `:3467`                                                                                          | a sub-agent's structured result fails its `outputSchema`                                                                        | **deletes `ctx.output.structured`** and never fails the call — the child's evidence silently becomes prose                                                                                                                                                        | —                                                                                                                           | all                 | not found                                                                | `loop.schema_violation` (warn)                                                                |
| N18 | Lifecycle throttle             | `:371` (`LIFECYCLE_BUDGET_THROTTLE_MS = 20_000`), `:6672-6678`                                   | unprompted `budget` rows                                                                                                        | at most one per 20s and only when `lifecycleDigest` changed; named moments never throttled                                                                                                                                                                        | `lastLifecycleDigest`                                                                                                       | all                 | `engine-lifecycle-projection.test.ts`                                    | `run_trace`                                                                                   |

Two engine facts that matter to Phase 5B/5C more than their size suggests:

- **`ask_user` has no roundtrip cap anywhere** (`engine.ts:1631-1668`). There is
  no counter, no budget, no "orbit breaker" of its own. The only thing that
  stops an asking orbit is R4, the _generic_ same-shape breaker, which
  special-cases `ask_user` in its refusal text (`agent-loop.ts:3427-3429`,
  `:4374-4377`) — and R4 only fires on repeated _failures_, so an orbit of
  well-formed, successfully answered, semantically identical questions is
  bounded by nothing but `maxTurns`. The 2026-08-31 incident (9 rewordings in
  7 minutes) was fixed on the _input_ side (`ask-user.ts:92`, salvage) and on
  the failure side (R4); the "asks the same thing nine different ways and each
  one succeeds" path is still open. The same is true of `read_back` (`r`),
  permission (`p`) and held-step (`h`) roundtrips: same inbox, all uncapped.
- **`pendingTurnNotes` (`engine.ts:1288`) has no durable backing.** Held-step
  outcomes, dismissals and the late-supervisor verdict are queued for "the next
  turn" in memory. A restart between runs drops them silently, which means a
  confirmed safety finding can vanish without a row.

### 1.6 The count

| Where                                                                                                                                                                                     | Named guards                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `agent-loop.ts`                                                                                                                                                                           | **24** (E1–E13 collapse to 13 exits over 11 distinct guards, plus X1–X3, G1–G10, R1–R15 minus the shared ones) |
| helpers called by the loop (`turn-refunds`, `turn-budget`, `struggle-detector`, `ask-user`, `subagent-budget`, `delegated-sessions`, `step-evidence`, `brief`, `task-state`, `lifecycle`) | **10**                                                                                                         |
| `engine.ts`                                                                                                                                                                               | **18** (N1–N18)                                                                                                |
| `auto-mode.ts` / `auto-containment.ts`                                                                                                                                                    | **4** (containment kinds, halt, deferral, reviewer fallback)                                                   |
| **Total**                                                                                                                                                                                 | **≈56 decision sites, 38 of them named guards with their own counter and incident class**                      |

The audit's "roughly ten" is the count of guards a reader _notices_. The real
figure is between three and four times that, and the gap is entirely made of
guards that were added one incident at a time — every one of them carries a
comment naming the run it was born from.

---

## Deliverable 2 — the fights

### F1. The finish-gate stack is arbitrated by source order, nothing else

`agent-loop.ts:2576-3071` is one straight-line sequence. Each gate is
`<counter> < 1`. Nothing compares severity, nothing takes precedence, and the
order is an accident of the order the gates were written in.

The sequence, with what it costs:

```
:2578  pending interjection      -> continue      (cancels the finish entirely)
:2585  G1 verification           -> continue x3   (each runs the project checks)
:2651  G2 replan nudge           -> continue x1   (resets G1's budget to 0)
:2696  G3 delegation evidence    -> continue x1
:2770  G4 execution evidence     -> continue x1
:2847  G5 fix-verified           -> continue x1
:2903  G6 product sight          -> continue x1
:2970  G7 open steps             -> continue x1, then rewrites stopReason
:3024  G10 compaction
:3053  pending interjection again
:3068  END
```

**The worst case is twelve consecutive refused finishes**: 3 verification
rounds (G1, `maxVerifyAttempts` 3) + 1 replan (G2) + 3 more verification rounds
(G2 sets `verifyAttempts = 0` at `:2658`) + 5 one-shot gates (G3–G7). Each
costs one completion; each is refunded at most once per turn and only up to
`ceil(baseMaxTurns * 0.25)` (`turn-refunds.ts:63`). At the default 80-turn
ceiling the refund cap is 20, so the stack cannot exhaust the budget on its own;
at the 8-turn conversational ceiling the cap is 2, and **the gate stack alone
can consume a conversational run**. `agent-loop-finish-gates.test.ts:9-10` states
the intent — "a gate must never become a kill chain" — but no test drives more
than two gates in one run, so the twelve-completion path is unmeasured.

Worse, the gates are ordered so that the _cheapest and most mechanical_ runs
first and the _most meaningful_ runs last. G4 (execution evidence: "did anything
run?") precedes G5 (fix-verified: "did you prove the defect is gone?"). A model
that satisfies G4 by running any command at all reaches G5 one completion later
and is refused again for a different reason. Two separate refusals, two
completions, one underlying failure: the run has no evidence.

### F2. Refund vs empty-completion — the refund cannot see the one completion that matters

The refund funnel is inside `report()` (`agent-loop.ts:1108-1136`), so a refund
fires for any `REFUNDABLE_INCIDENTS` class. `provider.empty_completion`
(`:2416`) is **not** in that set (`turn-refunds.ts:28-51`). That is correct on
its face — an empty completion is the provider's failure, not the harness's.

But the interaction is wrong at the margin. Sequence, all at the ceiling:

1. `:2810` G4 refuses the finish → `loop.evidence_gate` → refund → `maxTurns += 1`, `lastRefundedTurn = turn`.
2. The model, re-prompted, returns an empty completion (`:2415`). `emptyCompletions = 1`. **No refund** — and `lastRefundedTurn === turn` would have blocked one anyway (`turn-refunds.ts:78`).
3. `:2431` nudges. The model returns text. `:2482` `emptyCompletions = 0`.
4. Next turn, G5 refuses → refund → `maxTurns += 1`.

The run paid three completions for two gate refusals and kept two turns. That
is the intended shape.

The real asymmetry is one scope down. **Every finish gate's counter is declared
outside the `while` loop** — `executionNudges` at `:1467`, `fixVerifiedNudges`
at `:1485`, `productSightNudges`, `delegationNudges`, `openStepNudges` at
`:1702` — so each is one-shot _per run_, not per finish attempt. Meanwhile the
state they read (`settledPlanAtWriteCount + settledPlanExcusedWrites ===
writeCount`, `:2788-2794`) is re-armed on every write that changes a file
(`:2624`, `:3949`). So the evidence condition can go false again and again
while the gate that answers it can only fire once. **A run that spends G4 at
turn 10 can write forty more files with nothing executed and finish at turn 70
unchallenged.** `agent-loop-write-excuse.test.ts:216-328` pins seven cases of
the condition re-arming; none of them spends the counter first. This is the
strongest single argument for the completion verdict being computed from state
rather than counted down: a verdict cannot be spent.

### F3. Second wind vs the turn ceiling vs the wrap-up reserve

Three guards read the same number, `this.config.maxTurns`, and two of them
**mutate it**.

- X1 (refunds) does `this.config.maxTurns += 1` inside `report()` (`:1111`) — i.e. from an observability callback, at arbitrary points inside a turn.
- X2 (second wind) does `this.config.maxTurns += baseMaxTurns` (`:1728`) from inside the `while` condition.
- R1 (wrap-up reserve) computes `turn >= ceil(this.config.maxTurns * 0.85)` (`:1802`) against whatever the number currently is.

So a refund granted at turn 68 of 80 moves the ceiling to 81 and moves the
wrap-up trigger from 68 to 69 — the reserve **un-fires**, having already fired
(`wrapUpInjected` is latched `true` at `:1808`, so it does not re-fire; the
protocol was injected once and the budget then grew by an amount the protocol's
text names wrongly). The harness note the model is reading says "turn 68 of 80"
while the real ceiling is 81+.

And X2 explicitly re-arms R1 (`wrapUpInjected = false`, `:1727`) while
**skipping** the refund bookkeeping, so a second wind at the ceiling resets a
reserve whose threshold has already been moved by up to 20 refunds.

The comment at `:143-152` records the previous version of this fight: a struggle
nudge used to veto the second wind, and "the wind never fired in a month of runs,
because the runs that reach the ceiling are precisely the ones the harness has
been nudging — the gates that eat the budget also set the flag that refused to
extend it." That was fixed by deleting the veto. The mutation-of-a-shared-number
problem underneath it was not.

### F4. The loop detector vs a legitimate verify loop

The detector (`:3095-3109`) requires three things to call a repeat a rut: the
same `batchSignature`, the same `writeCount`, **and** the same `resultSig` on the
prior two tries. Both extra conditions were added after incidents
(`:3082-3094`): the write count tells `build → read failure → fix → re-run`
from a wall, and the result signature tells a poll (`bash_output`, `tail`) from
a rut.

What is still open: **a verify loop where the fix does not change any file.**
Re-running `bun test` after changing an environment variable, after a
`git checkout`, after an `npm install`, or after a sub-agent wrote the file
(the parent's `writeCount` does not move for a child's writes — `writeCount++`
is at `:4387`, inside the parent's own `p.isWrite` branch) produces identical
signature, identical write count, and — if the underlying failure is
unchanged — an identical result. Three of those and the run is nudged; the
fourth ends it with `loop.infinite_loop` and **no `turn_complete`**, which N7
then records as `provider_lost`.

That is exactly the three-kill-chain shape: a deterministic refusal repeated
until a generic detector notices, then a kill attributed to the provider.

### F5. Zero-verified-criteria (G5) vs the evidence gate (G4) vs open steps (G7) — three gates, one silence

All three can be armed simultaneously on the same finishing completion, and the
order decides which one the user is told about:

```
G4 fires  -> "nothing ran after the last write"           (executionNudges = 1)
   model runs one command
G5 fires  -> "no criterion reached verified"              (fixVerifiedNudges = 1)
   model writes a check, cites it, the ledger refuses it
G7 fires  -> "3 of 7 planned steps still open"            (openStepNudges = 1)
   model rewrites the plan to cut 3 steps
END: stopReason = "end_turn", ok: true, exit 0
```

Four completions, three different reasons, and the run ends reporting success
with zero verified criteria and three steps cut. Each gate did exactly what it
was written to do. Nothing anywhere asks the question the user has: _was the
thing I asked for done?_

G7 is the only gate that leaves a mark — `stopReason = "open_steps"` at `:3020`,
added precisely because `rune -P --json` used to report `ok: true` and exit 0
for a run that abandoned half its plan (`:3028-3031`). G4, G5 and G6 leave no
terminal mark at all: a run that was refused by all three and then finished
reports `end_turn`.

### F6. Supervisor halt vs everything

E3 is the only guard with real precedence, and it is implemented by _deleting
the competition_ rather than by ranking it. When `haltNotice` is set
(`:4689`), the loop:

- skips verification, every evidence gate, and the replan nudge — `:4683-4688` says why: "all three exist to push the agent back into tool use, which is precisely what a halted run must not do";
- strips the toolbelt (`:1879` `const tools = haltReportPending ? [] : advertised`);
- grants one turn past the ceiling (`:1746`, `:1794`);
- ends at `:2497-2508` on whatever text came back.

This is the right behaviour and the wrong mechanism: it is four special cases
scattered across 2,800 lines, each of which has to remember that a halt is
pending. A fifth gate added next month will not remember. The `haltReportPending`
flag is read at `:1746`, `:1794`, `:1868`, `:1879`, `:2365`, `:2407`, `:2497` —
seven sites, no type, no state machine.

Note also the collision at `:1746`: the halt report turn and the second wind are
**both** in the `while` condition, `||`-ed. A halt arriving exactly at the
ceiling evaluates `secondWind()` first only if `haltReportPending` is false; if
true, the wind is never evaluated — which is correct, but by luck of operand
order, not by design.

### F7. The known incidents, mapped to the guards that produced them

| Incident                                                                                     | Guards involved                                      | Mechanism                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The three-kill chain** (evolab3, 3 runs killed by the loop detector after false npm halts) | N9 (no `halt` channel then) + E9                     | A latched refusal returned as an _ordinary_ denial. The loop served turn after turn, each answered with the identical sentence, until E9's generic signature match noticed. Fixed by adding `PermissionCheckResult.halt` — the comment at `agent-loop.ts:87-92` is the post-mortem verbatim: "That cost 30 turns and three killed runs in one EvoLab build before this existed." |
| **The 80-turn ceiling collapsing the plan** (evolab7)                                        | E1 + X2 (then vetoed by R10)                         | A whole-product brief hit 80 turns with four of five steps closed by evidence and handed off; a person had to type "continue". The wind existed and never fired because a struggle nudge vetoed it — `agent-loop.ts:143-152`. Fixed by making progress the only criterion.                                                                                                       |
| **11 completions past apparent completion**                                                  | F1, the whole gate stack                             | Each gate refuses once; nothing counts how many have refused this finish, and nothing reports the total to the user as one number.                                                                                                                                                                                                                                               |
| **Empty completion accepted as done**                                                        | G9 (`:2461-2478`)                                    | `workStands = narratedEarlier \|\| anyWritesThisRun`. A run that wrote a file and never spoke again finishes on the writes. Deliberate (gpt-oss:120b, 2026-09-10, edited the parser and passed acceptance in 31s) — but it is a gate that turns a provider failure into a `done` with no contract check anywhere.                                                                |
| **The compaction cliff** (evolab2)                                                           | R12 + G10                                            | `maxOverflowCompactions` (2) then E6.                                                                                                                                                                                                                                                                                                                                            |
| **Loop detector kills verify loops** (evolab2)                                               | E9                                                   | Fixed twice: `writeCount` (`:3082-3089`) then `resultSig` (`:3090-3094`). See F4 for what remains.                                                                                                                                                                                                                                                                               |
| **Classifier fails closed** (evolab2)                                                        | N9 / auto-mode `failClosed` (`auto-mode.ts:349-365`) | A classifier outage denies everything; `failClosed = false` requires signed org policy. It is a counter-and-flag, not a state.                                                                                                                                                                                                                                                   |
| **Quota deaths + the resume cap stranding a night** (evolab4, evolab6)                       | R11 + E6 + N6                                        | `maxRateWaits` is 2. Past that, a 429 with a known reset time becomes E6 — an `error` with no `turn_complete`. N6 then narrows the _next_ run's budget by what the dead run spent, which is why a resumed overnight run ran out early.                                                                                                                                           |
| **Sweet-shop: verifier graded sibling projects**                                             | G1                                                   | Fixed by scoping to `taskState.writtenFiles` (`:2592-2594`); the comment names it.                                                                                                                                                                                                                                                                                               |
| **Sweet-shop: truncated calls became safety incidents**                                      | E8 + N9                                              | `parseToolArguments` degrades partial blobs to `{}`; a write/bash with garbage args reached the broker. Fixed at `:2531-2539` by answering truncated calls with an error instead of executing them.                                                                                                                                                                              |

### F8. Where those incidents are actually written down

Worth recording for the lanes that follow: **the evolab post-mortems are not in
`docs/`.** `grep -rn evolab docs/` returns two hits
(`docs/program/07-evolution.md:16`, `docs/program/capability-cap-program.md:82`).
Every other evolab incident survives only as a source or test-header comment.
The guard inventory is therefore also the first place several of these are
written down as guard behaviour rather than as folklore.

| Incident                        | Where it is recorded                                                                                                                                                                                                                                                                                                                                                                 | Where it is _not_                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Three-kill chain                | `CHANGELOG.md:415`; the post-mortem itself at `agent-loop.ts:87-92`; the false npm halts at `docs/auto-mode.md:514` and `docs/program/06-trust.md:22`                                                                                                                                                                                                                                | no file under `docs/` names it or records the three terminations                               |
| 80-turn ceiling                 | `docs/program/capability-cap-program.md:12-13` ("Runs ended at the 80-turn ceiling unfinished \| **9** (three on 09-03 alone)"; "Second wind fired \| **0 times ever**") and `:41-45` (the turn-2 nudge chain: art-direction, barren, two step refusals, replan, wrap-up at 68, product-sight refusal, ceiling at 80, **4 of 4 steps open**); evolab7 at `agent-loop.ts:137-139`     | —                                                                                              |
| Fix-shape misfire               | `agent-loop.ts:436-438`: a 40,000-character product brief said "fix defects before new features" somewhere in it, so **evolab7's whole build was gated as a fix** — a refused finish over a test-runner config step, four completions of busywork. Pinned by `agent-loop-finish-gates.test.ts:224`                                                                                   | —                                                                                              |
| 11 completions past completion  | `docs/program/backlog.md:367-369`, `docs/evidence/pilot-j-trace-20260910.md:37` ("Seventeen tool calls across eleven completions. The work was done by completion 6")                                                                                                                                                                                                                | the transcript never said **which** guard re-prompted — `backlog.md:369` asks for exactly that |
| Empty completion accepted       | `docs/program/backlog.md:370` (session `01a086b4`, ninth completion: zero input and zero output tokens ended the turn as `finished`)                                                                                                                                                                                                                                                 | —                                                                                              |
| Compaction cliff                | `tests/unit/orchestrator/context-tiered-compaction.test.ts:4-11` — a 640-minute run, six auto-compactions, "the worst folding 212 messages from 155,130 tokens down to 834 — **0.54% of the budget**"                                                                                                                                                                                | not in `docs/`                                                                                 |
| Loop detector vs verify loop    | `tests/unit/orchestrator/agent-loop-verify-cycle.test.ts:4-11` — evolab2, "the run was killed immediately after a SUCCESSFUL TypeScript fix"; under-fire side at `backlog.md:368` (five identical "Unknown tool" results not treated as a loop)                                                                                                                                      | not in `docs/` as a run                                                                        |
| Classifier fails closed         | `docs/auto-mode.md:146` and `auto-containment.ts:44-46` — "cost one build **22 minutes** sitting on a dead classifier"                                                                                                                                                                                                                                                               | —                                                                                              |
| Quota deaths                    | `guarantees-program-20260914.md:78-79` ("three long runs died exactly here"); evolab4 at `agent-loop-run-economics.test.ts:2-4` (101 requests, quota death at hour four with verification still "none"); evolab6 at `agent-loop.ts:1519-1522` (429 at turn 64 of 80 with **every finish-time gate unreached**); scale at `capability-cap-program.md:19` (1,022 rate-limit incidents) | —                                                                                              |
| Resume cap stranding a night    | `bin/ui/tui.ts:3083-3102` (counter `:3083`, cap `:3089`) — `if (this.quotaResumeAttempts >= 8) … "giving up on auto-resume after 8 tries."`                                                                                                                                                                                                                                          | **no doc, and no test** — `grep -rn "quotaResume\|auto-resume" tests/` is empty                |
| Sweet-shop verifier scope       | `verifier.ts:129-131` and `tests/unit/orchestrator/verifier-run-scope.test.ts:4-13` — "then spent roughly **fifty completions and eight minutes** trying to fix code it had never opened"                                                                                                                                                                                            | `docs/` has only the nudge chain                                                               |
| Sweet-shop truncated calls      | `agent-loop.ts:448-463` — two `write_file {}` calls "were reviewed as ordinary writes, cost 9.6 s and 10.6 s of reasoned safety review … and became held steps the model then re-narrated in roughly forty later messages. **None of that protected anything.**"                                                                                                                     | —                                                                                              |
| Tool pacer eating its own reads | `capability-cap-program.md:15`, `:67-70` — the engine's rate limiter refused **29 of its own reads** on 09-03, each refusal costing a completion against the ceiling                                                                                                                                                                                                                 | —                                                                                              |
| Endings nothing reads           | `docs/program/07-evolution.md:19` — the tune rules key on `unproven`/`stalled`/`open_steps`, which had **zero occurrences in 601 sessions**, while the real endings (`aborted` 71, `error` 64, `max_turns` 16, `halted` 9) are read by no rule                                                                                                                                       | —                                                                                              |

Two guards surfaced by this pass that are not in the loop or the engine at all:

- **Quota auto-resume cap** — `bin/ui/tui.ts:3083-3102` (counter `:3083`, cap `:3089`). A run killed by a quota
  wall is auto-resumed by the TUI up to 8 times, then abandoned. It is a
  termination guard living in the presentation layer, with no ledger row and no
  test. Phase 6's Keel is the right home; until then it belongs on this list.
- **`headlessExitCode` conflation** — `backlog.md:411-414`: a failed run and a
  cancelled run both exit 1, and only `stopReason` in the envelope separates
  them. `tests/unit/orchestrator/headless.test.ts:161` pins the current
  conflated behaviour, so the completion verdict has to be added _beside_ that
  assertion, not in place of it.

**The backlog already contains half of this document.** `backlog.md:415-418`
records `providerLostEnd` returning without a `turn_complete` — that one was
fixed (`agent-loop.ts:1391-1395` now emits it last, with a comment explaining
why the order matters). The same defect is still live on four other paths (E6,
E7, E9, E11). The fix was applied to the instance, not the class, which is the
single most compact statement of why Phase 5 exists.

---

## Deliverable 3 — the two seams for the TaskContract lane

### 3a. INTAKE — what exists today

**There is no harness intake.** A request becomes a brief only if the _model_
decides to call `read_back` on its opening turn. Nothing deterministic runs
between "the user pressed enter" and "the model's first completion" except the
turn-budget classifier (`turn-budget.ts:57`, purely mechanical, no model call)
and crash inheritance (`engine.ts:5006`).

| Question             | Answer                                                                                                                                                                                                                                     | file:line                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| What object          | `Brief { reading, touch[], leave[], criteria[], request, createdAt }`                                                                                                                                                                      | `protocol/roundtrips.ts:120-135`                                                   |
| Criterion            | `{ text, rung: ClaimRung \| null, evidence?: Evidence }`                                                                                                                                                                                   | `roundtrips.ts:112-118`                                                            |
| Evidence             | `{ source, detail?, parentCommitFailed?, parentCommit?, head?, dirty?, digest?, staleAt? }` — "Every field is something the RUNTIME saw … None of it is model prose"                                                                       | `roundtrips.ts:67-110`                                                             |
| Rungs                | `ClaimRung = "suspected" \| "observed" \| "reproduced" \| "verified"`                                                                                                                                                                      | `roundtrips.ts:63`                                                                 |
| When                 | inside the model's first completion, as a tool call                                                                                                                                                                                        | `brief.ts:339` (`briefFromArgs`)                                                   |
| Who writes criteria  | **the MODEL**, as free strings; `done_when: string[]`, 1–6 items, `required`                                                                                                                                                               | schema `brief.ts:234`, `:266-281`; construction `brief.ts:228`                     |
| Who writes rungs     | **only the harness**, and only from its own `CheckLog`                                                                                                                                                                                     | `BriefLedger.record` `brief.ts:156-198`; sole caller `brief.ts:781`                |
| Persisted            | one latest-wins `{ type: "brief", payload: { version: 1, brief } }` row in `~/.rune/rune.db`'s `events` table                                                                                                                              | write `engine.ts:6578`; call sites `:1703`, `:5901`, `:6625`; restore `:6594-6626` |
| User sees            | a 3–4 row scrollback block + an `ask_user`-shaped picker ("go / edit / ask me something first")                                                                                                                                            | `bin/ui/read-back.ts:39-59`; `bin/ui/tui.ts:2517-2540`                             |
| Skippable            | **four ways**: the model never calls it (`prompts.ts:109,115`); headless records but cannot confirm (`brief.ts:346-355`); unattended auto-accepts (`roundtrips.ts:240`, `host-roundtrips.ts:136`); ACP auto-accepts (`acp-cli.ts:436-454`) |                                                                                    |
| Rejection            | returns a tool result telling the model to read back again. **Not a gate** — "Do not start work on a brief they did not accept" is doctrine prose only                                                                                     | `brief.ts:363-367`, `prompts.ts:114`                                               |
| Dropped after turn 1 | the whole `# The read-back` doctrine section is `keep: c.phase !== "working"`                                                                                                                                                              | `prompts.ts:352`, selected `agent-loop.ts:1888-1891`                               |

**Two mismatches the TaskContract lane must resolve before it writes code:**

1. **The program doc's rung ladder does not exist.** Phase 5B specifies
   `stated → observed → verified → refuted`. The shipped ladder is
   `suspected → observed → reproduced → verified` (`roundtrips.ts:63`,
   `brief.ts:48` `CLAIM_RUNGS`). `refuted` is a _hypothesis_ status
   (`protocol/task.ts:145`: `proposed → testing → refuted | confirmed`), on the
   narrative spine, with its own evidence type (`EvidenceRef`, `task.ts:130`)
   that never interconverts with `Evidence` (`roundtrips.ts:71`). Adding
   `refuted` to `ClaimRung` is a protocol change that touches `RUNG_GLYPH`
   (`brief.ts:56`), `RUNG_MEANING` (`:64`), `demoteStaleCriteria`'s index
   arithmetic (`lifecycle.ts:252, :261`) and the close renderer
   (`read-back.ts:63-77`). **Recommendation: keep the shipped four-rung ladder
   and add `refuted` as a separate terminal flag on `Criterion`, not a rung** —
   a refuted criterion is not "less verified", it is decided the other way, and
   the demotion arithmetic assumes a total order.

2. **`verified` is unreachable outside a git repository** (`brief.ts:659-662`,
   `parent-check.ts:111`), and the docs call that "the correct outcome, not a
   degraded one". A completion verdict that requires every criterion `verified`
   is therefore unsatisfiable for any non-git workspace. The verdict must
   express "verified, or a named gap" from day one, not as a later refinement.

### 3b. COMPLETION — every place "done" is decided or refused, in order

| Order | Site                                          | Decides                                                  | Can it say "not done"?                                                               |
| ----- | --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1     | `agent-loop.ts:2497` halt report              | `halted`                                                 | terminal, no verdict                                                                 |
| 2     | `:2461-2478` empty-completion acceptance (G9) | **`done` on writes alone**                               | no                                                                                   |
| 3     | `:2578` / `:3053` interjection                | cancels the finish                                       | n/a                                                                                  |
| 4     | `:2585-2650` verification (G1)                | re-prompt on red                                         | yes, ×3                                                                              |
| 5     | `:2651-2690` replan (G2)                      | re-prompt, resets G1                                     | yes, ×1                                                                              |
| 6     | `:2696-2765` delegation evidence (G3)         | refuse                                                   | yes, ×1                                                                              |
| 7     | `:2770-2845` execution evidence (G4)          | refuse                                                   | yes, ×1                                                                              |
| 8     | `:2788-2800` settled-plan waiver (G4w)        | **stands 7 and 9 down**                                  | no — it _grants_ done                                                                |
| 9     | `:2847-2901` fix-verified (G5)                | refuse                                                   | yes, ×1                                                                              |
| 10    | `:2903-2948` product sight (G6)               | refuse                                                   | yes, ×1                                                                              |
| 11    | `:2970-3022` open steps (G7)                  | refuse ×1, then mark `open_steps`                        | yes, then labels                                                                     |
| 12    | `:3068-3071` `turn_complete`                  | the verdict                                              | —                                                                                    |
| 13    | `:3907-3935` step-ledger refusal (G8)         | refuses a _step_ completion mid-turn                     | yes, unbounded                                                                       |
| 14    | `engine.ts:5525-5532`                         | clears the handoff iff `end_turn` and no open todos      | no                                                                                   |
| 15    | `engine.ts:5883-5888` (N7)                    | **invents a terminal status when the loop emitted none** | no                                                                                   |
| 16    | `brief.ts:134-136` `complete`                 | `met` counts **only `rung === "verified"`**              | this is the only place that asks the contract question — **and nothing gates on it** |

Line 16 is the finding. `BriefLedger.complete` already computes exactly the
completion verdict Phase 5B wants. It is read by the close renderer
(`read-back.ts:87-108`) and by `ledgerStatus()` for G5's `verified === 0` test
(`agent-loop.ts:2854`). **No terminal path consults it.** A run with 0 of 6
criteria verified ends `end_turn`, `ok: true`, exit 0, and prints a "not done
— 0 of 6" block underneath.

**What one verdict would have to subsume.** To replace 4–11 a single verdict
must check: (a) every required criterion at `verified`, or an explicit declared
gap; (b) the plan has no open steps, or the cuts are stated (G7); (c) nothing
was written after the last evidence that covers it (G4/G4w's `writeCount`
arithmetic, `:2788-2794`); (d) delegated scopes were read (G3); (e) visual
deliverables were looked at (G6); (f) project checks are green or their failure
is declared (G1). (b)–(f) are all _derivable from criteria with evidence refs_
if the criteria are typed — which is the argument for 5D (AcceptanceGraph)
being a precondition for retiring any of these, not a follow-on.

### 3c. Design note — the additive insertion points

**Keep every guard.** The contract is a parallel record and one extra gate; no
existing `continue` or `return` moves.

**Insertion point 1 — `TaskContract` at intake.** `engine.ts:4996`, immediately
after `turnBudgetForMessage` and before `applyInheritance` (`:5006`). This is
the only place in the codebase that already has the verbatim user message, the
resolved budget, the prior events and the workspace revision in one scope, and
it runs before the first model call.

```
interface TaskContract {
  version: 1;
  intent: string;              // the user message, verbatim, never rewritten
  scope: { touch: string[]; leave: string[] };
  shape: "fix" | "feature" | "question" | "plan";   // isFixShaped (agent-loop.ts:442)
                                                    // + TaskKind (protocol/task.ts:113)
  criteria: ContractCriterion[];                    // Criterion + { required: boolean }
  budget: { turns: number; secondWinds: number; costUsd: number | null; deadlineMs: number | null };
  stop: { onHalt: true; onSpendCap: true; onCriteriaMet: boolean };
  createdAt: string;
}
```

At intake `criteria` is empty and `shape` is the mechanical guess. The contract
is **amended, not replaced**, by the first `read_back`: `engine.ts:1703`
(`onBrief`) already persists the brief there; add
`contract.criteria = brief.criteria.map(c => ({...c, required: true}))` and
`contract.scope = { touch: brief.touch, leave: brief.leave }` in the same
callback. `intent` never changes — `Brief.request` (`roundtrips.ts:133`) exists
for exactly this drift check and is already verbatim.

**Insertion point 2 — the completion verdict as the LAST gate.** Between G7 and
the `turn_complete` at `agent-loop.ts:3068`, i.e. a new block at `:3024`
_before_ the compaction block, so the verdict is computed on the same state the
gates saw. Signature:

```
type CompletionVerdict =
  | { kind: "met";      criteria: CriterionOutcome[] }
  | { kind: "partial";  criteria: CriterionOutcome[]; gaps: DeclaredGap[] }
  | { kind: "unmet";    criteria: CriterionOutcome[]; missing: string[] };
```

Computed from `BriefLedger` + `taskState.todoCounts()` + the run's check log —
**no model prose reaches it**, the same rule `rungForCommand` already keeps
(`brief.ts:490`). In the additive lane it is **advisory**: it writes its row,
attaches itself to `turn_complete`, and refuses nothing. Phase 5C's arbiter is
what gives it teeth.

`turn_complete` gains one optional field (`protocol/events.ts`), so every
existing consumer keeps working:

```
{ type: "turn_complete", stopReason, totalTurns, verdict?: CompletionVerdict }
```

**Insertion point 3 — close the four verdict-less exits.** E6
(`agent-loop.ts:2174-2178`), E7 (`:2287-2292`), E9 (`:3140-3159`) and E11
(`:4728-4746`) must each yield a `turn_complete` before returning. This is a
prerequisite, not a nicety: a verdict that is not emitted on four terminal
paths is not a verdict. Two new stop reasons are needed —
`"loop_detected"` and `"barren"` — added to `STATUSES` (`lifecycle.ts:270-280`)
and `TaskLifecycleStatus` (`protocol/events.ts:48`). This alone removes the
"everything the harness kills reads as `provider_lost`" defect.

**Minimal ledger rows (three, one new event type):**

| Row              | When                                                                  | Payload                                                                                                  |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `contract`       | intake, and on every amendment                                        | `{ version: 1, contract }` — latest-wins, deduped by digest exactly like `brief` (`engine.ts:6574-6576`) |
| `verdict`        | once per run, beside the terminal `lifecycle` row at `engine.ts:5891` | `{ version: 1, verdict, contractDigest }`                                                                |
| existing `brief` | unchanged                                                             | the criteria's rungs continue to live here                                                               |

Both new types go in `RUN_TRACE_EVENTS` (`engine.ts:373-396`) so they persist
through the existing `run_trace` wrapper and need no new table.

**Tests that break, and how they should change:**

| Test                                                                                                 | Why it breaks                                                                                      | Change                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/integration/engine-lifecycle-projection.test.ts`                                              | asserts the exact set of event types on a run                                                      | add `contract` and `verdict` to the expected set                                                                                                                                                                   |
| `tests/integration/lifecycle-durability.test.ts:416-425`                                             | replays rows after SIGKILL                                                                         | assert the `contract` row survives too — it is the one row that must exist before the first model call                                                                                                             |
| `tests/unit/orchestrator/agent-loop-finish-gates.test.ts`                                            | counts completions through the gate stack                                                          | unchanged in the additive lane (the verdict refuses nothing); in 5C, +1 expected completion per run that the verdict refuses                                                                                       |
| `tests/unit/orchestrator/brief-ledger.test.ts:123` (`complete` means all-verified)                   | `complete` becomes the verdict's input                                                             | keep as-is; add a test that `verdict.kind === "met"` iff `ledger.complete` and no open steps                                                                                                                       |
| `agent-loop-provider-lost.test.ts`, `agent-loop-breaker.test.ts`, `agent-loop-loop-detector.test.ts` | currently assert the absence of `turn_complete` implicitly, by asserting the last event is `error` | must now assert `turn_complete` with `stopReason: "loop_detected"` / `"barren"` **after** the error — the ordering rule at `agent-loop.ts:1391-1394` ("the terminal event goes LAST, after the error it explains") |
| `tests/unit/orchestrator/ui-grammar.test.ts:211-225`                                                 | the verdict needs a surface                                                                        | one `flowRow` dialect, same ladder — the read-back close block (`read-back.ts:87`) is the obvious host                                                                                                             |
| `tests/unit/orchestrator/turn-budget.test.ts`                                                        | unaffected                                                                                         | —                                                                                                                                                                                                                  |

**The one thing to get right first.** `Criterion.required` does not exist today
and cannot be inferred: `done_when` is 1–6 model-authored strings with no
structure. Without it, `kind: "met"` demands all six, including the one the
model wrote as a nice-to-have, and the verdict will read `unmet` on runs that
succeeded — which is how a gate gets turned off. Either the `read_back` schema
gains a `required` boolean per criterion (a model-authored field, but one that
_weakens_ rather than strengthens a claim, so it is safe by the same argument
that lets the model author the criteria at all), or every criterion is required
and `partial` with a declared gap becomes the normal successful outcome.
**Recommend the latter**: it keeps the model out of the strength ladder
entirely, and "done, except X, stated" is the honest shape of most runs.

---

## Deliverable 4 — the shadow-arbiter mapping

### 4.0 The precedence ladder is missing a class

Phase 5C specifies `safety halt > budget > contract verdict > progress
heuristic`. Sixteen of the guards above fit none of those four. E4 (empty
completion), E5 (consecutive errors), E6 (non-retryable), E8 (truncation), R11
(rate wait), R12 (overflow compaction), R13 (misencoded), N15 (reviewer
fallback) are **environment faults**: the model or the provider stopped being
usable. They are not budget (nothing was spent down) and not progress (the run
may have been making excellent progress). They also have a hard ordering
property the other classes do not: _you cannot evaluate a contract verdict when
the provider is gone_, so they must outrank the verdict.

Two more do not fit either: E2 (user abort) and G0 (interjection). A user
changing their mind outranks everything including a safety halt — the halt is
protecting the user, and the user is present.

**Recommended six-class ladder:**

```
0  user            abort, interjection
1  safety          supervisor halt, containment halt
2  budget          spend cap, turn ceiling, sub-agent cost/deadline
3  environment     provider lost, quota wall, context exhausted, empty completions
4  contract        the completion verdict, and the gates that derive from it
5  progress        loop detector, recurrence, barren, stale turns, breakers
```

Class 5 must never propose `complete`. That single rule kills G9 (empty
completion accepted as done), which is today a progress heuristic proposing a
successful completion.

### 4.1 Guard → proposed transition → class

| Guard                        | Proposes                                                                  | Class                                          | Pure predicate today?                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| E2 abort                     | `abandoned(user_abort)`                                                   | 0                                              | yes — reads `signal.aborted`                                                                                                                     |
| G0 interjection              | `working` (cancel the finish)                                             | 0                                              | yes — queue non-empty                                                                                                                            |
| E3 / N9 supervisor halt      | `blocked(halt)` → `complete(report_only)`                                 | 1                                              | **no** — latches `autoHalt`, strips the toolbelt, suppresses four gates at four sites                                                            |
| N10 late supervisor halt     | none (post-terminal); proposes a note on the _next_ run                   | 1                                              | no — mutates `sessionInjectionFindings`, queues `pendingTurnNotes`                                                                               |
| R16 containment defer        | `blocked(ask)` on the held step                                           | 1                                              | no — pushes onto `AutoMode.deferrals`                                                                                                            |
| N1 spend cap                 | `abandoned(budget)`                                                       | 2                                              | **no** — calls `currentAbort.abort()` from a gateway guard callback                                                                              |
| E1 turn ceiling              | `abandoned(budget)`                                                       | 2                                              | yes — `turn >= maxTurns`                                                                                                                         |
| X2 second wind               | `working` + budget delta                                                  | 2                                              | predicate pure; **action mutates `config.maxTurns` and re-arms R1**                                                                              |
| X1 refunds                   | budget delta                                                              | 2                                              | **no** — mutates `config.maxTurns` from inside `report()`, an observability callback                                                             |
| R17 sub-agent budget         | `abandoned(budget)` on the child, result retained                         | 2                                              | yes                                                                                                                                              |
| E4 empty completion          | `abandoned(environment)`                                                  | 3                                              | yes — counters only                                                                                                                              |
| G9 empty acceptance          | **today proposes `complete`**                                             | must become 3 → `complete` only with a verdict | yes                                                                                                                                              |
| E5 consecutive errors        | `abandoned(environment)`, or `complete` when the plan is closed (`:1375`) | 3                                              | yes                                                                                                                                              |
| E6 non-retryable             | `abandoned(environment)`                                                  | 3                                              | yes                                                                                                                                              |
| E7 budget admission          | `abandoned(budget)`                                                       | 2                                              | yes                                                                                                                                              |
| E8 truncation                | `abandoned(environment)`                                                  | 3                                              | yes                                                                                                                                              |
| R11 rate wait                | `working` after a delay; sets `quotaWallSighted`                          | 3                                              | **no** — sleeps, and the flag it sets vetoes X2 and arms R1                                                                                      |
| R12 overflow compaction      | `working` after a rewrite                                                 | 3                                              | no — rewrites `messages`                                                                                                                         |
| G1 verification              | `verifying` → `repairing` on red                                          | 4                                              | predicate pure; **action runs the project checks** (the only expensive shadow)                                                                   |
| G2 replan                    | `repairing`, resets G1's budget                                           | 4                                              | no — appends a message, zeroes `verifyAttempts`                                                                                                  |
| G3 delegation evidence       | `verifying`                                                               | 4                                              | yes — set difference over `readPaths` × `delegatedScopes`                                                                                        |
| G4 execution evidence        | `verifying`                                                               | 4                                              | yes — four booleans                                                                                                                              |
| G4w settled-plan waiver      | suppresses G4/G5                                                          | 4                                              | **no** — `settledPlanAtWriteCount` is written from inside the tool-result loop (`:4392+`) and withdrawn from two other places (`:2624`, `:3949`) |
| G5 fix-verified              | `verifying`                                                               | 4                                              | yes — `ledger.total/verified` + `isFixShaped`                                                                                                    |
| G6 product sight             | `verifying`                                                               | 4                                              | yes — `visualReview.snapshot()`                                                                                                                  |
| G7 open steps                | `repairing`, then `complete(partial)`                                     | 4                                              | yes — `todoCounts()`                                                                                                                             |
| G8 step-ledger refusal       | `working` (the step is not closed)                                        | 4                                              | yes — `SetTodosVerdict` is already a value                                                                                                       |
| **completion verdict (new)** | `complete(met \| partial \| unmet)`                                       | 4, **last**                                    | yes by construction — no model prose reaches it                                                                                                  |
| E9 loop detector             | `abandoned(no_progress)`                                                  | 5                                              | predicate pure; **action replaces tool results**                                                                                                 |
| E10 recurrence               | `abandoned(no_progress)`                                                  | 5                                              | as above                                                                                                                                         |
| E11 barren                   | `abandoned(blocked)`                                                      | 5                                              | yes                                                                                                                                              |
| E12 progress breaker         | `abandoned(no_progress)`                                                  | 5                                              | **no** — `seenResults.add()` happens _during_ the read, so reading the predicate is what makes the next read different                           |
| R3 repeated-call breaker     | `working` (refuse the call)                                               | 5                                              | **no** — substitutes the tool output                                                                                                             |
| R4 same-shape breaker        | `working` (note, then refuse)                                             | 5                                              | **no** — the streak advances inside result processing                                                                                            |
| R6/R7/R8 tripwires           | `working` (prefix a note)                                                 | 5                                              | predicate pure; action mutates `resultContent`                                                                                                   |
| R10 struggle signals         | `working` (+ `replanning` event)                                          | 5                                              | no — per-run maps in the detector                                                                                                                |
| N3 tool pacer                | `working` after a delay                                                   | 5                                              | **no** — sleeps invisibly                                                                                                                        |

### 4.2 The counters that become typed state

Everything below is an `agent-loop.ts` local or an `engine.ts` private field
today, and is lost on process death. `RunState` is where they go.

```
RunState {
  phase: "intake" | "contracted" | "working" | "verifying"
       | "repairing" | "blocked" | "complete" | "abandoned";
  budget:   { turn, maxTurns, baseMaxTurns, refundsGranted, refundCap,
              lastRefundedTurn, windsUsed, windDoneAtStart,
              wrapUpInjected, quotaWallSighted, spentUsd };
  evidence: { writeCount, executedSinceWrite, projectChecksPassed,
              anyWritesThisRun, settledPlanAtWriteCount,
              settledPlanExcusedWrites, lastEvidencedWriteCount,
              readPaths, delegatedScopes };
  gates:    { execution, fixVerified, productSight, openSteps, delegation,
              plan, greenfield, artDirection, replan, stuck, stale,
              resultLoop, barren }        // each: { fired: number, cap: number }
  health:   { consecutiveErrors, emptyCompletions, verifyAttempts,
              rateWaits, overflowCompactions, misencodedCalls,
              truncationRetries };
  progress: { staleTurns, barrenTurns, seenResults, recentToolSignatures,
              recentResultSigs, failedCalls, sameShapeFailure };
  safety:   { halt: {reason} | null, haltReportPending, haltReportGranted,
              injectionFindings, deferrals };
}
```

Four of these already have durable homes and should be _read from_ them rather
than re-invented: `writeCount`/`readPaths` overlap `taskState.filesWritten` /
`filesRead` (`task-state.ts:94`); the gate ledger overlaps
`StepLogKind: "gate"` entries; `spentUsd` is rehydratable from `cost` events
(`engine.ts:6274-6328`); and `budget.turnsUsed`/`windsUsed` already round-trip
through `inheritedBudget` (`lifecycle.ts:445-470`). **`safety.halt` and
`safety.injectionFindings` are the ones with no durable home at all
(`engine.ts:1385`, `:1387`), and they are the highest-precedence class.** That
inversion — the only guards that outrank everything are the only guards with no
persistence — is the first thing Phase 6's `kill -9` scenarios will find.

### 4.3 Which guards shadow cleanly, and which do not

**Shadow cleanly today (pure predicate over observable state):** E1, E2, E4,
E5, E6, E7, E8, G0, G3, G4, G5, G6, G7, G8, R17, and the second wind's
_predicate_. Sixteen guards can become `propose()` functions in the shadow lane
with no behaviour change at all, because the code already computes a boolean
before it acts.

**Do not shadow without surgery, in rising order of difficulty:**

1. **X1 refunds** — the refund lives inside `report()` (`:1110`) precisely so
   that "a gate added next month is refunded without anyone wiring it"
   (`:1108-1109`). That is a good property and an anti-shadow property: the
   decision is invisible at the call site. Split into
   `TurnRefunds.wouldRefund(cls, turn)` (pure) and an `apply` the arbiter
   calls. `turn-refunds.test.ts:16-73` tests the pure half already.
2. **R3, R4, E9, E10, N3** — these guards _substitute the world_: a refused
   call returns a manufactured error, the pacer sleeps, the loop detector
   answers the repeated blocks. Shadowing them means letting the call run,
   which changes the run. These are the guards where shadow mode must be
   "observe and log the proposal, take no action", and the log is the only
   evidence — no A/B.
3. **E12 progress breaker** — `seenResults.add(key)` inside the read
   (`:4795-4801`) means the predicate is not idempotent. A shadow arbiter that
   asks "would you fire?" twice gets two different answers. Must be split into
   a `note(results)` step and a pure `isStale()` query before anything can
   shadow it.
4. **G4w settled-plan waiver** — three writers (`:3855`, `:2624`, `:3949`) and
   one reader (`:2788`), with the arithmetic
   `settledPlanAtWriteCount + settledPlanExcusedWrites === writeCount` as the
   invariant. This is the guard most likely to produce a _wrong_ shadow
   proposal, because it is the only one whose state is an equality between
   three counters maintained in different code paths. It also has the most
   tests (`agent-loop-settled-plan.test.ts`, `agent-loop-write-excuse.test.ts`,
   `finish-path-cost.test.ts`) — use them as the shadow's oracle.
5. **G1 verification** — the only guard whose action costs real time. Shadow
   the predicate (`editsSinceVerify && verifyAttempts < max`), never the run.
6. **E3 / N9 halt** — not hard to shadow, but hard to _leave alone_: the halt
   already suppresses G1–G7 by four separate ad-hoc checks. The shadow arbiter
   will immediately show those four as one precedence rule, which is the single
   clearest demonstration that the arbiter is worth building. Do this one first
   as the proof case.

### 4.4 What the shadow lane should assert

There is **no arbitration test in the repo today** — every guard is tested in
isolation. The shadow lane's own proof should be:

1. Every one of the 45 `lifecycle-durability.test.ts` scenarios and the 260
   integration scenarios produces at least one arbiter proposal per guard
   trigger, and the proposal the arbiter _would_ have applied equals what the
   code actually did. Divergences are the bug list.
2. The four verdict-less exits (E6, E7, E9, E11) each produce a proposal with a
   distinct `abandoned(reason)`, and a test asserts none of them is
   `provider_lost`.
3. One new red test, green only after 5C: two guards firing in the same step
   (the obvious pair is a supervisor halt during a failing verification round)
   resolve by class, not by line number.
4. `agent-loop.ts` line count is recorded at 5,185 and asserted non-increasing
   per commit from the first migration commit onward.
