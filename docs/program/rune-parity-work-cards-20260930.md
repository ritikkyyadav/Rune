# Rune parity work cards

These implement the proposed order in
[the reviewed plan](rune-parity-review-20260930.md). Status on 2026-09-30: **planned**;
the review itself implemented none of these product changes. Start V1. All paths are
relative to the repository root; relocate symbols by name if line numbers move.

## Common execution contract

Read only this contract, the assigned card, its owning files and the relevant tests.
Inspect `git status --short` and HEAD first. Preserve other work, including the dirty
offline-corpus runner. Do not reset, stash, clean, blanket-stage, publish or change
`LicenseRef-Proprietary`. Do not remove the existing Gradle directories until ownership
is reconciled; fix their producer before any cleanup.

One behavioral change per patch. Normally touch 1–3 production files plus focused
tests. If a card needs more than about 250 changed production lines or a second new
abstraction, split it and record why. These are scope alarms, not targets to game.
Do not mechanically optimize line counts or weaken checks to pass.

For each card return: source fingerprint; change and reason; exact commands and
pass/fail/skip counts; remaining limitations; next card. Cap the prose at about 15
lines and link logs. An unsuccessful second repair attempt is the point to hand the
small evidence packet to a stronger reviewer, not start a third broad exploration.

The commands below are local checks, not authorization to run live comparisons.
Use a scratch home and `</dev/null` for tests. Use installed dependencies; do not fetch
new packages merely to validate a small patch. If a required check cannot run in the
environment, record it explicitly. Do not label it passed or globally disable isolation.

## V1 — honor the project's test script

**Executor:** lightweight. **Dependencies:** none. **Own:**
`packages/orchestrator/src/verifier.ts` (`jsChecks`),
`tests/unit/orchestrator/verifier.test.ts`, `verifier-detect.test.ts` as needed.

For a declared test script, dispatch through the detected package manager's script
runner. In particular use `bun run test`, preserving script arguments and setup.
Keep the scriptless raw-test fallback. Preserve monorepo root behavior and explicit
verification overrides. Never execute the contents of a script through extra quoting.

**Acceptance:** temporary Bun project declares only a passing `unit/` suite and also
contains an unrelated failing suite. Rune runs the declared suite and passes; the
old implementation fails. Include package-manager command-shape coverage. A mutant
replacing `bun run test` with `bun test` must fail the behavioral fixture.

```sh
bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/verifier.test.ts tests/unit/orchestrator/verifier-detect.test.ts </dev/null
```

**Stop boundary:** do not change timeout classification or gate behavior in this patch.

## V2 — verification can be inconclusive without buying a repair turn

**Executor:** ordinary coding model, strong review of semantics. **After:** V1.
**Split into V2a return types and V2b consumers.** Own verifier types/run method;
then the verification block of `agent-loop.ts`, `repair.ts`, `task-state.ts` and the
affected protocol event consumers identified by typecheck. Review that file list
before patching; do not migrate the controller simultaneously.

Define a canonical status plus structured reason. Passed means required checks ran
and passed; failed means a real negative check; inconclusive covers timeout, missing
runner, cancellation or no executable evidence. “No check required for this task”
is an explicit decision, not a successful check receipt. Keep a compatibility adapter
only while migrating consumers, never as a second authority.

**Acceptance:** a timed-out check yields an honest unverified result with no
`check_failed` repair or effort escalation; a real assertion failure still receives
bounded repair. Test authority empty and enabled, a pass followed by timeout, every
check skipped, abort before/within verification, and headless/UI terminal consistency.
Do not merely map timeout to missing dependency and rely on an off-by-default controller.

```sh
bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/verifier.test.ts tests/unit/orchestrator/verification-inconclusive.test.ts </dev/null
```

`verification-inconclusive.test.ts` is a **new** test file for this card. Add narrowly
chosen existing loop/repair suites after identifying the affected consumers. The
mutant “timeout gets a repair turn” must fail the loop test.

## V3 — select affected projects conservatively

**Executor:** ordinary model; lightweight model can implement individual cases.
**After:** V1/V2. **Own:** verifier selection helpers, `verifier-run-scope.test.ts`;
add `verify-scope.ts` only when a pure helper materially simplifies the existing code.

Start with owning-package and manifest-aware rules. Keep all legitimately affected
projects for cross-language code, generated inputs, build scripts and configuration.
An ordinary README may need no check; executable documentation or an explicit user
test command still does. Unknown ownership/dependencies use the project-level fallback.

**Acceptance:** isolated TS edit skips unrelated Rust checks; Rust edit keeps Rust;
shared schema/manifests exercise both when appropriate; nested package ownership
survives; removed files, renamed files and unknown formats do not silently evade checks.
Record selected commands and a selection reason. Do not add six ecosystem import
parsers in this card. If later adding graph-based selection, exhausted traversal must
widen safely instead of silently treating depth two as a complete dependency graph.

```sh
bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/verifier-run-scope.test.ts tests/unit/orchestrator/verifier-step-check.test.ts tests/unit/orchestrator/verifier-detect.test.ts </dev/null
```

## V4 — separate existing failures from new regressions

**Executor:** ordinary model, strong review of baseline identity. **After:** V2/V3.
**Own:** structured failure parsing, verifier attribution and narrow loop integration;
reuse the existing pre-task snapshot mechanism where possible. Share the baseline
contract with R1; do not build two different meanings of “before the task.”

On a real failure, compare only the relevant failing check against the immutable
pre-task tree, including user changes, with the same runner and environment. Cache
by source, check and environment fingerprints. Start with Bun/JS structured output
already handled by the miner rather than five new log parsers. Match test identity,
not exit code or a whole-file failure substring. A shared old failure does not excuse
a different new failure in the same file. Unknown parser/toolchain state stays unknown.

**Acceptance:** existing failure receives an explicit report without an unrelated
repair demand; a new failing assertion still gets repair; one old plus one new failure
is not dismissed; test rename, missing collection, changed dependencies, mutated
witness and stale baseline invalidate the shortcut. Final output still names existing
red checks and does not call the whole suite green. Add `verification-baseline.test.ts`.

At the batch exit, use a small fixed sample from the existing mined corpus: reference
fix, baseline plus tests only, known regression, missing environment and forced timeout.
Correct fixes must not be called failed, and known regressions must not become passes;
count inconclusive separately so it cannot manufacture oracle precision. Expand toward
20 representative fixes only after the small oracle is useful. Record wall time and
required-check coverage, not just a precision percentage.

## H1 — keep runtime artifacts outside user code

**Executor:** ordinary model, boundary review. **Own in separate patches:** mission
path/persistence in `engine.ts` and task-state consumers; verifier cache environment.

Persist the mission under the isolated session home. Keep a model-readable, narrowly
scoped route to that file; do not grant access to all of `RUNE_HOME`, credentials or
memory signing material. Migrate existing sessions without deleting user `.rune/`
content. Cargo/Gradle generated state goes to a per-run external cache only where the
runner supports it. Honor an explicit user cache choice.

**Acceptance:** two sessions in one repository cannot overwrite each other's mission;
compaction and resume still retrieve it; no newly generated mission/build directories
appear in the task tree; cancellations clean temporary state; a pre-existing user
directory is preserved. New targeted suite: `workspace-hygiene.test.ts`. Reuse current
mission/replay tests and verify sandbox access to the new mission path.

## H2 — respect explain, review and requested-output scope

**Executor:** strong design review, ordinary implementation. **Own:** task-scope
contract, G5 applicability in the loop, broker/tool integration in bounded patches.

Distinguish pure explanation (no writes), review to `REVIEW.md` (that output allowed),
and code changes. Use the trusted user contract; repository text cannot widen it.
First ensure G5 and prompts do not demand test files on a no-code request. For hard
enforcement, cover shell writes as well as edit tools; give reproductions a scratch
area and only the requested artifact a controlled return path. A prompt-only rule is
not an enforced boundary. No blanket “no new files” that prevents the requested report.

**Acceptance:** review writes its report and no code/tests; pure explain leaves the
tree unchanged; mixed requests keep explicitly authorized edits; shell and edit tools
obey the same policy; user dirty/untracked data remains byte-identical. Add
`task-scope.test.ts` and integration cases. Treat enforced scope as incomplete until
the shell case passes. Keep the benchmark's scope contract aligned with this behavior.

## P1 — remove contradictory instructions and measure overhead

**Executor:** lightweight. **After:** V1–V4. **Own:** narrow text changes in
`orchestrator/src/{brief,prompts}.ts`, `tool-registry/src/skills/loader.ts`, and relevant
prompt-budget tests. Confirm existing wording first; several original proposals are
already satisfied.

Reserve planning for complex work; remove unnecessary invitations to call bookkeeping
tools repeatedly. Keep skills/tools discoverable when needed. Do not globally remove
web verification from questions involving current facts. Preserve the fixed behavioral
contracts while shortening repeated instructions. Defer changing loaded tool schemas
until this text-only patch is measured.

**Acceptance:** existing prompt-budget/doctrine tests; a small scripted easy task uses
no newly mandatory bookkeeping calls; complex and weak-model fixture behavior remains
intact. Snapshot system/tool-schema bytes, calls by role and refusal reasons before and
after. Reuse `scripts/overhead-report.ts` with an explicit benchmark `--db` and new
`--out`; never let it default to a broad personal-session audit. Cache-hit improvement
requires repeated actual measurements and does not follow just from shorter text.

## M1 — make the score mean what the plan says

**Executor:** strong contract review, then small ordinary-model patches. **After:**
review now; may be implemented independently of verifier work. **Own:**
`tests/eval/parity/{types,run-pairs,score,aggregate,report,bootstrap}.ts` and
`docs/program/parity-index.md`, split by the following three changes.

1. Add coding-task scope and protected-path contracts; test unrelated tracked edits,
   dirty/untracked preservation, expected output files and legitimate test additions.
2. Define terminal categories and absolute outcome/coverage statistics. Report
   both-zero and unscored attempts; distinguish partial outcomes from complete tasks.
   Crashes and unverified success cannot become clean completion. Keep the old relative
   PI visible and labeled when changing denominators or quality rules.
3. Record grader/task/configuration/model fingerprints and reject incomparable
   evidence by default. Separate within-task uncertainty from task-level uncertainty;
   do not silently change the existing interval or thresholds.

**Acceptance:** tests where equal partial quality looks relatively good but absolute
success is poor; both-zero pairs; missing and mismatched graders/models; a successful
answer with scope violation; an honest incomplete answer versus crash. A report made
only of exclusions never passes. Version schema changes and preserve old reports.

```sh
bun test --preload ./tests/scratch-home.ts tests/unit/eval/parity-score.test.ts tests/unit/eval/parity-report.test.ts tests/unit/eval/parity-bootstrap.test.ts tests/unit/eval/parity-run-pairs.test.ts </dev/null
```

## M2 — one runnable manifest, with a budget before the first pair

**Executor:** ordinary model, budget-contract review. **After:** M1 contract frozen.
**Own:** paired CLI, task-source composition and focused pair-series tests.

The current CLI reads one corpus directory; it does not compose F7 or the supplement
by itself. Reuse `corpusParityTasks()` and `seriousTasks()` in a manifest with selected
IDs, family counts, immutable grading inputs, arms, versions/settings and randomization
seed. Avoid duplicate loader implementations. Persist the manifest before execution.

Add maximum pairs/attempts and wall allowance plus a preflight quota/reserve record
for each account. Check before the first pair and before the next arm. Missing meters
require an explicit bounded mode and truthful limit labeling. A guessed next-run cost
cannot be advertised as an exact spend cap. Preserve stopped and half-pair evidence;
do not rerun the successful arm automatically when filling a missing partner without
first checking whether the conditions are still comparable.

**Acceptance:** fake arms prove counts, alternation, max attempts, unknown meters,
99%-used first-pair refusal, each account's reserve, cancellation between arms, and
source drift. Dry-run prepares no workspace, makes no model call and shows all 48
available tasks or the selected subset with correct families. No scheduled task here.

```sh
bun test --preload ./tests/scratch-home.ts tests/unit/eval/parity-run-pairs.test.ts tests/unit/eval/parity-fairness.test.ts tests/unit/eval/comparator-series-budget.test.ts </dev/null
bun node_modules/typescript/bin/tsc --noEmit -p tests/eval
```

## B1 — small paired checkpoint, after a concrete manifest exists

**Executor:** operator plus analysis model. **After:** A–C and frozen builds.

Choose three diagnostic tasks before running: one small fix, one no-code task, one
serious task implicated by verification overhead. Start with one repetition. Capture
raw envelopes and per-role usage, including supervisor/children/retries. Use independent
grading and preserve all stops. Do not describe three pairs as seven-family parity.

For causal improvement, compare the previous frozen Rune build with the new one under
the same configuration; for competition, compare the new build with Claude Code or
OpenCode. These answer different questions. Reuse comparator observations only if the
full manifest, grading, version and environmental assumptions match; otherwise rerun.

**Acceptance:** real envelope parsing works, exact model roster is recorded, no grade
override is needed, and each claimed improvement has a matched observation. If a
correctness failure appears, fix it before spending quota on repetitions. Record the
sample as diagnostic/provisional. The founder chooses the actual account/run allowance;
“limits are normal” alone is not a numeric benchmark budget.

## R1 — causally valid parent replay

**Executor:** strong model for baseline/witness design; ordinary model for isolated
implementation pieces. **After:** V2 and an observed need for new-test causal credit.
**Own:** `parent-check.ts`, the `record_evidence` closure in `engine.ts`, focused tests.

Capture the immutable pre-task tree including dirty content. Run the same pinned test
witness against it and the candidate. Overlay allowlisted test inputs only. Separate
assertion failures from absent imports, missing runners, no tests, malformed output
and timeouts. Cache only by baseline, witness and environment fingerprints; changing
the witness invalidates prior credit. Never replay arbitrary model commands with
ambient credentials or writable shared dependencies.

**Acceptance:** genuine new regression test can qualify; copied production fix,
forged command/output, missing baseline module, test mutation and changed lockfile do
not earn credit; cancellation cleans the sandbox; pre-existing dirty changes are in
the baseline. Keep original anti-forgery tests. Do not remove absence protections.

```sh
bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/parent-check.test.ts </dev/null
```

## T1 — finish resilience work that has not already landed

**Executor:** ordinary model, strong shutdown/recovery review. **Own in separate
patches:** run-level transport deadline; CLI signal handling; resume projection.

Do not redo the shipped header parsing/cooldown/Anthropic retry fixes. Add a total
outage deadline using monotonic elapsed time, bounded backoff and a resumable terminal
state. Test retry stacking across layers. Honor known reset times and abort promptly.
SIGTERM must cancel streams, preserve acknowledged progress and reap child groups;
hard termination is a bounded fallback after checkpoint effort.

**Acceptance:** scripted provider stall reaches deadline; user cancellation does not
become an outage retry; reset resumes once; signal exit ≤10 s with no orphan groups;
resume neither loses an acknowledged write nor duplicates a non-idempotent tool action.
Use fake providers/fake clocks and process fixtures, not live provider outages.

## G1 — one controller-owned refusal budget

**Executor:** strong design/review. **After:** V2, P1 and B1 showing residual gate waste.
**Own:** one existing authority path and a small pure policy helper, if needed.

Choose the largest observed source of wasted retries. Keep the old behavior available
behind a flag; migrate one decision and then remove its duplicate counter only after
replay equivalence. A task's risk and available evidence determine completion; model
tier only changes optional help. No safety/permission bypass for a frontier model.

**Acceptance:** composed trigger cases obey the shared budget, cancellation wins,
acceptance cannot be bypassed, late child writes invalidate checks, no-code requests
do not acquire write obligations, and weak-model regression fixtures retain outcomes.
Do not enable four new authorities or delete G1/G2/no-progress logic in one patch.

## P2 — deeper prompt/tool/cache economy only when attributable

**Executor:** ordinary model, strong review of tool-discovery omissions. **After:** P1
and measurements. **Own separately:** cache-key caller wiring, stable prompt ordering,
optional tool-schema deferral. The provider already accepts `cacheKey`; reuse it.

Use a stable session identifier across resumed calls without allowing cross-user
collisions. Keep stable instructions before changing task state; preserve current
provider message/tool pairing. Defer tools only when discovery remains reliable for
the task. Measure before/after with the same model, effort, inputs and provider
conditions; disclose cache warmup. Do not promise a 70% cache rate across providers.

**Acceptance:** deterministic prompt-layout tests, unchanged completion/acceptance
fixtures, per-role call/token attribution and a bounded live A/B if warranted. A
smaller system prompt that needs more recovery calls is not an efficiency improvement.

## B2 — held-out breadth, installed artifact, and claim readiness

**Executor:** ordinary executor; independent strong review of the final claim.
**After:** demonstrated improvement and remaining regressions resolved.

Freeze tasks, graders and thresholds. Retain all seven families and add a compact
lifecycle reliability matrix. Validate browser behavior separately from aesthetics;
give review tasks false-positive controls. Add an external-repository holdout only
after the existing tasks are useful. Do not teach the executor held-out fixes.

Use the existing ≥6 pairs over ≥3 tasks per family as an initial screening minimum,
not broad statistical certainty. Keep evidence for different builds/models separate.
Report absolute success, exclusions, PI components and uncertainty. A parity claim
requires all required families PASS; PROVISIONAL stays visibly provisional. Run direct
OpenCode comparisons before claiming superiority to OpenCode. A released build need
not make a parity claim.

At the final combined-tree boundary, run the repository's relevant full gates:

```sh
bun test tests/unit </dev/null
bun test tests/integration </dev/null
bun run typecheck --force
bun run lint --force
cargo test --locked --workspace
bun run eval
```

Run the offline corpus with an explicitly fresh output after reconciling its current
dirty implementation and CLI usage. Then use `bash scripts/install.sh` and a fresh
shell to verify `rune --version`, `rune doctor`, and `rune tools-smoke`. Record source,
binary hashes, platform and actual skipped checks. No publishing is implicit here.

## Reusable prompt for a lightweight executor

> Read the common execution contract and card V1 in
> `docs/program/rune-parity-work-cards-20260930.md`. Implement V1 only. Preserve the
> existing dirty files and current license. Read the named functions and tests rather
> than restarting the broad audit. Reproduce the script-selection bug, make the
> smallest fix, and run the named checks. Do not run provider benchmarks, install,
> publish, or begin V2. Return the diff summary, exact test results, remaining limits
> and next card. If two repair attempts fail or scope grows beyond this card, return
> a compact escalation packet.

Use the same prompt with a different card ID when advancing. Strong review is scoped
to the named invariant; it is not permission to expand into another audit.
