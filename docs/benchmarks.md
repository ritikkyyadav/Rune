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

## P10.4 — verifier ecosystems

Also the in-repo mock suite, and also measured rather than argued.

**The before number is zero, and it is zero by construction.** Detection knew
JS/TS, with Rust and Go bolted on as two `existsSync` calls at the workspace
root. On a Go, Python, Rust or Java project the step check found nothing to run,
reported `ran: false`, and the completion was accepted — so a step that broke the
build closed as done. There was no eval task in any ecosystem but JS/TS to record
a number for, which is the same fact from the other side.

Five tasks were added (`tests/eval/tasks-verifier-ecosystems.ts`), one per
ecosystem, all the same shape: plan a step, write a file that does not compile,
mark the step done, and require the harness's compile check to **refuse** the
completion; then fix the file and require the second attempt to be accepted on a
passing check. The compile error is real and the compiler is real.

| date       | ecosystem | step check before | step check after                               | toolchain here  |
| ---------- | --------- | ----------------- | ---------------------------------------------- | --------------- |
| 2026-09-03 | JS/TS     | ran               | ran — `bun run typecheck` exit 1 → refused     | yes             |
| 2026-09-03 | Python    | **never ran**     | ran — `python3 -m py_compile` exit 1 → refused | yes             |
| 2026-09-03 | Rust      | **never ran**     | ran — `cargo check --quiet` exit 101 → refused | yes             |
| 2026-09-03 | Go        | **never ran**     | `go build ./...` (proven in CI)                | no              |
| 2026-09-03 | Java      | **never ran**     | `javac -d <tmp>` (proven in CI)                | no (macOS stub) |

Three of the five measure on this machine. Go is not installed here, and macOS
ships a `/usr/bin/javac` stub that exits 1 with "Unable to locate a Java Runtime"
— which is itself a defect this work found and fixed, since the verifier had been
reporting that as "Java checks FAILED". On a machine missing a toolchain the task
asserts the other half of the same invariant instead: that a compiler which
cannot run never produces a green check. CI's ubuntu runner has all four and
`GEAR_VERIFIER_REQUIRE_TOOLCHAINS` makes a skip there a failure.

The receipts, read back out of the session log (`tests/eval` mock run,
2026-09-03):

```
python3 -m py_compile 'calc.py'   FAILED (exit 1)   in 27ms   → completion refused
python3 -m py_compile 'calc.py'   passed            in 26ms   → step closed "2 writes · check ok"
cargo check --quiet               FAILED (exit 101) in 52ms   → completion refused
cargo check --quiet               passed            in 29ms   → step closed "2 writes · check ok"
```

Before this, none of those lines existed: the exit code and the duration were
not recorded anywhere, and the command name was recovered by a regex over `$ `
lines in the report.

**Whole-suite effect.**

| date       | suite              | before     | after      | note                              |
| ---------- | ------------------ | ---------- | ---------- | --------------------------------- |
| 2026-09-03 | mock (`--compare`) | 50/50 100% | 55/55 100% | +5 tasks; no regression on the 50 |

**What this does not measure.** Whether a live model, handed the refusal, fixes
the build rather than re-submitting to mark the step unproven. That needs
`--real` capacity this machine does not have.

## P10.8 — compaction quality

Not an external anchor: the in-repo mock suite again, in a new `context`
category (`tests/eval/tasks-compaction.ts`, `bun run eval -- --tasks context`).

Compaction had exactly one eval before this — `spine_todos_survive_compaction`,
which asserts that a summary marker and a todo string appear afterwards. A
compaction can satisfy that and still have lost every decision the user stated,
every fact a tool result taught, and 99% of the window it was supposed to free.

**The instrument.** Compaction quality has two halves and only one of them
belongs to the harness: what the harness FEEDS the summarizer and what it does
with the answer, versus what the model makes of it. Measuring against the mock's
canned reply measured neither. These tasks drive a **faithful summarizer** — it
carries forward every sentinel it is handed and invents nothing — so any fact
missing from the post-compaction prompt is a fact the harness dropped before a
model ever saw it. Facts are planted as `DECISION-n` / `FACT-n` sentinels in
user prompts and tool results, and survival is a substring test on the request
the provider actually received.

`mock-model` is registered at a **60,000-token window** for the family (given
back in `teardown`), which puts the ~19.5k floor of system prompt + 29 tool
schemas, the 30% verbatim tail and the 50% target into a realistic relationship
instead of rounding errors against the 100k default.

**Before (2026-09-03, at `8f9a0e1`), first run of the family:**

```
  ✗ compaction_facts_survive
     reason: 5 of 7 pinned facts did not survive compaction: DECISION-1, DECISION-2, FACT-2, FACT-3, FACT-4
  ✓ compaction_plan_and_ledger_survive
  ✓ compaction_hash_ledger_survives
  ✓ compaction_recent_results_verbatim
  ✓ compaction_no_summary_of_summary
  ✗ compaction_evicted_results_identifiable
     reason: 8 results were evicted and only 5 of 8 stayed identifiable — the rest are anonymous holes
  ✗ compaction_reclaims_and_keeps_a_tail
     reason: compaction #1 folded 11 messages and freed only 1.2% (33046 → 32649)

  context                       4/7 (57%)
  Total (whole mock suite)      59/62 (95%)
```

**What the three failures are.**

1. **The cheap tier destroys what no summary ever captured.** Tier 1 replaces
   old tool-result bodies with `[tool result evicted…] N chars reclaimed` and
   returns without calling a summarizer. Everything those results were carrying
   is then gone from the only record that existed — including three 400-byte
   spec reads whose eviction reclaimed a rounding error and cost the run its
   decisions.
2. **An evicted result becomes an anonymous hole.** The stub says how many
   characters were dropped and nothing about what they were, so the run cannot
   tell the read that found the bug from the one that listed a directory, nor
   know which is worth re-running.
3. **A compaction can cost a round trip and free 1.2%.** The verbatim tail is
   sized in tokens but floored by a MESSAGE COUNT (`recentK`, 6), and six
   tool-heavy messages exceed the whole tail budget on their own. The
   summarizer folds eleven messages, frees 397 of 33,046 tokens, and the
   trigger is still hot — so it fires again next turn. The same floor
   over-cuts from the other side: a later compaction in the same run left
   **918 tokens** standing in a 60,000-token window, which is the
   "212 messages folded to 834 tokens" pathology tiered compaction was built
   to end, reached from the opposite direction.

The three that pass are also results: the structured-state merge from the Gap 6
fix holds (no compaction was ever handed its own summary as transcript, exactly
one summary marker survives in the working set, and the merged state does not
run away), the harness-side freshness ledger survives a squash so a
post-compaction edit still applies with no hash and no re-read, and the tail
does come through verbatim.

**After.** See the table added with the fixes.

## Changes to the yardstick

Any edit to a pinned subset breaks the series. Record it here.

| date       | anchor        | change                 | why                                                                                                                                                 |
| ---------- | ------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-02 | both          | created                | P7.9 — the first external anchors this project has had                                                                                              |
| 2026-09-03 | mock baseline | 50 → 55 tasks          | P10.4 — one step-check task per ecosystem; re-anchored deliberately                                                                                 |
| 2026-09-03 | mock baseline | no longer self-writing | P10.4a — a passing `--compare` used to overwrite the yardstick it had just compared against; `--write-baseline` is now the only thing that moves it |
