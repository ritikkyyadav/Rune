# Rune parity: reviewed evidence and revised execution plan

Reviewed 2026-09-30 at `2adf1d9bb37fe3c63ffece3574727c4779c47580`, branch
`gear/phase-0-stabilize`. This is a proposed execution order and an independent
review, not a claim of competitive parity or authorization to launch benchmarks.
The founder subsequently said usage limits are normal again. Keep the work efficient;
there is no need to ration the review to an assumed remaining percentage.

**Recommendation:** retain Claude's measurement infrastructure and reliability work.
First correct verification that creates unnecessary repair work, then scope and
prompt overhead. Defer the broad controller migration until those changes have been
measured. Give a lightweight executor one bounded work card at a time; use a stronger
reviewer for changes to completion, permissions, parent replay, and recovery.

The original plan is
`~/.claude/plans/so-now-create-an-giggly-lampson.md` (459 lines, “Rune Parity Program”).
Its hash and the observations below are preserved in
[the evidence ledger](../evidence/planning-review-20260930.json).
[The work cards](rune-parity-work-cards-20260930.md) make this proposal executable.
Older product requirements in [the handoff](../CLAUDE_CODE_HANDOFF.md) remain relevant;
their dated snapshots are not the current baseline.

## 1. What the comparison actually establishes

The historical pilot supports a real efficiency problem. It does **not** establish
“Rune is 65% as capable as OpenCode,” nor any current score against Claude Code.

I located the September 28 pilot's raw reports and the `tally.py` used to summarize
them. These are historical observations, not new model runs:

| View of the small-task records             | Rune                               | OpenCode                 | Interpretation                                                                                                              |
| ------------------------------------------ | ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Raw reports, all included pilot/rerun rows | 21 successes / 24 scored; 26 total | 19 / 23 scored; 24 total | Raw classifications include disputed outage and grader cases                                                                |
| Existing tally's adjusted view             | 23 / 23                            | 21 / 21                  | Reclassifies timeout rows overlapping an outage interval and marks scored `cache-plan` rows successful under a lenient rule |
| Raw pairs where both succeeded             | 18 paired observations             | Same 18                  | Median Rune/OpenCode: time **1.50×**, list-cost estimate **1.90×**, ledger entries **1.70×**                                |
| Adjusted paired view from existing tally   | 20 paired observations             | Same 20                  | Median ratios: time **1.69×**, list-cost estimate **2.06×**, ledger entries **1.85×**                                       |

Both views must remain visible. The adjustments may be justified, but changing a
grading rule requires rerunning the same revised grader on both saved artifacts,
with old and new verdicts retained. A Python override of `success` is not that regrade.
Repeated attempts and a pilot are included; these counts are not independent tasks.

The serious-task records contain four pairs across three tasks, including a repeated
TOML task. Their list-cost ratios range from **1.57× to 6.96×**, and wall-time ratios
from **1.42× to 4.47×**. `missions-race` has matching recorded hidden/regression passes;
other raw grade strings include failures. I did not independently rerun the original
environmental exclusions, so “zero regressions everywhere” is not newly certified.

Rune's recorded model lists contain **both GPT-6 Sol and GPT-6 Astra**; OpenCode's contain
GPT-6 Sol. This can describe shipped product behavior, but is not a strictly
single-model experiment. Provider routes and auxiliary calls also matter. List-price
estimates and call counts are useful diagnostics, not subscription invoices or exact
quota consumption.

**Conclusion:** Rune demonstrated useful task completion on these narrow cases while
spending considerably more work. “65” is an informal summary, not a score produced by
the current Parity Index. The new Claude Code comparison remains unmeasured in the
evidence reviewed here. The original plan's projected movement to 95 is a hypothesis.

## 2. What Claude has actually delivered

| Original item                               | Current verification                                                                                                         | Next action                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P0.1 Claude subscription sign-in retirement | Source and focused compliance tests present and passing                                                                      | Preserve; do not redo auth work under this plan                                                     |
| P0.2 arm fairness and isolation             | Shared classification, isolated Claude profile, Rune arm, paired runner; focused tests pass                                  | Capture a bounded real smoke pair when scheduled and funded; synthetic envelopes are not live proof |
| P0.3 scorer and bootstrap                   | Implemented, documented, tested                                                                                              | Correct the measurement gaps below before treating its PASS as a product claim                      |
| P0.4 serious miner                          | 30 task specs load; miner, grader, source and leak-check unit tests pass                                                     | Reuse this corpus; no second miner or broad remine                                                  |
| P0.5 task coverage                          | 18 small tasks across corpus/supplement, three per F1–F6; 30 F7 tasks; corpus sanity wired in CI source                      | Compose these sources in one reproducible runner manifest                                           |
| P0.6 quota meter                            | Codex response capacity and fuller-window reporting implemented; focused tests pass                                          | Add preflight/reserve rules; current series gate does not bound the first pair                      |
| P0.7 Claude baseline                        | No completed baseline established by this review                                                                             | Still open; do not infer it from OpenCode results                                                   |
| P1 verification corrections                 | Main issues remain in current source and local probes                                                                        | Highest priority                                                                                    |
| P2 proportional governance                  | Controller exists; authority defaults empty; proposed `governance.ts` is absent                                              | Migrate one decision after evidence, not all gates together                                         |
| P3 prompt/cache                             | Codex accepts a caller-provided cache key; per-instance fallback still exists; some prompt rules already match the proposal  | Audit wiring and remaining overhead; avoid rewriting completed pieces                               |
| P4 provider resilience                      | Reset parsing, known-reset cooldown, `infer()` handling, Anthropic `maxRetries: 0`, selected-Vertex metadata probing present | Test remaining run deadline, cancellation and resume behavior separately                            |
| P5 workspace hygiene                        | `.rune/mission.md` still written under the workspace                                                                         | Implement with scoped read access and session separation                                            |
| P6/P7 routing and continuous gate           | Not established as implemented or validated here                                                                             | Defer automation and release claims until trustworthy baseline evidence exists                      |

Current independent verification: **390 tests passed, two browser tests skipped, zero
failures**, across 19 focused files; `tests/eval` TypeScript check passed. The skips are
the supplement's browser solution/wrong-variant checks without a configured browser
runtime in this test invocation. Recent committed browser evidence exists, but was
not rerun here. These checks do not certify the full workspace, all 30 historical
base/fixed executions, installed binaries, or hosted CI.

The working tree already contained changes to `tests/eval/corpus/run-offline.ts`, an
untracked TUI capture script, and Gradle-generated directories. They were preserved.
This review changes documentation/evidence only.

## 3. Findings that change the plan

### A. Correct verification before reducing verification

The following were reproduced against current functions in temporary fixtures:

| Finding                                     | Reproduction                                                                                                           | Source anchor                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Project script bypass                       | `scripts.test = "bun test unit"` passes directly; detected `bun test` also runs a deliberately failing unrelated suite | `verifier.ts`, `jsChecks`                                                       |
| Timeout treated as task failure             | A 30 ms verifier deadline returns `passed:false`, `ran:true`, `timedOut:true`, with no tri-state result                | `verifier.ts`, `CommandVerifier.run`                                            |
| Shared-root checks too broad                | In a JS/Rust root, touching either `app.ts` or `README.md` selects both ecosystems                                     | `verifier.ts`, `projectsForRun`                                                 |
| General coding scope not enforced by scorer | Changing a tracked `unrelated.ts` in a coding task receives scope 1                                                    | `run-pairs.ts`, `scoreScope`; `ParityTask` has no general allowed-path contract |
| First pair bypasses quota stop              | `pairsRun:0`, reported usage 99%, stop threshold 90% returns no stop                                                   | `run-pairs.ts`, `gateBeforePair`                                                |

The loop sends failed verification back as “failed after your changes” and can buy
another repair turn. Existing nearest-project scoping already works in other cases;
the remedy is not to rebuild all project detection. Correct the specific shared-root
selection and runner dispatch defects.

Carry `passed / failed / inconclusive` through the verifier, loop, events and evidence.
Timeout, cancellation, missing runner and absent coverage are distinct reasons; none
may silently become a positive test receipt. A deterministic assertion failure must
still trigger bounded repair. Check inconclusive handling with controller authority
both absent and enabled—the old plan routes through a path whose default authority
is off, so changing only the classifier is insufficient.

Do **not** implement “extension matches ecosystem” as the whole impact algorithm.
Manifests, lockfiles, generated bindings, build scripts, CI configuration, Markdown
code tests and shared schemas can affect another ecosystem. Unknown dependency
relationships fall back to the owning project. A depth-two import graph cannot
silently drop deeper importers. Start with owning-package checks; add a graph only
if the measured remaining cost warrants it.

### B. Preserve evidence semantics while repairing parent replay

The current parent checker creates a worktree and synchronously reruns the command
without copying a newly written regression test. Its rejection of an absent test or
import is intentional and important. Existing runnable checks can satisfy G5; the
problem is the advice to write a new test while that path cannot earn causal credit.

The new baseline must represent the **pre-task tree, including user changes**, not
blindly `HEAD~1`. Pin an immutable test witness and execute the same witness against
baseline and candidate. Copy only reviewed test inputs, never the agent's production
fix into the baseline. Missing imports, zero collected tests, timeout and changed
dependencies remain inconclusive. Do not share writable dependency state with the
user checkout. Make cleanup cancellation-safe. This is a stronger-model design/review
task, not a cheap file-copy ticket.

### C. Make governance proportional to evidence and task risk

The old plan simultaneously introduces model tiers, task risk, a new matrix, several
default controller authorities and removal of multiple legacy branches. That makes
failures hard to attribute and is too large for a lightweight executor.

First remove contradictory or repeated guidance. Then introduce one flag-controlled
refusal budget through the existing controller. Migrate and compare one authority
at a time. Model strength may change hints or repair allowance; it must not change
permission boundaries, treatment of failing acceptance, truthful completion, or
preservation of dirty work. Unknown models keep conservative behavior. Retire legacy
code only after replay and adversarial cases establish equivalent behavior.

Use lower complexity as an outcome. A line-count target such as 5,900 is not an
acceptance test: moving code between files does not demonstrate better coordination.

### D. Repair benchmark interpretation before relying on its number

Keep the existing PI for continuity, with a versioned change record rather than silent
retuning. Add the following alongside it:

1. **Absolute outcomes:** complete-task rate, runnable coverage, regressions, scope
   violations and false completions per arm. `O=100` can mean equally poor outcomes.
   The current scorer excludes pairs where both quality values are zero; report
   those in the absolute denominator even if the relative calculation retains its
   historical exclusion. Partial credit is diagnostic, not full task completion.
2. **Scope contracts for coding tasks:** allowed/protected paths, expected deliverables
   and preserved dirty files. The current no-code check is useful but does not
   implement the plan's general “inside allowed paths” definition.
3. **Terminal truth:** `isClean` currently considers stopping, time and false completion,
   but not exit status. Define structured completed/incomplete/crashed outcomes
   explicitly. A crash must not become “clean” merely because it ended quickly.
4. **Coverage provenance:** task, fixture, grader, source/binary, configuration,
   provider, all models and effort fingerprints. Freeze every arm, not only Rune.
   A model-family name or aggregate `modelGap` does not identify the source of a gap.
5. **Honest uncertainty:** the current 80% bootstrap resamples runs within fixed tasks.
   It does not measure generalization across repositories. Three tasks and six pairs
   are a screening minimum. Public broad claims need diverse held-out tasks and
   task-level uncertainty, preferably a preregistered 95% interval. Label both
   intervals if the old one remains for continuity.
6. **Matched denominators:** impossible checks must be pinned before runs or reconciled
   symmetrically with reasons; unscored outages remain visible, including consumed
   time/quota. Do not turn outages into capability failures or hide their operational
   effect. Report cost/time over all attempts as well as jointly successful pairs.

The old plan contradicts itself: its central gate requires all families to PASS,
while its release section allows PROVISIONAL. Keep product release readiness separate
from a parity claim. A release may ship with clearly unmeasured parity; **a claim of
validated parity requires every required family to PASS**. Provisional is not a pass.

### E. Compare directly with both competitors

Run Rune–Claude Code for the aspirational product target and Rune–OpenCode for the
specific claim of outperforming OpenCode. Neither result implies the other. Use
identical tasks, fixtures, grading, machine conditions and recorded budgets.

For attribution, compare one model and effort with auxiliary model use matched or
explicitly accounted for. Product mode should retain shipped defaults, including
their real overhead. If controlled mode is good but product mode is poor, investigate
model, provider, prompting, tools and their interactions; it is not proof of a purely
model-bound gap. Better retrieval and verification can improve outcomes even when
the competing base model is stronger.

Current official guidance supports compact task context, concrete verification and
selective planning; it does not establish a numeric ranking. See
[Claude Code best practices](https://code.claude.com/docs/en/best-practices).
OpenCode documents primary/subagent roles and tool permissions; treat these as
reference behavior and pin the evaluated version, not as proof of task success.
See [OpenCode agents](https://opencode.ai/v2/docs/agents) and
[permissions](https://opencode.ai/v2/docs/permissions).

## 4. Execution order and decision gates

| Batch                                          | Work cards        | Purpose and exit                                                                                                                                                  |
| ---------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: remove demonstrated waste                   | V1 → V2 → V3 → V4 | Correct script dispatch, inconclusive verification, conservative project selection and baseline failure attribution; reproduce old failure and prove new behavior |
| B: preserve scope and reduce unnecessary calls | H1 → H2 → P1      | Session artifacts outside user code; no-code task contract; remove conflicting prompt instructions; record overhead before/after                                  |
| C: make comparisons trustworthy                | M1 → M2           | Absolute metrics, scope/terminal contract, composed manifest, quota preflight, reproducible reports; offline fake-arm tests first                                 |
| First live checkpoint                          | B1                | A small frozen candidate series after A–C; if an old-binary comparison is affordable, keep it separate as the baseline                                            |
| D: remaining measured causes                   | R1, T1, G1, P2    | Parent replay, outage/shutdown, controller migration and deeper prompt changes; select by observed failure/cost, not calendar                                     |
| E: prove breadth                               | B2                | Held-out serious, frontend, long-horizon and weak-model validation; final installation and release evidence                                                       |

Measurement contract work can be prepared while A is underway, but use one executor
per shared file. Do not hold the already-reproduced V1 fix behind a multiweek baseline
campaign. Before changing behavior, save a source/build fingerprint and the offline
repro; do not label the historical 1.3.1 pilot as the current baseline.

Retain the seven task families. Add a small cross-cutting reliability matrix:
compaction plus restart after acknowledged work; interrupted child integration into
a dirty tree; resumed quota outage; partial tool execution; cancellation and terminal
reporting. These validate the lifecycle advantage Rune aims to have. They are not
replacement task families or points awarded for possessing a feature.

Frontend acceptance must include a real browser at desktop/mobile sizes, keyboard
flows and visible error/loading states. Current structural checks do not establish
visual design quality. The review task currently does not penalize false findings;
add a negative control before claiming high-quality code review. Keep public training
fixtures apart from holdouts, with at least one external repository when broadening.
The miner's lexical leak checker does not eliminate familiarity with Rune's own fixes.

## 5. Targets without invented score gains

Use these as proposed engineering targets, not forecasts:

- **Correctness:** no lost user work, silent scope violation, forged evidence or false
  completion in the fixed offline regression matrix. Every known failure retains a
  reproducer. No weakening of an acceptance check to save calls.
- **Efficiency checkpoint:** unchanged complete-task rate on a fixed development
  sample; median verification wall time and unnecessary repair calls materially lower.
  A 30% verification-time reduction is a useful initial target, not guaranteed.
- **Competitive candidate:** PI 80–89 is visible progress, with weak families named.
  It is not readiness or a percentage of general intelligence.
- **Parity candidate:** retain PI ≥90, O ≥95, E/R/S ≥70 and the existing minimum
  evidence requirements; additionally report absolute complete-task rate. Proposed
  broad-claim floor: at least 80% absolute complete-task success per family, zero
  observed critical integrity failures, and task-level uncertainty disclosed.
  Freeze these additional rules before a claim-bearing evaluation.
- **OpenCode advantage:** demonstrate the direct comparison, including quality,
  latency, resource use and scope. Do not infer it from the Claude Code PI.

With O=R=S=100 and E=70, the current composite is **92.5**. That is why “PI 90” is
not “90% on every dimension.” Publish the component values and sample sizes with it.

## 6. Budget and lightweight-model execution

Normal quota removes the need for a forced tiny session. It does not make repeated
audits or broad speculative rewrites useful. Keep development, review and benchmark
budgets separate. Subscription windows, API dollars and measured model tokens are
different units; do not convert them using an invented exchange rate.

- Default: one executor, one card, one concise context packet. No automatic fan-out.
- Use an available low-cost/Copilot model for bounded changes with deterministic
  acceptance. This is an assignment strategy, not a claim that a named model will
  succeed. Escalate after two unsuccessful patches or when the card crosses a
  completion, permission, replay or recovery boundary.
- Give the strong reviewer the diff, reproducer and results, not the whole session.
  Review design before the risky card; review behavior after it. Avoid a fresh
  architectural audit for every commit.
- Run focused tests after each patch. Run the combined relevant suites, typecheck
  and lint at a batch boundary. Run the full release gates once on the final tree.
  Do not repeat all Rust/UI/integration tests for each documentation or prompt edit.
- Mutation checks are required for important invariants and evaluator rules, not
  every comment, rename or copy change. Prefer one convincing adversarial case over
  a large family of tests that repeat the implementation.
- Keep a brief completion record: fingerprint, files, tests, result, limitation,
  next card. Read the ledger and assigned card on resumption; avoid rereading hundreds
  of pages of historical audits.

For a diagnostic live checkpoint, start with **3 pairs / 6 agent executions**, then
add two repetitions only if useful and budgeted. One pair can occupy up to 40 minutes
on a small task or 90 minutes on a serious task under the current limits. A minimum
seven-family evaluation is **42 pairs / 84 executions**, before retries. It cannot
honestly be promised to fit one five-hour quota window. Both accounts need reserves;
the present meter only observes Rune's reported window.

A manifest must name the selected tasks, arm order, per-arm wall limits, maximum
pairs, retries, model/settings versions and budget. Check remaining headroom before
the first pair and before each next arm. If no reliable quota meter exists for an arm,
use an explicit small run limit and operator-supplied reserve; do not claim a hard
percentage cap. The current dollar predictor also cannot guarantee a ceiling on an
unobserved next run. Interrupt with a resumable receipt when the authorized bound is
reached; retain incomplete pairs and reasons.

Use on-demand batch checkpoints initially. Weekly scheduling, signed publication,
new model shopping, more mining and a large framework rewrite can wait until the
measurements are useful. No automation or provider call was created by this review.

## 7. Definition of completion for this proposal

The review is complete when this plan, its bounded cards and its evidence are
available for execution. Implementation remains future work. The harness improvement
is complete only after its fixes pass on the combined tree, the installed artifact is
checked, and frozen comparisons establish the stated outcome within the stated scope.
Do not upgrade “implemented,” “unit tested,” “installed” or “compared” into one another.

Start with **V1** in the work cards. It addresses a reproduced defect, has a small edit
surface, requires no model benchmark, and removes a direct source of unnecessary work.
