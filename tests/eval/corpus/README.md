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

## What the first offline run found

[`docs/evidence/corpus-offline-20260914.json`](../../../docs/evidence/corpus-offline-20260914.json),
60 rows, 0 skipped, 0 model calls.

| family                 | attempted | false completions | false negatives | cut off | detected |
| ---------------------- | --------- | ----------------- | --------------- | ------- | -------- |
| fix                    | 15        | 0 / 12            | 0 / 3           | 3       | 12       |
| omission-prone feature | 10        | 0 / 8             | 0 / 2           | 2       | 8        |
| migration              | 10        | 0 / 8             | 0 / 2           | 2       | 8        |
| frontend               | 10        | 0 / 8             | 2 / 2           | 2       | 6        |
| research               | 10        | 0 / 8             | 2 / 2           | 2       | 6        |
| dirty-worktree         | 5         | 0 / 4             | 0 / 1           | 1       | 4        |
| **total**              | **60**    | **0 / 48**        | **4 / 12**      | **12**  | **44**   |

**No false completions — of the arms the author wrote.** Every omission, wrong
change, silent run and cut-off run in the table above reached `partial` or
`unmet` with the failed evaluator criterion named.

That sentence is the whole claim, and `0 / 48` must not be read as a statement
about the ORACLE. An adversarial pass (V6, 2026-09-15) wrote wrong solutions for
three of three families it attacked, and all three passed **every** acceptance
criterion of their task while breaking a requirement the prompt states in words;
`cache-plan`'s omission arm, meanwhile, was caught by its step COUNT and not by
its omission. The acceptance has since been hardened and those four attacks are
arms of the corpus — see the second run below. What a run of this corpus
measures is the harness against the failures somebody thought of.

Two defects on the other side, both found by `correct` arms that should have
reached `met`:

1. **A slow finish gate makes a fresh citation `stale`** (both frontend rows).
   The two browser tasks' acceptance takes seconds; the model's own criterion
   comes back `stale — the workspace moved since the evidence was taken`, with
   nothing in the tree having moved. Isolated by adding `sleep 3` to one of
   `csv-state-machine`'s acceptance commands and changing nothing else: that
   run flipped from `met` to `partial` with the same `stale` gap. The cause is
   `REVISION_MEMO_MS = 1_000` in `engine.ts` — a citation's `dirty` flag is
   read from a memo up to a second old (it recorded `dirty: false` for a tree
   that was already modified), and when the acceptance gate outlasts the memo
   the refreshed revision disagrees with the recorded one, so `criterionStatus`
   derives `stale`. **A run's verdict should not depend on how long its checks
   take.** Not fixed here: `engine.ts` belongs to another lane.
2. **A question or a plan cannot reach `met` through its own citation** (both
   research rows). Asked to write `ANSWER.md` or `PLAN.md` and change no code,
   the run has no recognised check to cite: `grep -c '##' ANSWER.md` is read as
   `execution receipt only — ran, exit 0, not a recognised check`, so the
   model's criterion derives `needs_review` and the verdict is `partial` even
   with every evaluator criterion `satisfied`. That may be the intended
   conservatism (M1's T7 says an explanation ends with its limits named), but
   it means the **evaluator agreeing completely is not enough**, and any
   consumer counting `met` as success will score a correct explanation as a
   miss.

Both are false negatives, not false completions: the harness is currently
biased toward under-claiming, which is the safer direction and still a defect.

Also observed, not a defect: 232 harness re-prompts across 60 rows (2 to 6 per
run — the finish gate and the loop nudges), and a 209-second total wall time
for the whole corpus.

## The second run: the attacks are arms, and the acceptance is harder

[`docs/evidence/corpus-offline-20260915.json`](../../../docs/evidence/corpus-offline-20260915.json),
64 rows, 0 skipped, 0 model calls.

| family                 | attempted | false completions | false negatives | cut off | detected |
| ---------------------- | --------- | ----------------- | --------------- | ------- | -------- |
| fix                    | 16        | 0 / 13            | 0 / 3           | 3       | 13       |
| omission-prone feature | 11        | 0 / 9             | 0 / 2           | 2       | 9        |
| migration              | 11        | 0 / 9             | 0 / 2           | 2       | 9        |
| frontend               | 10        | 0 / 8             | 0 / 2           | 2       | 8        |
| research               | 11        | 0 / 9             | 2 / 2           | 2       | 7        |
| dirty-worktree         | 5         | 0 / 4             | 0 / 1           | 1       | 4        |
| **total**              | **64**    | **0 / 52**        | **2 / 12**      | **12**  | **50**   |

Four things moved between the runs, and none of them is "the oracle got
better on its own":

1. **The four attack arms are in the denominator** (`wrong-v6`, on
   `csv-state-machine`, `health-endpoint-and-changelog`, `dependent-migration`
   and `cache-plan`), and all four are detected — because the acceptance they
   used to pass now names what they break.
2. **The frontend false negatives are gone.** The acceptance now runs from
   OUTSIDE the workspace, staged at intake, and the two browser criteria name
   the directory their entry script loads (`files`). Both `correct` frontend
   rows reach `met`; the `stale` mechanism above is closed by the same lane that
   stamped a citation's revision at check time.
3. **The research false negatives remain**, and they are defect 2 above,
   unchanged: a question or a plan cannot reach `met` through its own citation.
   Two of twelve `correct` rows still end `partial` with every evaluator
   criterion satisfied.
4. **`0 / 52` is still not a statement about the oracle.** It is a statement
   about fifty-two arms, four of which an adversary wrote. The next attack is
   the next measurement.

## Changes

Every change to the frozen set goes here, dated, with the reason.

- **2026-09-14** — the corpus is created and frozen at twelve tasks.
- **2026-09-14, before the first run** — `queue-race`'s `once` criterion was
  given uneven worker durations, because the `wrong` arm passed all three
  criteria when every task took the same time; and `signup-form-states`'s
  `keyboard` criterion now fills the form first, because a disabled submit
  button is not tabbable and the empty form could never show the tab order.
- **2026-09-14, before the first run** — Prettier reformatted the fixture and
  `untracked` trees on the first formatting pass, which broke both the
  byte-for-byte reuse of the four comparison fixtures and the digests baked
  into three acceptance checks. The trees were regenerated from
  `tests/eval/comparison/tasks.ts`, the digests recomputed, and
  `tests/eval/corpus/*/{fixture,untracked,solution,variants,checks}/` added to
  `.prettierignore`: task data keeps its own bytes.
- **2026-09-14, before the first run** — three `correct` arms
  (`note-field-and-exporter`, `dependent-migration`, `working-tree-integration`)
  cited `bun test <one file>` and had their own criterion set aside by the
  relatedness gate, which is that gate working as designed: a criterion naming
  a file is settled only by a check that reads it. They now cite a project-wide
  `bun test`, which is what a real run cites anyway. The behaviour is recorded
  here because it is a real trap for anyone writing a transcript.
- **2026-09-14, before the first run** — the two browser checks write their
  screenshots into `.rune-acceptance/` rather than the workspace root. This did
  NOT fix the `stale` finding above (it was tested and ruled out), but an
  evaluator's artifacts do not belong in the tree it is judging.
- **2026-09-15, after V6** — every check addresses the tree through
  `process.cwd()` instead of `import.meta.url`. The runtime now copies an
  in-workspace acceptance script OUT of the workspace at intake and runs it from
  there with `cwd` = the workspace, so a path resolved from the script's own URL
  points at the staging directory. The two browser tasks' criteria also declare
  `files: [".rune-acceptance"]`, because their entry script LOADS `browser.mjs`
  and reads `env.json` beside it and the runtime stages only what the command
  itself names. This is what closed the two frontend false negatives.
- **2026-09-15, after V6** — three acceptance checks were hardened, because an
  adversarial pass wrote a wrong solution for each that passed every criterion:
  - `csv-state-machine` `c2` now asserts that whitespace outside quotes is data
    and that a BOM anywhere but the very front is data ("Keep whitespace inside
    cells exactly", "an optional LEADING BOM" — both stated in the prompt,
    neither checked). The attacking parser trimmed unquoted fields and stripped
    every BOM.
  - `health-endpoint-and-changelog` `c1` now bounds `uptimeMs` by the time
    elapsed since the module was imported (`Date.now()` satisfied "is a number"
    and nothing else), and `c3` requires the Unreleased section to record the
    `/health` ROUTE rather than to contain the word "health" — the attacking
    changelog said "Renamed the internal healthCheck helper. No routes were
    added or changed." and passed.
  - `dependent-migration` `c1` now requires an unknown store version to throw,
    and `c3` asserts atomicity the only way that does not race it: `save` must
    replace a read-only destination file, which a temporary file plus `rename`
    can do and a plain `writeFile` cannot.
  - `explain-quote-handling` `c1` gained "what the parser does NOT do", which
    the prompt asks for in words and no criterion read.
- **2026-09-15, after V6** — `cache-plan` gained `c2`, "the plan says when a
  cached entry expires and what two concurrent misses do, and ends with the
  risks". Its `omission` arm — "expiry and single-flight are never planned" —
  was caught only by `c1`'s step COUNT: the same omission padded to three
  well-shaped steps passed both criteria, so the row measured shape and was
  reported as an omission caught.
- **2026-09-15, after V6** — a task may declare arms beyond the pinned five
  (`extraScenarios` in `task.json`, read by `armsFor`). Four tasks declare
  `wrong-v6`: the attacker's own solutions, verbatim, so the attacks are in the
  false-completion denominator instead of in a footnote. The pinned five are
  unchanged for every task, and the first run's numbers stand as recorded.
- **2026-09-28, parity program P0.5** — `cache-plan` `c1` counted only
  heading-shaped steps (`## Step 1`), so every plan both agents wrote in the
  2026-09-28 frontier series (GPT-6 Sol, four runs) — a plain numbered list,
  each step naming a file and a check, then `## Risks` — failed as "0 numbered
  steps". `c1` now also reads a top-level numbered list (`1.`, `2)`), and counts
  steps only BEFORE the risks section, so a numbered list of risks cannot pad a
  two-step plan. `c2`'s risks section may be a heading, a bold label or a
  `Risks:` line, and must say something (a bare heading still fails). Every arm
  keeps its verdict: the solution passes, and `omission`, `silent`, `wrong` and
  `wrong-v6` still fail (`tests/unit/eval/corpus-acceptance-attacks.test.ts`).
  The four 2026-09-28 plans pass `c1`–`c3` under the corrected reading; the
  recorded series results stand as recorded. Also: `run-offline.ts` no longer
  defaults to writing over `docs/evidence/corpus-offline-20260914.json` — the
  default names the day and refuses an existing file without `--force` — and
  `sanity.test.ts` now runs in the CI eval job.
