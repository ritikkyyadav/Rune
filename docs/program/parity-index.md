# The Parity Index — how Rune is scored against Claude Code

Written 2026-09-28 (parity program, lane L0-C). This is the rule the founder's release gate
reads. The arms write `ParityRunResult` rows (`tests/eval/parity/types.ts`, the frozen
contract) into `results.jsonl` files, and the scorer turns them into one number per task family
and one status. Change a rule here and you change what the gate means. Every change goes in
**Changes** at the foot, dated, with the reason.

Code: `tests/eval/parity/score.ts` (pure scorer and gate), `bootstrap.ts` (pure, seeded),
`aggregate.ts` (reads and validates rows, forms pairs, checks comparability), `report.ts` (CLI
and renderers), `run-pairs.ts` (writes the rows). Tests:
`tests/unit/eval/parity-{score,bootstrap,report,run-pairs,fairness}.test.ts`, fixtures in
`tests/fixtures/parity/`.

Rows are `parity-run/2`. A `parity-run/1` row is old evidence and stays readable, on its own
and under an override (see **Comparable evidence**).

## Pairs

- A **pair** is two arms' rows with the same `(task, run, mode)`. The headline comparison is
  arm `rune` against arm `claude-code`. `--comparator opencode` makes OpenCode the comparator.
  Rows from any other arm are ignored and counted (`otherArmRows`).
- A pair where **either row is unscored** (`scored: false`) is excluded and counted in
  `unscoredPairs`. An outage on one side is not a failure of that side.
- `q = quality(outcome)` from `types.ts`. A pair where **either q is null** (no runnable
  hidden check) is excluded and counted as `noHiddenChecks`.
- A pair where **both q = 0** is excluded, and its task is flagged **too hard**.
- A row with no partner (`unpaired`) is not scored. It is listed per side, named in the
  report's reasons, and caps its family at PROVISIONAL (decision 6).
- **The latest attempt counts.** A row may carry `attempt` (absent means 1). An arm whose row
  came back unscored is retried once, alone, under the same run number as `attempt: 2`; the
  pair is formed from each arm's latest attempt. An earlier attempt stays in the file as
  evidence, is never scored, and is still counted among that arm's attempts. Two rows with the
  same (mode, arm, task, run) **and** the same attempt are refused.

Excluded from the index is not excluded from the report: every row above, the both-zero pairs'
and the partnerless ones included, is counted in **Absolute outcomes**.

## Axes, per family f (R = Rune, C = comparator)

- **O (outcome)** = 100 · min(1, mean q_R / mean q_C). If mean q_C = 0 and mean q_R > 0, O = 100.
- **E (efficiency)** = 100 · min(1, G), where G is the geometric mean, over the pairs where
  **both** arms succeeded (q = 1), of
  (wall_C / wall_R)^a · (calls_C / calls_R)^b · (cost_C / cost_R)^c.
  - Product mode: a = 0.5, b = 0.5, c = 0. Harness mode: a = 0.4, b = 0.3, c = 0.3.
  - If calls or cost is missing on either side of a pair, that factor is dropped for that pair
    and the remaining exponents are renormalised to sum to 1.
  - With fewer than **4** both-succeeded pairs, E = null ("insufficient") and the family can
    be **PROVISIONAL at best**.
- **R (reliability)** = 100 · min(1, cleanRate_R / cleanRate_C), from the `clean` flag (see
  **How a run ended**). If cleanRate_C = 0, R = 100 · cleanRate_R.
- **S (scope)** = 100 · min(1, mean s_R / mean s_C). If mean s_C = 0, S = 100 · mean s_R.
- The **uncapped** ratios (mean q_R / mean q_C, G, cleanRate_R / cleanRate_C, mean s_R /
  mean s_C) are reported as **advantages**. 1.00× is parity. An advantage is null where the
  comparator's figure is 0 (the ratio is unbounded) or E is insufficient.

### Scope, per run (s)

Measured from two `git status` snapshots of the workspace, before the run and after it, never
from what the tool said it touched (`run-pairs.ts`, `scoreScope`).

- **0**: on a no-code task, any path other than the files it asked for was created, modified
  or deleted. On a coding task, any of:
  - **protected**: a path the task's own words put out of bounds has different bytes
    (`protectedPaths`). Staging the file, or committing it as it stood, is not a change to it.
  - **lost**: uncommitted work that was in the tree (a modified tracked file, an untracked
    one) was reverted or removed and is in no commit the run made.
  - **outside**: the task declared the paths its work may change (`allowedPaths`) and an
    existing file outside them was modified or deleted. A file the run created is never
    outside: a new test or a new module is the work.
- **0.5**: new ignored or untracked leftovers (tool state, build output, logs).
- **1**: otherwise.

"Lost" and "outside" never apply to a path git ignores, to an untracked leftover that was
already there, or to the tool's own state directory. A task without `allowedPaths` has no
declared boundary and none is enforced (see Changes, 2026-10-04).

### How a run ended (`terminal`), and `clean`

Every row says how its run ended, from the same neutral facts the one classifier reads
(`terminalOf`, beside `classifyOutcome` in `tests/eval/comparison/arms/types.ts`):

| `terminal`    | What happened                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`   | ended by itself and reported success                                                                                                                             |
| `incomplete`  | ended by itself and reported that it had **not** finished: its own turn or budget ceiling (or the rig's cost watcher standing in for one), or its own named stop |
| `stopped`     | the rig ended it: the wall clock, or any other kill                                                                                                              |
| `crashed`     | ended without saying how: the process died, or its report held only an error                                                                                     |
| `refused`     | the provider refused the run (quota, auth, outage); the row is unscored                                                                                          |
| `not_started` | the tool never ran; the row is unscored                                                                                                                          |

**`clean`** is: `completed` or `incomplete`, inside the wall limit, with no false completion.
An honest "not finished" is clean; a crash never is, however quickly it ended. A false
completion is a success claim (`completed`) on work the grader found short (q < 1).

The validator refuses a row whose flags contradict its ending (a crash that is clean, a false
completion with no claim, a refused run that is scored).

## Absolute outcomes

Every axis is a ratio, so none of them can say how good either tool was: two arms that each
pass half of every task score O = 100. Beside the index, and never folded into it, the report
counts what **each arm** did over **all** its attempts in a family — scored or not, paired or
not, in a both-zero pair or not (`absoluteStats`):

- `attempts`, `scored`, and `unscored` by reason, with the wall time unscored attempts used
- `gradable` (scored, with at least one runnable hidden check) and `unverified` (scored, none)
- `complete` (q = 1), `partial` (0 < q < 1), `zero` (q = 0), and **complete rate** =
  complete ÷ gradable
- `cleanComplete`: complete, **and** the run ended clean, **and** nothing out of scope
- `regressions`, `buildBroken`, `scopeViolations` (s = 0), `leftovers` (s = 0.5),
  `falseCompletions`
- `terminal`: how the runs ended (`unrecorded` for a `parity-run/1` row)
- wall time and list cost over every attempt

Only `complete` is a finished task. Partial credit is diagnostic. A run nothing could check is
`unverified` and is never counted complete, whatever the tool said about it.

**Caveats.** Where the counts contradict the impression the ratios give, the family carries a
line saying so: a relative O at or above 95 while Rune completed under 80% of its gradable
attempts ("parity at a low level" when the comparator is under it too); attempts out of scope;
complete attempts that were not clean completions; false completions; crashes. **A caveat
never changes a status.** The 80% figure is the review's _proposed_ floor for a broad claim
(`PROPOSED_COMPLETE_RATE_FLOOR`); it is not part of the gate until the founder makes it one.

## The index

PI_f = 0.40 · O + 0.25 · E + 0.20 · R + 0.15 · S.

If E is null, PI_f = (0.40 · O + 0.20 · R + 0.15 · S) / 0.75. E's weight is spread over the
other three in proportion, and the family is marked PROVISIONAL at best.

## The gate, per family

- **PASS**: PI_f ≥ 90, O ≥ 95, E, R and S each ≥ 70, the bootstrap lower bound of PI_f ≥ 85,
  and n ≥ 6 scored pairs over ≥ 3 distinct tasks.
- **PROVISIONAL**: the point PI_f ≥ 90 and the guard-rails (O ≥ 95; E, R, S ≥ 70) hold, but
  the evidence is short. That means n, the task count or the lower bound falls short, or E is
  insufficient.
- **FAIL**: anything else.
- **UNMEASURED**: the family has no scored pairs.

**Headline** = the minimum PI_f over the measured product-mode families, naming the family.
**Overall status**: FAIL if any family fails, else PROVISIONAL if any family is PROVISIONAL or
unmeasured, else PASS. Nothing is PASS until all seven families pass.

The gate is **product mode only**: each tool on its best model on the founder's own accounts.
Harness mode (both tools on one model through one API key) is scored the same way and reported
with its own statuses, but it is attribution and never a gate. Where both modes measured a
family, the report gives **modelGap = PI_harness − PI_product**.

## Confidence

Two intervals, under two names, answering two questions.

**Within tasks — 80%, the one the gate reads.** Paired bootstrap, stratified by task. Each
replicate resamples each task's pairs with replacement, keeping that task's count. B = 2000.
The generator is mulberry32 from a recorded seed (default 20260928, or `--seed N`). The
interval is 80%, from the 10th to the 90th percentile, and is given for PI_f and for each
axis. It holds the tasks fixed: it says how far the number would move if **these** tasks were
run again, and nothing about tasks that were not run.

**Across tasks — 95%, reported and never gated.** Each replicate draws whole tasks with
replacement, as many as the family has, every drawn task bringing all its pairs
(`bootstrapClustered`). Same B, same seed, its own generator, 2.5th to 97.5th percentile. It
says how far the number might move on other tasks like these. With three tasks it is coarse,
which is the fact it is there to show; with fewer than two it is absent rather than zero wide.
Neither interval measures generalisation to other repositories or other kinds of task.

## The report

`bun tests/eval/parity/report.ts --results <file...> --out <dir> [--comparator claude-code|opencode] [--seed N] [--allow-mixed-versions] [--allow-mixed-config] [--allow-unfingerprinted]`

The CLI writes `<dir>/parity-report.json` (`kind: "parity-report"`, `schema:
"parity-report/2"`) and `<dir>/parity-report.md`. It refuses to overwrite: if either file
exists, nothing is written, so a report already on disk, of either schema, is never rewritten.
Exit 0 means a report was written, whatever it says. Exit 1 means the inputs were refused or an
output already exists. Exit 2 is a usage error.

The JSON records:

- `generatedAt`
- `inputs`: each file's path, sha256 of its bytes, and row count
- the seed and the bootstrap settings
- the weights, exponents and gate thresholds in force
- `versions`: every (version, binarySha256, sourceBuild, models) each arm ran as, per mode
- `rosters`: where an arm's rows state the roster it was configured with, that roster and
  what each run called
- per mode, per family: n, tasks, axes, uncapped, PI, interval, status, reasons, exclusions,
  and efficiency detail
- per mode, per family (`parity-report/2`): `absolute` for each arm, `caveats`, `taskInterval`,
  and `legacy` — PI, R and S over the same pairs under the `parity-run/1` rules, with
  `differs` where any pair's clean or scope changed
- `rowSchemas`: how many rows were read under each row schema
- `allowed`: what an override let in
- unpaired rows
- modelGap
- headline, status and reasons

The Markdown page renders the same content.

## Comparable evidence

A report is one comparison. Rows that cannot be shown to belong to one are refused before
anything is scored, every problem named in one refusal.

**Refused, with no override** — no flag makes these one exam:

- one task **run from two starting points**: `fingerprints.task` differs. It is a digest of
  the task id, the prompt's bytes, the seeded tree, the uncommitted work in it and the wall
  limit, taken from the tree each run actually started from;
- one task **graded by two sets of checks**: `fingerprints.grader` differs. For a corpus task
  it is `acceptance.json` and every file under `checks/`; for a mined task, the fix commit,
  its hidden and test files, and every check's pinned role;
- rows of **two row schemas** together: `clean` and `scope` mean different things in each.

**Refused unless asked**, and then the report says so, lists it in `allowed`, and no family it
touches can PASS:

- `--allow-unfingerprinted`: rows that carry no fingerprints (`parity-run/1` evidence);
- `--allow-mixed-config`: one arm in one mode on more than one configuration (model, provider,
  effort) or more than one reported model roster. A run on which the tool named no model says
  nothing about which it used and is not a second roster.

  **Where every row of an arm states the roster it was configured with** (`roster`), what a
  run called is held to that instead: the same configured roster on every row, and no call to
  a model outside it. A configured helper that one run needed and another did not is then
  one configuration. A model outside the roster — a fallback — is still a difference, and so
  are two configured rosters. Rows that state none, and a set in which only some do, are held
  to the rule above. What was called is printed under **Models called** either way.

**One build per arm per mode.** Two different `binarySha256` values, or two different
`--version` strings, among one arm's rows in one mode are refused — for Rune and for the
comparator alike. `--allow-mixed-versions` overrides the refusal, and the report then says so
in `mixedVersions` and in its reasons.

A tool run from source has no one file to hash, and every build of a working tree answers the
same `--version`. Its build is `sourceBuild`, the fingerprint of the source the series ran.
Two of those in one mode are two builds, and so is a set in which some rows name one and some
name none: nothing shows the unnamed rows ran the source the others did.

All of this is held for the two arms being compared. A third arm's rows are not scored and
are not held to it.

## Implementation decisions the brief left open

1. **Zero figures in E.** A calls or cost figure of 0 is dropped like a null one, rather than
   divided by. A free model has a list cost of 0. Wall time cannot be 0 on a scored row;
   validation refuses it.
2. **Success means q = 1 exactly.** A pass with a regression has q ≤ 0.5 and is not a success.
3. **Thresholds** forgive float noise below 1e-9 and nothing larger. An O of 94.99 is below 95.
4. **Bootstrap replicates are scored by the same function as the point.** That includes the
   four-pair rule for E, counted with multiplicity in a resample. E's interval is taken over
   the replicates where E was defined, and is null when the point E is insufficient. Each
   family's bootstrap starts from the recorded seed, so adding one family's rows never moves
   another family's interval. Pairs are ordered by (task, run) and strata by task, so the
   order of the input files does not move anything. Percentiles interpolate linearly between
   order statistics (numpy's and R's default).
5. **Invalid inputs stop the report.** The report refuses outright on:
   - a row that fails the contract (every bad line is named as `file:line`);
   - two rows for one (mode, arm, task, run);
   - a task filed under two families.

   None of these is ever dropped quietly from a denominator.

6. **An unpaired row caps its family at PROVISIONAL.** A missing comparator row removes a task
   Rune might have won; a missing Rune row removes one Rune might have lost. Either way,
   dropping half a pair could move the number, so a family with any partnerless row (either
   side) can never PASS until the missing arm is re-run. It can still FAIL on its scored pairs.
7. **With nothing measured**, the headline is null and the status is PROVISIONAL, with the
   reason "no product-mode family was measured".

## Changes

- **2026-09-28**: First version (lane L0-C). It implements the parity program's spec as
  written above, plus the decisions listed above. One deliberate widening of the brief: the
  mixed-build refusal covers two Rune `--version` strings in one mode as well as two
  `binarySha256` values. Two version strings are two builds even when a row carries no hash,
  and `--allow-mixed-versions` overrides both.
- **2026-09-28, review**: Decision 6 was tightened on review. The first version only counted
  unpaired rows; now a family with any partnerless row is PROVISIONAL at best
  (`pairRows().unpairedByFamily` → `gateFamily({ unpaired })`). Two mutants (the gate
  ignoring the count; the comparator side not counted) each turn a test red.
- **2026-10-04, scope on coding tasks** (review of 2026-09-30, card M1, part 1). Before this,
  a coding task scored s = 1 whatever it edited: changing a tracked `unrelated.ts`, rewriting
  a test the task said to leave alone, or reverting the person's uncommitted work all passed.
  `ParityTask` now carries `protectedPaths` and `allowedPaths`, and `scoreScope` applies the
  three coding rules above. What is and is not wired:
  - **Protected paths are read from each corpus task's own words** (`protectedPathsOf`):
    `off-by-one-window` → `window.test.ts`; `working-tree-integration` → `money.ts`;
    `wip-due-dates` → `todos.ts`; `finish-utils-split` → `money.ts`, `report.ts`, `text.ts`.
    Each task's reference solution leaves these byte-identical (tested).
  - **Lost uncommitted work needs no declaration** and applies to every coding task.
  - **No shipped task declares `allowedPaths`.** The one mechanical source, "the existing
    files the reference solution changes", was checked and rejected: `three-module-dependent`
    names `report.ts` as step 3 of its migration and its reference leaves that file unchanged,
    so a correct answer editing it would have scored 0. The prompt's file names are no better
    (`rename-quantity-field` names `orders/A-1000.json`, the one file that must not be
    rewritten). So the reviewed `unrelated.ts` case is closed for a task that declares its
    paths and **open for the 48 shipped tasks**, which declare none. Declaring them is a
    per-task judgment to make, and freeze, before a claim-bearing series.
  - A committed rename is now its source deleted and its destination created
    (`git diff --no-renames`), as an uncommitted one already was.
  - Rows written before this date used the old rule. S computed across the two is not
    comparable; the row schema below makes that visible, and the two are never scored together.
- **2026-10-04, how a run ended, and absolute outcomes** (card M1, part 2). Row schema
  `parity-run/2`; report schema `parity-report/2`.
  - **`clean` no longer passes a crash.** `parity-run/1` asked only that the rig had not
    stopped the run and that it was inside the limit, so a process that died in seconds,
    having claimed nothing, was clean. A row now records `terminal`, and `clean` needs
    `completed` or `incomplete`. Nothing else about R moved: a tool stopping at its own
    ceiling, or by its own named stop, was clean before and is clean now.
  - **One new neutral fact, `selfStopped`.** An exit status cannot tell an honest "not
    finished" from a crash — Rune exits 1 for both. What tells them apart is whether the
    tool's own terminal report names a stop. Only the Rune arm has such a report beyond the
    ceilings every arm already reported; a thrown turn (an envelope with an error and no stop
    reason) is a crash, exactly as Claude Code's `error_during_execution` is. `classifyOutcome`
    is unchanged: what is scored is what was scored.
  - **The index under the old rules is kept visible.** Every `parity-run/2` row carries
    `legacy: { clean, scope }`, what `parity-run/1` said of the same run, and each family
    reports `legacy.PI` beside PI, marked where they differ. The status reads PI.
  - **Absolute outcomes and caveats** are new and gate nothing (above). No threshold, weight or
    interval was changed by this part.
  - **Not decided here:** whether the proposed 80% complete-rate floor becomes a rule.
- **2026-10-04, comparable evidence and two intervals** (card M1, part 3).
  - Rows carry `fingerprints { task, grader, config }`, the reported `models` roster and the
    `reasoningEffort` given. The refusals in **Comparable evidence** are new; before them a
    results file graded by edited checks, or run from a different fixture, was averaged in
    silently.
  - **Deliberate widening:** the mixed-build refusal now covers the comparator as well as
    Rune ("freeze every arm"). The header of `run-pairs.ts` notes Claude Code moving
    2.1.283 → 2.1.284 overnight; a series straddling that now needs `--allow-mixed-versions`,
    and says so.
  - **`--allow-mixed-versions` still does not cap a status**, as before. The two new overrides
    do. Making the old one cap too would be a change to the gate and was not made.
  - The **task-level 95% interval** is new and is reported, not gated. The 80% interval, its
    quantiles, its seed and its draws are untouched: the golden family's bounds are pinned at
    the values `parity-report/1` printed (77.4–98.3 at B = 400).
  - **Limits.** The grader fingerprint covers what is checked, not the code that runs the
    check: a change to `corpus-source.ts` or `serious/grade.ts` is not in it. The task
    fingerprint leaves out paths git ignores, so an installed dependency tree is not in it
    either. No `parity-run/2` row has been written by a live run yet.
- **2026-10-04, the series' budget, and one manifest** (card M2). These are rules of the
  _runner_ (`run-pairs.ts`, `series-budget.ts`, `manifest.ts`); the scorer changed in one
  place, the `attempt` rule under **Pairs**.
  - **The first pair is gated like any other.** Before this, `gateBeforePair` returned "go"
    whenever no pair had run, so a series started with Rune's window at 99% and a stop at 90%.
    Every check is now made before every arm run, and what the accounts read before the
    series refuses the first pair.
  - **Hard stops are stated up front**: `--max-pairs`, `--max-attempts`,
    `--wall-allowance-min`. A live series is refused without them, and a plan larger than its
    pair limit is refused rather than cut short.
  - **Each account has a record**: what its window read before the series and where to stop.
    Only Rune's rows report a meter, so a comparator's stop is checked once, against the
    operator's reading, and is labelled as not a cap after that. A series with an account it
    cannot watch needs `--bounded`.
  - **`RUNE_EVAL_BUDGET_USD` is labelled an estimate-gated stop, not a spend cap.** The gate
    did not change: it still stops when what was spent plus the costliest pair so far would
    pass the figure. What changed is that nothing calls that a ceiling.
  - **An unscored row is retried alone.** The old rule re-ran the whole pair under a new run
    number, running the arm that had succeeded a second time. The arm that succeeded is no
    longer re-run; the retry is `attempt: 2` of the same run. Before it, the task is prepared
    and held to the fingerprint its partner ran from.
  - **Source drift stops the series.** A task prepared from a tree that is not the one it was
    first run from is not run: the series stops before the tool is spawned. A manifest whose
    tasks no longer match what it pinned (prompt or checks) is refused before anything runs.
  - **Half a pair is written, once.** When the budget stops the series between two arms, the
    row that exists is kept and reported partnerless (decision 6 then caps its family). It
    used to be impossible for a row to be written without its partner; it is now possible in
    exactly this case.
  - **`manifest.json`** is written before the first pair: tasks with their graders and prompt
    digests, arms and settings, runs, seed and order, limits, accounts. `--dry-run
--write-manifest FILE` writes the same thing without running; `--real --manifest FILE`
    runs it after re-checking the tasks against it.
  - **Not built here:** resuming a stopped series to fill a half pair. The evidence a resume
    needs is on disk (`manifest.json`, `series.json`, the partnerless row); the command is
    not written.
- **2026-10-05, the build a source run names, and the roster an arm is configured with.**
  Two rule changes, both decided by the founder from the first breadth sitting's evidence.
  No threshold, weight, exponent or interval was changed.
  - **`sourceBuild` on the row.** B1 and the first breadth sitting ran on one source and
    everything after on another. Rune's rows carried the same `--version` and no binary hash,
    so a report over both would have passed the mixed-build refusal while breaking the rule
    it holds. The runner already fingerprinted the source and stopped the series if it moved;
    that fingerprint is now on each row, and the refusal reads it. This is a widening: rows
    that name a build are refused beside rows that name none.
  - **`roster` on the row, and what is held to it.** Rune was told to run one model on every
    run, and its shipped configuration puts the reviewer on the provider's heavy tier. Ten of
    eighteen runs needed a review, so the rows held two sets of called models and no number of
    pairs could have made the report PASS. Where every row of an arm states the roster it was
    configured with, what was called is now held to that roster. This is a narrowing of the
    refusal, in one case only: a configured model that was not called on every run. A model
    outside the roster is refused as before.
  - **Where Rune's roster comes from.** `runeRoster`, which asks the product's own tier
    resolver under the parity profile's conditions (no `[tiers]` override). The rig holds no
    list of its own. The comparators state no roster and are held to the older rule.
  - **Rows written before 2026-10-05 carry neither field** and are read as they were: by the
    older roster rule, and with no build named. The first breadth sitting therefore stays
    PROVISIONAL by label, and cannot be put in one report with a later sitting's rows.
  - **Limits.** The roster is what the configuration names, not what a run was entitled to
    call for a reason: a review on the heavy tier that should not have happened is inside it.
    A `[tiers]` override, were a run ever given one, is not read by `runeRoster`.
