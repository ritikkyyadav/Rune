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

## Changes to the yardstick

Any edit to a pinned subset breaks the series. Record it here.

| date       | anchor | change  | why                                                    |
| ---------- | ------ | ------- | ------------------------------------------------------ |
| 2026-09-02 | both   | created | P7.9 — the first external anchors this project has had |
