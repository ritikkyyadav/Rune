# Rune guarantees: review and corrected execution plan

Reviewed 2026-09-14 against HEAD `4869e4c1c255e2653dcd9f05eb379e50f23a75d8` **plus the existing working changes**. This is a review and proposed plan. No implementation, installation, release, or benchmark was performed as part of this review. The preceding implementation effort was stopped at the founder's request; no coding subagents remained active when checked.

Inputs: the three founder-supplied ChatGPT/Claude reports; [Claude's guarantees program](guarantees-program-20260914.md); [the guard inventory](guard-inventory-20260914.md); selected current runtime, contract, evidence, and workflow source. Earlier reports describe older revisions. Recheck HEAD and the working diff before executing this plan.

## Decision

**Keep the contract, acceptance, evidence, and bounded recovery direction. Keep the five-day proposal's additive/shadow migration approach. Correct the acceptance semantics before activating a new controller. Do not start a wholesale rewrite, delete working delegation, or build the mission daemon now.**

The product thesis should be:

> Rune lets an organization choose its model while retaining control over execution, acceptance checks, recovery, and the evidence trail. It aims to deliver accepted tasks with fewer avoidable correction turns, and explicitly reports what remains unverified.

This promises enforceable controls and honest evidence. It does not promise that an arbitrary natural-language request has been perfectly understood, that every defect can be detected, or that any model will produce the same quality. Provider portability is also not, by itself, data sovereignty: remote-model data flows and deployment policies remain part of that question.

Evaluate cost per independently accepted task, correction turns, false completion, regressions, recovery, and latency together. Higher inference spend can be worthwhile, but the claimed reduction in human effort must be measured. Necessary clarification is different from a correction caused by a defective result. Keep all modes within the same permission, isolation, and spend boundaries; vary verification effort rather than silently lowering safety.

## Relationship to the original handoff: preserve the full product scope

**Scope correction, 2026-09-14:** the earlier continuation prompt named this document alone. Its M0–M6 sequence did not fully carry forward the original onboarding, frontend/architecture, and release acceptance gates. That was a planning omission, not a founder decision to cancel those requirements.

[The original Claude Code handoff](../CLAUDE_CODE_HANDOFF.md) remains the full terminal-product scope. This document corrects acceptance semantics and the controller migration within that scope; it does not replace the original Phases 0–7. Where implementation instructions conflict, use the corrected semantics here while preserving the original user-facing outcomes. Finishing M0–M6 alone is not completion of the full handoff. Desktop/web product expansion remains outside the original terminal scope.

The original progress table currently records Phases 0–2 as verified on earlier revisions and Phase 3 as done with named gaps. Later onboarding, UI, CI, and contract commits also exist. These are reasons to reconcile and preserve work, not to start those phases over. Neither those records nor this scope correction certify the current combined tree; Phase 4–7 closure is not established by the original table.

| Original phase                         | Coverage in this revision               | Requirements that remain binding                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Reconcile correctness fixes         | M0                                      | Preserve current work, fix reproduced defects, and reconcile evidence against the actual revision.                                                                                                                                                    |
| 1. Deliver one coherent build          | M0 and delivery rules                   | Fresh applicable gates on the final combined source; guarded installation; actual CLI/native provenance and installed terminal smokes.                                                                                                                |
| 2. Durable lifecycle and compaction    | M1–M4, with longer-run extensions in M6 | The original process-level scenario: dirty/untracked edits, worker work, user steering, repeated compaction, interruption, restart, conflict handling, retained constraints, and independent acceptance.                                              |
| 3. Auto efficiency                     | M3–M5                                   | Per-role cost/time accounting, bounded queues and retries, useful progress while waiting, shared limits across restart, and measured completed-task cost at equal acceptance quality. Mock call reductions do not establish live savings.             |
| 4. First-run and settings UX           | Only partly covered by M0               | Complete the installed fresh-profile walkthrough: intelligence and internet setup, masked credentials, validation, active-versus-saved settings, precedence, spend/sandbox controls, coding, changes, and restart without hand-editing configuration. |
| 5. Frontend quality and planning depth | M5 includes diagnostic fixtures only    | Complete the reference-to-preview-to-review workflow, current browser evidence, desktop/mobile and accessibility checks, independent visual assessment, and a dependent architecture/migration task that exposes late inconsistencies.                |
| 6. Bounded self-evolution              | M6                                      | Frozen control/candidate trials, held-out outcomes, total learning cost, rejection of harmful or unsupported promotion, rollback, and bounded configurable overhead. A negative trial is not evidence of improvement.                                 |
| 7. Release and competitive evidence    | M5 and delivery rules cover only part   | Reproducible broader comparisons, actual supported-platform installation/containment/cleanup checks, executed CI evidence, and an accurate release manifest. Live evaluation and publication retain their separate authorization boundaries.          |

### Combined execution order

1. **M0 / original Phases 0–1 reconciliation.** Inspect the current diff and previous receipts. Fix the reproduced contract defects and close interrupted integration work. Retain already-supported results with their revision; identify the checks affected by subsequent changes. Do not repeat the whole audit.
2. **M1 and original Phase 4 completion.** Establish acceptance semantics before controller enforcement. Finish the existing onboarding/settings work and its installed walkthrough; it does not depend on building a mission service or migrating every continuation branch. Coordinate shared files through one owner.
3. **M2–M4 and original Phases 2–3 residuals.** Introduce the passive controller, migrate covered decisions incrementally, and integrate bounded repair/delegation. Exercise the original lifecycle scenario and affected Auto-efficiency probes against the resulting implementation. Retain unsupported cost claims as unproven.
4. **Original Phase 5 plus M5.** Finish the frontend and architecture workflows, then use the frozen diagnostic corpus to find defects and measure outcomes. A single frontend fixture does not close Phase 5. Use offline fixtures first; live model work requires the existing plan's explicit evaluation budget.
5. **Original Phase 6 plus M6.** Validate the existing bounded evolution mechanism once short tasks are reliable. Persistent missions are a conditional extension, not a prerequisite for onboarding, frontend work, or evaluating existing learning. Report no promotion or no measured lift honestly.
6. **Original Phase 7 and final delivery gates.** Verify the final combined source and installed artifact, supported-platform behavior, and reproducible comparison evidence. Close or explicitly retain each original residual. Do not replace a missing platform run, broader comparison, or usability walkthrough with a unit-test count.

Use the original handoff's progress table and [harness status](../harness-status.md) as the completion record, adding the corresponding M milestone and evidence references. After every milestone, record behavior changed, exact revision/artifacts, checks and outcomes, unresolved requirements, and the next executable step. Required work that is blocked or unverified remains pending; it cannot be relabeled as full-program completion. This reconciliation changes planning documents only and completes none of the implementation phases.

## Material faults in the reports and proposed plan

| Priority | Finding                                                                                                                                                             | Correction                                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Phase 5B says done means every criterion is verified **or a gap is declared**. Declaring an omission cannot satisfy a requested feature.                            | Separate a run ending from its task being accepted. `partial`, `blocked`, `cancelled`, and `unassessed` are useful results, but not accepted completions.                                                                                                                                                                  |
| P1       | All required criteria must reach the existing `verified` rung, while that rung requires a failing parent-commit check.                                              | Separate acceptance from regression attribution. A verified explanation, new behavior, or already-correct requirement does not universally need a failing parent. Conversely, failing on a parent does not prove relevance or complete coverage.                                                                           |
| P1       | Promoting the model's read-back into a contract can preserve the same omissions the contract is meant to catch.                                                     | Retain the verbatim request, versioned criteria with source references, and explicit coverage gaps. Generated criteria are interpretations, not an independent oracle. Keep evaluator acceptance outside the implementation agent's control.                                                                               |
| P1       | Targeted re-verification assumes a complete dependency graph; the plan supplies no conservative fallback.                                                           | Invalidate by recorded content/dependency fingerprints. Unknown impact requires broader re-verification. Include config, dependencies, generated artifacts, and environment, not only directly edited files.                                                                                                               |
| P1       | Phase 7 proposes deleting “the dead cross-instance TeamBus and workflow code.” These are not the same system.                                                       | Current `Engine` registers `createWorkflowTool`, using the real task/worker registry. Audit reachability and compatibility of specific scheduler APIs. Quarantine an unused queue API if justified; preserve working task/worker/workflow execution. Do not delete to gain hypothetical score points.                      |
| P1       | A shadow arbiter is described as having zero behavioral risk. Existing predicates may mutate counters, allocate budgets, or produce prompts.                        | Shadow decisions must be pure and unable to dispatch, mutate production counters, grant permissions, spend, or write authoritative state. Bound telemetry volume and measure latency.                                                                                                                                      |
| P1       | The mission plan excludes host sleep from elapsed budget and assumes 429 responses provide a usable reset time.                                                     | Separate absolute deadline, active execution time, provider wait, and spend. Sleeping must not refund spend or extend an absolute deadline. Resume only explicitly scheduled missions, with supported retry hints, bounded backoff, persistent caps, and identity checks.                                                  |
| P2       | File length must decrease on every migration commit.                                                                                                                | Measure exclusive decision ownership and removed duplicate logic. A line-count gate encourages moving complexity or deleting checks and can penalize a safe additive migration.                                                                                                                                            |
| P2       | The full program proposes free-route external benchmarks at “zero budget,” excludes throttled runs, and says silent defects are measurable only after TaskContract. | Availability and resource limits still matter on a free route. Independently specified checks can detect silent omissions today. Report both infrastructure interruptions and conditional completed-run performance; selective exclusions must not hide operational unreliability. Validate each comparator adapter first. |
| P2       | The plan assumes an arbiter can be evaluated from 93 stored runs without establishing that their logs contain every predicate input and counter.                    | Check trace completeness first. Label missing state unreconstructable; use deterministic fixtures rather than inventing historical decisions.                                                                                                                                                                              |
| P2       | Production grade is defined largely by types, ledger rows, mocks, doctor, and an adversarial reviewer.                                                              | These are useful gates, not sufficient proof of deployment readiness. Require real supported-platform execution, schema migration/recovery checks, and task outcomes. A second model's approval is not independent ground truth.                                                                                           |
| P2       | The proposal defers frontend work and model profiles wholesale until a mission daemon exists.                                                                       | Defer feature expansion; retain a frontend acceptance fixture and provider protocol checks now. User-visible omission and provider compatibility are central tests of the assurance thesis. They do not depend on a daemon.                                                                                                |

The reports' numerical ratings should not direct engineering. Claude's listed architecture components add to **61, not its stated approximately 70**. Neither a score adjustment nor a projection from 68 to 85 is a measured performance gain. Stars do not establish whether anyone has used a binary, and a large file does not establish that incremental refactoring is impossible.

The guarantees program's “comparison rig exists with zero recorded runs” is also too broad: dated Rune/OpenCode comparison reports already exist under `docs/evidence/`, including Pilot J and free-route series C. **Local comparisons and official external benchmark runs are different claims.** Likewise, the September 9 report's absence of named contract/lifecycle types cannot describe today's source: `contract.ts`, `TaskLifecycle`, and the new intake/verdict integration exist. Their existence does not prove that all continuation decisions have one owner.

## Current code findings to address first

These are findings on the working source, not claims that a complete integration suite was rerun.

### 1. Different commands can erase a failed-check gap

`packages/orchestrator/src/contract.ts`, `failingChecks()` (line 269 at review), uses `command.replace(/\s+/g, " ")`. It collapses whitespace **inside quoted paths**.

A read-only function probe supplied these distinct recorded checks:

```text
node --test "checks/a  b.test.js"   failed
node --test "checks/a b.test.js"    passed
```

With an already-verified criterion and no open steps, `computeVerdict()` returned `met`; the later success erased the other command's failure. This was a function-level reproduction using synthetic recorded results, not execution of those example test files.

**Fix:** use the established quote-preserving `normalizeCommand` for compatibility, then prefer immutable execution/check IDs with explicit supersession. Add a regression in `tests/unit/orchestrator/contract.test.ts` and prove the full recorded-check-to-verdict path. Re-running the same check may supersede its failure; running a different command must not.

### 2. Request shape misclassifies ordinary instructions

Read-only probes of `contractShape(intent, false)` returned:

| User message                   | Current result | Problem                                                                                      |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------- |
| `Can you implement login?`     | `question`     | An action phrased politely becomes a question task.                                          |
| `Implement a design system`    | `plan`         | A noun in the requested artifact selects planning.                                           |
| `ship it`                      | `chat`         | An action can be treated as acknowledgement. Authorization to deploy still requires context. |
| `Explain how the parser works` | `feature`      | An explanation request becomes an implementation task.                                       |

The current module describes its verdict as advisory. Do not turn this heuristic into authority to skip verification, execute, or expand permissions. Fix the examples; use explicit request/interaction context and retain `unknown` when ambiguous. A classifier cannot authorize external actions. Test mixed asks and follow-up steering without adding a model call to every intake.

### 3. Acceptance and causal regression evidence are conflated

`BriefLedger.record()` in `packages/orchestrator/src/brief.ts` refuses `verified` without `parentCommitFailed`. `computeVerdict()` requires every criterion's rung to be `verified`. This makes the old causal-regression ladder an unsuitable universal acceptance policy.

Do not simply remove the parent check and make every green command sufficient. Introduce separate facts: command execution, check outcome, criterion coverage, content/environment freshness, acceptance policy, and optional regression attribution. Map legacy rows conservatively; do not silently upgrade saved sessions. An independent acceptance pass can satisfy a new-feature criterion; unrelated green lint cannot.

### 4. Workflow deletion is contradicted by production wiring

`packages/orchestrator/src/engine.ts:6940` registers `createWorkflowTool({ registry, workspaceRoot, maxParallel })`. The preceding code wraps `task` and `worker` in the delegation pool. `workflow-tool.ts` runs through that registry. An unused `claimNextTask()` does not make these paths fictitious. Keep the distinction in the migration inventory and feature claims.

## Corrected execution sequence

Use milestones with stop conditions, not promised days or architecture scores. This sequence refines Claude's guarantees program; it does not restart the earlier broad harness audit.

### M0 — freeze the subject and finish the interrupted batch

1. Record current commit, tracked diff, untracked sources, installed metadata, and artifact hashes. Read the newest changes; other contributors have advanced this branch during pauses.
2. Preserve all unfinished TUI/onboarding/contract changes. Identify each independently reviewable slice. Do not install or publish a partially verified combination.
3. Reconcile the guard inventory against current source: `385ff70` already changed terminal exits and `4869e4c` added intake/verdict integration. Do not repeat their work from the older snapshot.
4. Fix the two reproduced contract bugs above and close the known unfinished integration tests. Keep unrelated UI refinements out of the control-core migration.

**Exit:** focused regressions pass; one authoritative list states what is implemented, tested, installed, and still pending. No old passing count is relabeled as proof for a newer tree.

### M1 — define acceptance semantics before enforcement

Extend the existing contract and ledger, rather than creating a competing store. Minimum data:

- Stable task/criterion IDs and contract revision; verbatim request; criterion source (`user`, `inferred`, or external evaluator); required/optional status; constraints; acceptance method; explicit uncovered requirements.
- Evidence with execution ID, verifier identity/version, result, evaluated artifact/content digest, relevant environment/config fingerprint, and dependencies. Producer output and verifier assessment are separate records.
- Criterion status such as `unassessed`, `satisfied`, `failed`, `stale`, or `needs_review`. Preserve observation/reproduction/parent-regression facts separately.
- Execution status and stop reason separate from acceptance verdict. A stopped or partially successful run must not enter the success metric merely because it emitted a final answer.

The runtime, not the implementation agent, applies declared acceptance rules. The model may propose criteria, but cannot silently delete a requirement, make it optional, weaken a test, or change the completion policy to pass. Record amendments and their origin. Clarify material ambiguity; do not force users through approval rituals for routine tasks.

**Exit tests:** a known omitted feature fails independent acceptance despite green existing tests; a legitimate new feature can pass without a failing parent; unrelated green checks cannot satisfy it; constraints survive amendments/restart; a stale or unmapped criterion stays unaccepted; partial output retains its usefulness and honest status. An explanation can be delivered with its verification limits stated, without manufacturing a failing parent check.

### M2 — build a genuinely passive controller in shadow

Use a pure decision function over a versioned immutable state snapshot and event. Existing guards retain authority initially. Define simultaneous-event handling for cancellation, safety halt, spend/deadline exhaustion, provider failure, verification result, and progress. Safety checks stay at tool/permission boundaries even after continuation is centralized.

Give each event and decision a stable identity. Separate deciding from acting and from recording. Define persistence of retry/refund/wind counters, in-flight actions, and logical versus physical attempts; a turn refund must never refund actual usage. Terminal states are absorbing **for that run ID**; user follow-up creates or explicitly resumes the appropriate task/run instead of silently resurrecting a completed run.

Shadow mode must not run predicates with production side effects, issue tools, change budgets, or create authoritative task state. Its logging must be bounded and must not expose credentials or expand transcript context. Compare complete traces only; a missing predicate input is an unknown, not agreement.

**Exit:** deterministic replay and injected concurrent-event tests agree on decisions; shadow mode changes neither actions nor spend; discrepancy reports name causes. Report observed latency/volume overhead. “Zero risk” is not an exit criterion.

### M3 — migrate a single continuation decision at a time

Start with one bounded retry/completion branch whose behavior is covered. Route that branch through the controller and remove its duplicate authority. Keep a rollback switch, then repeat. Do not migrate every guard at once or demand fewer lines in every commit.

Acceptance claims from M1 become authoritative only after their false-positive and false-negative cases pass. Do not introduce forced extra model turns when a deterministic blocked/partial result is already justified. Persist the decision before dispatch where appropriate, and reconcile in-flight effects after crashes. Do not promise exactly-once external effects without idempotency support; uncertain completion must remain explicit.

**Exit per branch:** previous regressions pass, contradictory triggers are tested, restart does not reset its allowance, and each event has one applied decision. Permissions and sandbox behavior are unchanged unless separately reviewed.

### M4 — bounded repair and useful delegation

Add typed repair policies to the existing controller: transient provider/tool transport failures, implementation/check failures, missing environment dependencies, acceptance mismatches, and denied actions require different responses. Permission denials and exhausted budgets are not invitations to try another route around the boundary.

Share real spend and hard attempt/time limits across lead, workers, compaction, retries, fallback, and repair. Detect no progress with evidence/artifact changes. Reverify the impacted set with a conservative wider fallback. Do not reset limits at process restart.

Use existing task/worker/workflow execution. Each child receives a bounded subset of the contract, dependencies, owned files, and budget; returns artifacts and evidence; and is verified after integration against the current combined tree. Independent file ownership does not prove semantic compatibility. For material isolated work, verify a candidate snapshot and compare the destination revision before integration; preserve user edits on conflict. Exposing enough agent state to understand cost/failure is useful; making agent count a target is not.

**Exit:** failed checks lead to relevant bounded repairs; unrelated tests are not rerun endlessly; child prose cannot grant acceptance; a correct child patch cannot be called integrated if the destination has changed incompatibly; exhausted repair returns a durable useful partial result.

### M5 — measure the thesis on a small frozen corpus

Begin with a predetermined diagnostic set of approximately 12 tasks covering fixes, omissions, migrations, frontend behavior, research/explanation, and dirty-worktree integration. This is for finding defects, not claiming competitive superiority. Run deterministic offline cases immediately; use live routes only under an explicit current budget, availability, and data policy. Do not assume the founder's subscription reset is permission for a paid benchmark.

Pin tasks, acceptance fixtures, versions, model settings, budgets, arm order, and output locations. Add comparisons only where the harness adapter is actually validated; current Rune/OpenCode support is not proof that a Pi arm already exists. Include at least two model families before any model-independence performance claim. Expand the sample after resolving diagnostic failures, not by selecting whichever run flatters Rune.

Report attempted tasks, infrastructure interruptions, accepted outcomes, false completion, later-detected regressions, correction turns, review minutes, wall time, and all inference/repair overhead. Cost per accepted task must include costs of failed attempts, not just the winning runs. Keep rates and denominators visible. Human time and delayed defects require their own observation protocol; do not invent them from token logs. A second model's opinion may supplement independent tests or human review, but cannot certify its own correctness.

Keep frontend functional acceptance in this corpus now; use a separate declared visual rubric for design. Official SWE-bench/Harbor evaluation and wider external adoption come after reproducibility, with their actual compute requirements. Keep official results distinct from local fixtures. Do not withdraw a failed comparator run simply because it finished unusually quickly; diagnose and retain the failure classification under a rule fixed before scoring.

### M6 — longer missions and evolution only after the short-run path holds

Only then decide whether a persistent mission service is justified. Extend the existing durable state with explicit opt-in scheduling, task/run lineage, leases, trigger deduplication, a cross-run budget, cancellation, and policy revalidation. Do not add a second authoritative mission database alongside the current one.

Persist provider retry hints when available; otherwise use bounded backoff. Distinguish waiting, sleeping, active work, and absolute expiry. Test a crash between tool effect and receipt persistence, interrupted child integration, process identity reuse, missing permissions after restart, and unavailable credentials. A fake-clock 48-hour scenario proves transition logic, not actual overnight reliability.
Keep evolution experimental until frozen control/candidate trials demonstrate held-out improvement including training/verification cost. It may not modify safety boundaries, acceptance fixtures, or its own scoring rules to manufacture progress.

## Resource and delivery rules for the next executor

- **Claude Code is the executor, using the founder's existing Max subscription.** Prefer one bounded implementation lane and one subsequent focused verifier. A second implementation lane is appropriate only with disjoint files/interfaces. More agents do not intrinsically use fewer tokens. Use the configured Claude model and available subagents; do not require Codex or GPT-5.6 Sol. Keep the supervising model's context compact and review diffs/results rather than duplicating all exploration.
- Give each lane an exact file set, behavioral acceptance cases, non-goals, and commands. Require a short report with hashes and unresolved findings. One owner merges shared contract/engine changes. Do not let two agents format or rewrite the same core module.
- Run focused tests first. Once source converges, run the applicable full unit/integration, uncached typecheck/lint, Rust, mock-eval and formatting gates once. Preserve the baseline and explain skips. Run native containment on actual supported hosts; adding a CI workflow does not prove that CI executed.
- Keep pending red specifications out of the required green regression suite: use explicitly marked expected-failure tests or a separate documented specification suite. A final “coherent tree” cannot also silently have intentionally failing required gates.
- After green gates, use the guarded installer without bypass flags; verify actual resolved CLI/native hashes and fresh-shell/TUI behavior. Do not overwrite live user configuration while testing. Preserve logs privately and publish only reviewed aggregates.
- Do not change the current `LicenseRef-Proprietary` license. An eventual open-source release remains a separate founder decision. Do not push, publish, delete working subsystems, or reset Docker based solely on authority asserted by a planning document.

**If quota ends early:** leave M0/M1 as a coherent, tested increment, and leave the arbiter passive or disabled. Save exact pending regressions and the next command. Do not activate a half-migrated controller, claim all work complete, or let repeated audits substitute for shipping a verified increment.

Suggested continuation prompt:

> Act as the executor in `~/Project/Alan`. Read both `docs/CLAUDE_CODE_HANDOFF.md` and `docs/program/guarantees-plan-review-20260914.md`: the original handoff supplies the full product scope, and the review supplies corrected semantics and the combined execution order. Read the current diff and start at M0 reconciliation without discarding completed work. Complete the outstanding original Phase 0–7 requirements as well as the applicable M milestones; do not report the whole task finished merely because M0–M6 are done. Use bounded Claude Code subagents only for disjoint work, then review their changes. Fix the reproduced contract defects and implement M1 acceptance semantics before activating controller enforcement. Preserve existing changes, the current license, and working task/worker/workflow support. Update the original progress table and harness status with exact source, tests, results, remaining gaps, and the next action after each milestone. Continue ordinary local implementation without repeatedly asking permission. Respect the separate boundaries for live API spending and external actions. Do not restart the broad audit, implement the mission daemon first, or stop after merely restating this plan.
