# M3 — migrate one continuation decision at a time

Written 2026-09-14 by the supervising session after M2 (`a9a9f37`, `b5632fb`). This is the
spec for the M3 lane's FIRST branch. It applies
[the review's M3](guarantees-plan-review-20260914.md#m3--migrate-a-single-continuation-decision-at-a-time)
to what M2's shadow report showed: over twelve scenarios the arbiter disagreed with the guards
exactly once, at G9, and that disagreement is a label, not a behaviour.

## What M2 showed, read carefully

At the empty-completion site the guard records `complete(end_turn)` as what it did. It does
not. Reading `agent-loop.ts` at the site: after accepting the silent finish the loop falls
through to `if (producedText)` and into the finish path — G1 verification, G2 replan, G3–G7,
then the verdict. G9 decides only "this silence is not a provider loss"; whether the task is
done is decided below it, by the verdict M1 defined. So the honest transition at that site is
**`verifying`**, and the arbiter's rule "class 5 never proposes `complete`" was right for a
reason the site's label hid. The first M3 change is therefore to correct the label
(`observe("G9", …, "verifying", …)`) and to make the arbiter's G9 rule propose `verifying`
when work stands — after which the shadow report reads zero disagreements and the branch is
covered end to end.

## The branch: empty completion (E4 + G9 as one decision)

One decision, three outcomes, all already coded and tested
(`agent-loop-empty-completion.test.ts`, `agent-loop-endurance.test.ts`, the lifecycle
scenarios `empty-completion-accepted` / `empty-completion-bail`):

```
event: empty_completion { emptyCompletions, maxEmpty, workStands, toolCallsThisRun,
                          silentEndTurn, narratedEarlier, aborted, haltReportPending }
  aborted or haltReportPending          → not this decision (class 0 / 1 already own it)
  emptyCompletions < maxEmpty           → working      (nudge once when tools ran, then retry)
  workStands                            → verifying    (fall into the finish path; the verdict decides)
  otherwise                             → abandoned(environment)   stopReason provider_lost
```

`maxEmpty` is `2` when work stands, else `config.maxEmptyCompletionRetries ?? 3` — unchanged.

### Migration mechanics

1. `[controller] authority = []` (config, default empty). When it contains `"E4"`, the loop
   calls `arbiter.decide(...)` at the site and **acts on the decision** — nudge / continue,
   fall through, or abandon — through the same code paths it uses today; the inline
   predicate is deleted from that site (the duplicate authority the review asks to remove).
   When it does not contain `"E4"`, the site behaves exactly as at `b5632fb` and shadows as
   before. This is the rollback switch.
2. **Persist the decision before acting.** A `decision` row `{ eventId, decisionId,
transition, applied: true, class }` is appended before the nudge / the terminal event.
   Exactly one applied decision per event; a crash between the row and the act is
   reconciled on resume by reading the row (the act is idempotent: a nudge message is
   appended only if the last message is not already that nudge; a terminal is re-emitted
   only if the run has no terminal row).
3. **Restart does not reset the allowance.** `emptyCompletions` joins the durable budget
   the run already carries across a resume (`inheritedBudget` in `lifecycle.ts`, the
   checkpoint that `previousRunWasInterrupted` reads). A run killed after two empty
   completions that resumes and gets a third abandons; it does not get a fresh three.
4. **A turn refund never refunds usage** — unchanged; the branch spends no refund.
5. Permissions, sandbox, spend caps, the reviewer, containment: untouched. A test diffs
   the `safety_decision` and permission rows of the branch's scenarios with authority on
   and off — identical.

### Exit tests (per branch, from the review)

| #   | Requirement                          | Test                                                                                                                                                    |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Previous regressions pass            | `agent-loop-empty-completion.test.ts`, `agent-loop-endurance.test.ts`, the two lifecycle scenarios — green with authority on AND off                    |
| B2  | Contradictory triggers               | empty completion ∧ abort → aborted (class 0), no nudge; ∧ halt report pending → the halt path, no nudge; ∧ turn ceiling on the same turn → budget wins  |
| B3  | Restart does not reset the allowance | SIGKILL after 2 empty completions (scenario rig), resume, third empty completion → `provider_lost`; a control run without the kill needs the same count |
| B4  | One applied decision per event       | every `empty_completion` event has exactly one `decision` row with `applied: true`; the shadow rows for the same event still exist and agree            |
| B5  | Rollback                             | authority off → byte-identical `AgentTurnEvent` sequence and spend fingerprint to `b5632fb` on the branch's scenarios                                   |
| B6  | Label corrected                      | the shadow report over M2's twelve scenarios shows **zero** disagreements; G9's proposal is `verifying` when work stands                                |
| B7  | Permissions unchanged                | permission / safety rows identical with authority on and off                                                                                            |

Mutation: with authority on, delete the `applied` row write → B4 red; make `decide` return
`working` unconditionally → B1's bail scenario red (the run never ends).

## The second branch (only if the first lands green): the acceptance re-prompt

M1 left `--acceptance` advisory. With the false-positive / false-negative cases in
`acceptance-omission`, `acceptance-new-feature` and the FP/FN tests green, the review allows
acceptance to become authoritative for one bounded step: when an evaluator criterion is
`failed` at the finish gate and the run has a turn left, the controller decides `repairing`
ONCE — one re-prompt naming the failed criterion's text and the tail of its output, never the
command — then the next finish ends `partial` whatever happens. `needs_review` never
re-prompts (a missing runner is not the model's to fix). Same mechanics: authority key
`"acceptance"`, a persisted applied decision, B1–B7 re-run for it, plus: a run with no turn
left ends `partial` without the re-prompt; the re-prompt contains no command text; the
evaluator command is not rerun more than once per finish attempt.

## Non-goals

No other guard moves. No RunState persistence beyond the one counter. No line-count gate. No
change to what `met` means. The `decision` row is the only new row type.
