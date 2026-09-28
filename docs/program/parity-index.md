# The Parity Index — how Rune is scored against Claude Code

Written 2026-09-28 (parity program, lane L0-C). This is the rule the founder's release gate
reads. The arms write `ParityRunResult` rows (`tests/eval/parity/types.ts`, the frozen
contract) into `results.jsonl` files, and the scorer turns them into one number per task family
and one status. Change a rule here and you change what the gate means. Every change goes in
**Changes** at the foot, dated, with the reason.

Code: `tests/eval/parity/score.ts` (pure scorer and gate), `bootstrap.ts` (pure, seeded),
`aggregate.ts` (reads and validates rows, forms pairs), `report.ts` (CLI and renderers).
Tests: `tests/unit/eval/parity-{score,bootstrap,report}.test.ts`, fixtures in
`tests/fixtures/parity/`.

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
- **R (reliability)** = 100 · min(1, cleanRate_R / cleanRate_C), from the `clean` flag. If
  cleanRate_C = 0, R = 100 · cleanRate_R.
- **S (scope)** = 100 · min(1, mean s_R / mean s_C). If mean s_C = 0, S = 100 · mean s_R.
- The **uncapped** ratios (mean q_R / mean q_C, G, cleanRate_R / cleanRate_C, mean s_R /
  mean s_C) are reported as **advantages**. 1.00× is parity. An advantage is null where the
  comparator's figure is 0 (the ratio is unbounded) or E is insufficient.

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

Paired bootstrap, stratified by task. Each replicate resamples each task's pairs with
replacement, keeping that task's count. B = 2000. The generator is mulberry32 from a recorded
seed (default 20260928, or `--seed N`). The interval is 80%, from the 10th to the 90th
percentile, and is given for PI_f and for each axis.

## The report

`bun tests/eval/parity/report.ts --results <file...> --out <dir> [--comparator claude-code|opencode] [--seed N] [--allow-mixed-versions]`

The CLI writes `<dir>/parity-report.json` (`kind: "parity-report"`, `schema:
"parity-report/1"`) and `<dir>/parity-report.md`. It refuses to overwrite: if either file
exists, nothing is written. Exit 0 means a report was written, whatever it says. Exit 1 means
the inputs were refused or an output already exists. Exit 2 is a usage error.

The JSON records:

- `generatedAt`
- `inputs`: each file's path, sha256 of its bytes, and row count
- the seed and the bootstrap settings
- the weights, exponents and gate thresholds in force
- `versions`: every (version, binarySha256, models) each arm ran as, per mode
- per mode, per family: n, tasks, axes, uncapped, PI, interval, status, reasons, exclusions,
  and efficiency detail
- unpaired rows
- modelGap
- headline, status and reasons

The Markdown page renders the same content.

**One Rune per mode.** Two different Rune `binarySha256` values within one mode are refused.
So are two different Rune `--version` strings (see Changes). `--allow-mixed-versions`
overrides the refusal, and the report then says so in `mixedVersions` and in its reasons.

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
