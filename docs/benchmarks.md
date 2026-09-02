# External benchmarks

Every other number Gear publishes is Gear measuring Gear. The variants registry,
the paired A/B, the lessons ladder — all of them compare this system against
itself on a suite this repository owns, and a suite you own is a suite you can,
over enough months, quietly shape to the thing you built. These two exist so
that drift has somewhere to show up.

**Nothing in this repository downloads either dataset or starts a container.**
Both harnesses are large external dependencies with their own execution models —
SWE-bench needs per-repo Python environments, Terminal-Bench needs Docker — and
a number produced by a re-implementation is not the benchmark's number.
`tests/eval/anchors.ts` pins the subsets, prints the exact commands, and ingests
what those commands produce. It never runs them.

## The subsets, and why they are pinned

| anchor                  | tasks | file                                            |
| ----------------------- | ----- | ----------------------------------------------- |
| `swe-bench-verified-50` | 50    | `tests/eval/anchors/swe-bench-verified-50.json` |
| `terminal-bench-20`     | 20    | `tests/eval/anchors/terminal-bench-20.json`     |

A pinned subset is what makes a monthly number a series rather than a set of
unrelated measurements. Adding or removing an id makes the series discontinuous,
so a change to either file is a change to the yardstick and belongs in the table
at the bottom of this page with a date and a reason.

The SWE-bench subset is the first 50 instance ids in lexical order across the
four most-represented repositories — reproducible from the dataset alone, and
not chosen by difficulty. The Terminal-Bench subset spans the categories a
terminal agent is weakest on: build systems, package management, file surgery,
process control, networking, and recovering from a broken environment. That axis
is the one SWE-bench does not measure and the one this agent's sandbox and bash
discipline actually live on.

## Two arms, always

- **`pristine`** — `gear --pristine`: no notebook, no playbook, no promoted
  config. What the harness scores with nothing learned.
- **`evolved`** — the machine as it stands, promotions and lessons included.

Publishing only the second is how a self-improving system convinces itself.
`anchors.ts --list` refuses to report a lift without both arms from the same day,
and says so in those words: an evolved number with no control beside it is not a
result.

## Running them

```bash
bun run tests/eval/anchors.ts --list                              # subsets + any recorded runs
bun run tests/eval/anchors.ts --plan swe-bench-verified-50 --arm pristine
bun run tests/eval/anchors.ts --plan terminal-bench-20 --arm evolved
```

`--plan` prints the commands verbatim. In outline:

**SWE-bench Verified.** Clone the official harness
(`princeton-nlp/SWE-bench`), produce one patch per pinned instance with
`gear -P` (add `--pristine` for the control arm), then score with
`swebench.harness.run_evaluation`. Gear produces predictions; the official
harness decides whether they resolve. This repository never scores.

**Terminal-Bench.** Install `terminal-bench`, register Gear as a custom agent,
and run the pinned task ids under Docker. Each task is a container with a real
shell, so this is the anchor that exercises the sandbox rather than the diff.

Then record the result:

```bash
bun run tests/eval/anchors.ts --record swe-bench-verified-50 --arm pristine \
  --resolved 14 --attempted 50 --unscored 2 \
  --model claude-sonnet-4-6 --provider anthropic --sha $(git rev-parse --short HEAD)
```

`unscored` is for tasks that could not be judged — infrastructure failures, a
quota that ran out mid-run. They are excluded from the rate rather than counted
as failures, for the same reason the eval suite excludes throttled tasks: a rate
limit is not a capability result. The count is published beside the rate so
nobody has to take that on trust.

Results accumulate in `tests/eval/anchors/results.json`, which is committed.

## Cadence

Monthly, both arms, both anchors, on whichever model is the default at the time
— and the model is part of the number, so it is recorded with it. A month that
is skipped is recorded as skipped rather than back-filled from a nearby run.

## Results

_No run has been recorded yet._ The scaffolding, the pinned subsets and the
commands landed with Phase 7 (P7.9); running them needs credentialed capacity
that this machine does not currently have — the probe on 2026-09-02 returned
`Codex request failed (429): The usage limit has been reached`, and no other
provider has a reachable credential.

When runs exist this table carries them, newest first:

| date | benchmark | model | pristine | evolved | lift | unscored | cost |
| ---- | --------- | ----- | -------- | ------- | ---- | -------- | ---- |
| —    | —         | —     | —        | —       | —    | —        | —    |

## P10.1 — post-edit diagnostics

Not an external anchor: this is the in-repo mock suite (`bun run eval`), recorded
here because the item was measured rather than argued.

**The honest finding first.** The two families P10.1 was told to measure on
cannot show this feature's delta, and no amount of re-running changes that.
`fix-failing-test` and `multi-file-refactor` were both already at 100%, and
neither contains a type error anywhere: every scripted edit in them is correct
by construction, so a feedback channel that reports type errors has nothing to
report. Their before/after numbers below are therefore evidence that nothing
regressed, not evidence that anything improved.

| date       | family                | before | after | note                                           |
| ---------- | --------------------- | ------ | ----- | ---------------------------------------------- |
| 2026-09-03 | `fix-failing-test`    | 5/5    | 7/7   | +2 new tasks; the 5 pre-existing are unchanged |
| 2026-09-03 | `multi-file-refactor` | 4/4    | 4/4   | untouched — no type error in the family        |

**So the delta was measured directly**, with a controlled pair added to
`fix-failing-test` (`tests/eval/tasks-post-edit-diagnostics.ts`). Same brief,
same script, same responder; the only difference between the arms is whether the
language server publishes. The model's first edit introduces
`const discount: number = "0.2"` — a real semantic error the syntax pass parses
without complaint and that JavaScript's coercion hides at runtime (`1 - "0.2"` is
0.8, so the behavioural test passes either way). Only a type-aware checker
objects, which is the class of mistake this feature exists to catch. The
corrective edit fires if and only if the transcript carries the server's verdict.

| date       | arm                                              | server            | outcome                                 | wall   |
| ---------- | ------------------------------------------------ | ----------------- | --------------------------------------- | ------ |
| 2026-09-03 | treatment (`fix_type_error_from_diagnostics`)    | publishes         | type error fixed **in the same turn**   | 225ms  |
| 2026-09-03 | control (`type_error_ships_without_diagnostics`) | publishes nothing | type error **ships**; tests still green | 2150ms |

Read as a rate on the one task the suite can actually pose: **0/1 → 1/1**. Both
tasks pass, because the control passes by asserting that the error shipped — a
control arm that quietly agreed with the treatment would prove nothing.

The control's 2150ms against the treatment's 225ms is the latency bound
observed from the other side: a server that never publishes costs the full 2s
budget exactly once, and a server that answers costs almost nothing. Both arms
drive the fake stdio server in `tests/fixtures/lsp`, so the numbers do not
depend on `typescript-language-server` being installed;
`tests/integration/lsp-post-edit-diagnostics.test.ts` runs the same contract
against the real one and skips cleanly when it is absent.

**What this does not measure.** Whether a live model, given the block, uses it
as well as the scripted responder does. That needs `--real` capacity this
machine does not have (see Results above).

## Changes to the yardstick

Any edit to a pinned subset breaks the series. Record it here.

| date       | anchor | change  | why                                                    |
| ---------- | ------ | ------- | ------------------------------------------------------ |
| 2026-09-02 | both   | created | P7.9 — the first external anchors this project has had |
