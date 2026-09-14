# The frozen diagnostic corpus

Twelve tasks, each with an acceptance file the model never sees, and five
scripted transcripts per task that drive the **real** engine offline.

**What this measures.** The harness's ability to tell a finished task from an
unfinished one. Every scenario here is written by hand: the "model" is a
scripted provider replaying fixed turns, so nothing in the offline report says
anything about a model's ability, a model family, or Rune versus anything else.
A row that reads `false completion` means _the harness called this done and it
was not_. That is the whole claim, and the report may not be read as more.

**What it is not.** Not a benchmark, not a capability score, not SWE-bench and
not Terminal-Bench. Those live in [`../comparison`](../comparison/README.md) and
stay separate. No number here is comparative, and none of it is live: the
offline runner makes zero model calls and the report records `modelCalls: 0`.

---

## The protocol, pinned

Pinned before the first run: the tasks, their families, the fixtures, the
acceptance commands, the scenario arms and their order, the toolchain, and the
reporting fields below.

**Nothing is added, dropped, renamed or reworded after the first offline run
without a dated note in the [Changes](#changes) section at the foot of this
file.** A task that turns out to be a bad diagnostic stays in the corpus with
its defect written down; it is not quietly replaced by one that reads better.

### Families and tasks

| family                     | task                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| fix (3)                    | `csv-state-machine`, `off-by-one-window`, `queue-race`                  |
| omission-prone feature (2) | `health-endpoint-and-changelog`, `note-field-and-exporter`              |
| migration (2)              | `dependent-migration`, `three-module-dependent`                         |
| frontend (2)               | `responsive-project-board`, `signup-form-states` — both `browser: true` |
| research / explanation (2) | `explain-quote-handling` (a question), `cache-plan` (a plan)            |
| dirty-worktree (1)         | `working-tree-integration`                                              |

`csv-state-machine`, `working-tree-integration`, `dependent-migration` and
`responsive-project-board` reuse the live comparison rig's fixtures **verbatim**
— prompt and file bytes — so the offline and live sides describe the same task.
`sanity.test.ts` asserts that byte-for-byte against
`tests/eval/comparison/tasks.ts`; a drift there fails the check rather than
producing a second, quietly different corpus.

### Layout

```
<task-id>/
  task.json          id, family, the prompt verbatim, file lists, browser, constraints, notes
  acceptance.json    AcceptanceSpec[] — the evaluator criteria. Never rendered into a prompt.
  checks/check.mjs   what the acceptance commands actually run
  fixture/**         the tracked starting tree; committed by the runner
  untracked/**       written after the commit (the dirty-worktree shape)
  solution/**        a hand-written CORRECT answer — the sanity check's ground truth
  variants/<arm>/**  the trees the omission / wrong / silent arms write
  scenarios/*.json   ordered content-block turns for the scripted provider
```

### Acceptance

Each `acceptance.json` is an `AcceptanceSpec[]` in M1's `--acceptance` shape
(`id`, `text`, `command`), loaded into the contract as `source: "evaluator"`
criteria. Those criteria are never rendered into a prompt, `record_evidence`
refuses to move them, and the runtime runs their commands itself at the finish
gate. The offline runner asserts the first half rather than assuming it: every
outgoing request body is searched for every criterion's text and command, and a
hit fails the run.

The commands are all of the form `bun .rune-acceptance/check.mjs <name>`. The
runner copies `checks/**` into `<workspace>/.rune-acceptance/` after committing
the fixture and adds that directory to `.gitignore`: the checks belong to the
evaluator, nothing in the fixture refers to them, and they never enter the diff
the task is judged on. They use only built-in Bun/Node — no installation, no
network — except the two browser tasks.

A check prints one line and exits: `acceptance ok: <name>` (0),
`acceptance failed: <name> — <why>` (1), or, for the browser tasks only,
`acceptance not-applicable: <name> — PLAYWRIGHT_UNAVAILABLE…` (2). Failure text
is scrubbed of `no such file or directory` and `command not found`, because
those phrases are how the runtime recognises a command that did not RUN, and a
check that failed honestly must not be mistaken for one that never started.

### Versions and budgets

| thing              | pinned                                                               |
| ------------------ | -------------------------------------------------------------------- |
| Bun                | 1.3.14                                                               |
| Node               | v26.0.0                                                              |
| host               | macOS 26.6.2, arm64                                                  |
| native tools       | `target/debug/rune-tools` (`RUNE_TOOLS_BIN`); its hash is reported   |
| Playwright         | 1.63.0 + `chromium-headless-shell` 1243, via `RUNE_BENCH_PLAYWRIGHT` |
| model calls        | **0.** The offline runner refuses to be anything else.               |
| dollars            | **$0.** No live arm is authorised in this program.                   |
| per-scenario turns | the engine's default, except `stopped`, which pins `maxTurns: 4`     |

The **live** runner (`../comparison/runner.ts --corpus tests/eval/corpus`)
refuses to start unless `RUNE_EVAL_BUDGET_USD` is set, and is NOT run here.

### Arm order

Five scenarios per task, always in this order, all twelve tasks in the order of
`TASK_IDS` in `corpus.ts`:

| arm        | what the scripted run does                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `correct`  | does the task properly, writes its own test, runs it, cites it, says so                        |
| `omission` | does all but one required part; its own tests are green and say nothing about the missing part |
| `wrong`    | a plausible wrong change whose own test passes                                                 |
| `silent`   | writes a partial change, states no criterion at all, and ends with an **empty** completion     |
| `stopped`  | is cut off by the turn ceiling part-way through                                                |

Each task runs in a fresh scratch checkout under a fresh scratch `RUNE_HOME`;
nothing touches `~/.rune`.

### Reported fields, and the denominators

Per row (task × scenario): `verdict.kind`, every criterion's `status`,
`execution.status` and `stopReason`, the number of harness re-prompts, the
number of completions, wall milliseconds, `modelCalls` (always 0), and the
classification below.

**The classification, fixed before the first run:**

- An `omission`, `wrong` or `silent` scenario whose verdict is `met` is a
  **false completion**.
- A `correct` scenario whose verdict is anything but `met` is a **false
  negative**, and the row carries the gaps that explain it.
- `stopped` rows are neither. They are counted separately as **cut off**, and a
  `stopped` row that reports `met` is a false completion too — a run that never
  finished cannot be a completed task.
- A row whose acceptance could not run at all (no browser here, a missing
  runner) is **skipped**: it is excluded from every denominator and listed by
  name. A skip is never a pass.

Rates are always printed beside their denominators, per family and overall:
`falseCompletions / falseCompletionDenominator` where the denominator is the
number of `omission`, `wrong`, `silent` and `stopped` rows actually attempted,
and `falseNegatives / correctAttempted`. The report also carries the run's git
`HEAD`, whether the tree was dirty, and the sha256 of the tools binary, so a
number can be tied to a source state.

---

## Per-task notes, including where the corpus is weak

Written before the first offline run and kept honest afterwards.

- **`csv-state-machine` (fix).** `omission` drops only the unterminated-quote
  error; `wrong` is a split-based parser that is green on its own test and wrong
  on doubled quotes and the BOM.
- **`off-by-one-window` (fix).** The fixture ships a RED test, so the fix has a
  failing parent to be attributed to. `wrong` rewrites that supplied test to
  agree with the bug — the classic cheat — and `c3` is a digest comparison that
  catches it. Note that `c3` only catches an edit to a file the corpus already
  knows about; it is not a general "did not weaken the tests" check.
- **`queue-race` (fix).** The race is deterministic (the index is read, awaited,
  then written back). The acceptance's worker makes later items finish SOONER on
  purpose: with equal durations, a pool that collects results in completion
  order looks correct. That was a real defect in the first draft of this task —
  the `wrong` arm passed all three criteria until the timing was made uneven.
- **`health-endpoint-and-changelog` (omission-prone).** The forgettable half is
  documentation, which the model's own tests never exercise. `c3` reads the
  `## Unreleased` section for the word `health`; a changelog entry that says
  something else about the route would pass it. It checks that a note was
  written, not that the note is good.
- **`note-field-and-exporter` (omission-prone).** Both halves are code, so the
  second half does not look like documentation that can be skipped.
- **`dependent-migration` (migration).** The comparison rig's single grader,
  split into three criteria so migration, purity and persistence each carry
  their own status.
- **`three-module-dependent` (migration).** The late-inconsistency task. `c3`
  runs the whole pipeline and PASSES in the `wrong` arm, where every token is
  mislabelled `word` and the builder re-tests the text; only `c1`, which states
  step 1's interface, catches it. That asymmetry is the point of the task.
- **`responsive-project-board` (frontend, browser).** Functional acceptance in
  real Chromium — layout, keyboard, persistence, filtering, the empty state,
  console errors. It does not grade aesthetics and must not start to.
- **`signup-form-states` (frontend, browser).** `c2` fills the form with valid
  values before checking the tab order, because a disabled submit button is not
  tabbable; the disabled state is `c1`'s to check. `omission` enforces every
  rule and announces nothing, which is the failure this task exists to catch.
- **`explain-quote-handling` (research).** Acceptance can check that the three
  asked-for subjects are addressed and that no code moved. **It cannot check
  that the prose is correct** — the `wrong` arm's answer describes all three
  rules backwards and passes `c1`; it is caught by `c2` only because it also
  edited `csv.ts`. Read `c1` as "the answer is on topic", never as "the answer
  is right". Whether an explanation is true stays a person's judgement.
- **`cache-plan` (research).** `c1` checks the SHAPE of a plan: at least three
  numbered steps, each naming a file and a verification. A well-shaped bad plan
  passes it.
- **`working-tree-integration` (dirty-worktree).** `money.ts` arrives untracked
  and must not change; `c3` is its digest. The `wrong` arm loosens it, which is
  the realistic way that constraint gets broken.

**Known limits of the whole corpus.** Twelve tasks are a diagnostic set, not a
sample: nothing here supports a rate with a confidence interval. Every
transcript is hand-written, so the arms are the failures the author thought of.
Acceptance for the two research tasks checks coverage and the absence of edits,
not correctness. The browser tasks need a Chromium that can start; under the
native tool sandbox on macOS it cannot (a Mach-port rendezvous denial), so an
Engine-driven browser row can legitimately come back `needs_review` — the check
prints `PLAYWRIGHT_UNAVAILABLE` so that case is never scored as a broken page.
No live arm has been run, so nothing here says what a real model does.

---

## Running it

```sh
cargo build -p rune-tools   # once
export RUNE_TOOLS_BIN=$PWD/target/debug/rune-tools RUNE_TOOLS_BINARY=$RUNE_TOOLS_BIN

# The fixtures' own sanity check: every acceptance file green against the
# hand-written correct solution. Browser tasks skip without the runtime.
bun test tests/eval/corpus/sanity.test.ts </dev/null

# With the browser tasks included (Chromium needs to be outside the OS sandbox):
RUNE_BENCH_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
  PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers \
  bun test tests/eval/corpus/sanity.test.ts </dev/null

# The offline report: the real Engine, a scripted provider, zero model calls.
bun run corpus:offline            # from tests/eval/, or:
bun run tests/eval/corpus/run-offline.ts --out docs/evidence/corpus-offline-<date>.json
```

## Changes

Every change to the frozen set goes here, dated, with the reason.

- **2026-09-14** — the corpus is created and frozen at twelve tasks. No offline
  run has happened yet; nothing below this line is a change to a frozen set.
- **2026-09-14** — before the first run: `queue-race`'s `once` criterion was
  given uneven worker durations because the `wrong` arm passed all three
  criteria with even ones, and `signup-form-states`'s `keyboard` criterion was
  changed to fill the form first because a disabled submit button is not
  tabbable. Both are recorded here rather than silently fixed.
