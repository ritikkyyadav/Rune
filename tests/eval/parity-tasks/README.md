# The parity supplement

Six tasks written in the frozen corpus's on-disk layout, so that the Parity
Index has three tasks in every family the corpus measures. The gate scores
seven families and needs at least three tasks in each
([`../parity/types.ts`](../parity/types.ts)); the corpus has three fixes and
two or fewer of everything else.

**What it is.** A task source, and nothing more. The same two loaders that
read the corpus read this directory when they are given it in place of the
corpus's:

- [`../parity/corpus-source.ts`](../parity/corpus-source.ts)
  `corpusParityTasks(dir)`, which the paired runner uses
  (`run-pairs.ts --corpus tests/eval/parity-tasks`), and which grades a tree by
  running every `acceptance.json` command with the checks staged in
  `.rune-acceptance/`;
- [`../comparison/runner.ts`](../comparison/runner.ts) `corpusTasks(dir)`, the
  live comparison rig's reader.

**Why it is separate from the corpus.** The corpus is frozen: its protocol
pins twelve tasks, each with five scripted offline scenarios that drive the
real engine, and nothing is added without them. These six have no scripted
scenarios, so they cannot be part of the offline diagnostic, and putting them
there would change what the corpus's offline report means. Here they are
parity tasks only; the corpus, its offline runner and its sanity check are
untouched.

## Families after the supplement

| family                      | corpus | supplement | total |
| --------------------------- | ------ | ---------- | ----- |
| F1 fix                      | 3      | 0          | 3     |
| F2 omission-prone feature   | 2      | 1          | 3     |
| F3 multi-file / migration   | 2      | 1          | 3     |
| F4 frontend                 | 2      | 1          | 3     |
| F5 no-code (explain / plan) | 2      | 1          | 3     |
| F6 dirty worktree           | 1      | 2          | 3     |

F7, the serious family, is the mined tasks in [`../serious`](../serious) and
is not counted here. `tests/unit/eval/parity-tasks-sanity.test.ts` asserts
this table.

## The tasks

| task                    | family | the arm is asked to                                                                                                                             | the wrong variant                                                                                           | fails   |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------- |
| `json-output-flag`      | F2     | add `--json` to a log-counting CLI, and list it in `--help`, document it in the README's Usage section and test it                              | does the flag, the help line and a test, and never touches the README                                       | c3      |
| `rename-quantity-field` | F3     | rename `qty` to `quantity` across model, serializer, reader and CSV report, while orders saved as `qty` keep loading                            | renames everywhere, updates the tests, and reads only `quantity`, so no order saved before the rename loads | c2      |
| `pricing-page-mobile`   | F4     | make a desktop-only pricing page work at 390px: cards stacked, the table scrolling in its own box, links behind a keyboard-operable Menu button | stacks the cards and builds the menu, and leaves the comparison table 1052px wide                           | c2 (\*) |
| `review-invoice-rules`  | F5     | review `invoice.ts` against the rules in its README, write REVIEW.md, change no code                                                            | finds two of the three defects, then fixes those two in `invoice.ts`                                        | c1, c3  |
| `wip-due-dates`         | F6     | finish a feature on top of the user's uncommitted edit to a TRACKED file, keeping that file byte-identical                                      | writes its own `setDue` over the user's, one that accepts 2026-02-30                                        | c2, c3  |
| `finish-utils-split`    | F6     | finish the user's half-done split of `utils.ts`: two NEW untracked modules and one MODIFIED file, all to be left exactly as they are            | finishes the split and rewrites the user's `money.ts` in its own style                                      | c4      |

(\*) Not observed: see [What is not proven](#what-is-not-proven).

What the untouched fixture scores, for reading a row: `json-output-flag` 0/4,
`rename-quantity-field` 0/4, `review-invoice-rules` 1/3, `wip-due-dates` 1/3,
`finish-utils-split` 2/4. The criteria a do-nothing tree passes are the ones
that guard what must not change: the source a review may not edit, the user's
uncommitted files, and a refactor's unchanged output. `pricing-page-mobile`'s
`c1` (1280 is unchanged) is the same kind, and in a browser the fixture should
score 1/3.

## Layout

The corpus's, less the scripted scenarios:

```
tasks.json           the ids, in family order
<task-id>/
  task.json          id, family (the corpus's vocabulary), prompt, files, untracked?, browser?, constraints?, notes
  acceptance.json    { id, text, command } per criterion; every command is `bun .rune-acceptance/check.mjs <name>`
  checks/check.mjs   what the commands run (and browser.mjs, for the frontend task)
  fixture/**         the tracked tree, committed by the loader
  untracked/**       written after the commit (the dirty-worktree tasks); a path also in `files` is a modified tracked file
  solution/**        a hand-written correct answer
  variants/wrong/**  a plausible wrong answer
```

A check prints one line and exits: `acceptance ok: <name>` (0),
`acceptance failed: <name> — <why>` (1), or, for the browser task only,
`acceptance not-applicable: <name> — PLAYWRIGHT_UNAVAILABLE…` (2), which the
grader counts as impossible for both arms. It addresses the tree through
`process.cwd()`, runs the tree's own code with the `bun` that is grading, and
uses only built-in Bun/Node.

Two things differ from the corpus's data, both because this directory is
formatted and typechecked with the rest of `tests/eval` (it has no
`.prettierignore` entry and no `tsconfig` exclusion):

- every file is Prettier-clean, and every digest a check pins was taken
  AFTER formatting, so a formatting pass cannot break one;
- every `.ts` tree compiles on its own, which is why `solution/` and
  `variants/wrong/` are whole trees rather than the changed files alone, and
  why the dirty-worktree tasks' uncommitted `.ts` files import only each other.

## Per-task notes, including where each is weak

- **`json-output-flag` (F2).** Four stated requirements, two of which no test
  the model writes ever exercises. `c3` reads the Usage section for the flag by
  name: it checks the option was documented where the prompt said, not that the
  documentation is good. `c4` counts passing tests, so a suite that shrank to
  make room fails it; it finds the new test by the literal `--json`, so a test
  that only calls a JSON helper does not count.
- **`rename-quantity-field` (F3).** The type checker points at three of the four
  modules; it cannot point at the files already saved as `qty`. That is `c2`, the
  criterion a careless rename fails with every test green. `c3` pins the CSV
  header, a string no type follows.
- **`pricing-page-mobile` (F4, browser).** A change to an existing page, where
  the corpus's two frontend tasks build pages from nothing. It checks layout, the
  menu's behaviour and the console, never aesthetics. "Collapsed" means hidden as
  Playwright sees it: links clipped to zero height are still shown, and still
  focusable, and fail `c3`.
- **`review-invoice-rules` (F5).** Three rule breaks are planted, one per
  function, under a test suite that passes. `c1` and `c2` read the review's
  CALLS, not its words: each call is evaluated against the code as given and
  against that code with one defect repaired, so a call shows a defect only if
  repairing that defect changes its result, and `c2` wants the rules' result
  stated near the call. Arguments may be literals or values the review declares
  (`const lines = [...]`, typed or not). This goes further than the corpus's two
  research tasks, whose acceptance checks topic coverage only, but it is still
  not a reading of the prose: a review that flags a correct function as well
  passes, so "report only real defects" is the prompt's, not a criterion's.
- **`wip-due-dates` (F6).** `todos.ts` is tracked, and the user's uncommitted
  edit is written over it after the commit, so `git status` shows it modified.
  `c2` is where building on the user's helper shows: 2026-02-30 matches a
  YYYY-MM-DD pattern and only a calendar check refuses it.
- **`finish-utils-split` (F6).** Both shapes of uncommitted work at once: two new
  untracked files and one modified tracked file. The test file is one of the
  remaining callers. `c1` (utils.ts emptied) and `c2` (every caller moved) fail
  independently, so a half-done split scores half.

## What is not proven

- **The frontend task has not run in a browser.** Chromium cannot start in the
  sandbox these tasks were written in. Its checks are built on the corpus's own
  `browser.mjs`, byte for byte, and use only Playwright calls the corpus's
  checks already make; without a runtime every criterion comes back impossible,
  never failed, and the sanity test pins that, the page's structure, the menu
  script against a stub DOM, and that the wrong variant differs from the
  solution only in the table. Whether the solution scores 1 and the wrong
  variant fails exactly `c2` in real Chromium is unobserved until someone runs
  the sanity test with `RUNE_BENCH_PLAYWRIGHT` set, which un-skips both.
- **No arm has run any of these tasks.** Every `wrong` is a failure the author
  thought of, as in the corpus.
- **Windows.** The sanity test is in the unit gate, which also runs on
  Windows; it was run on macOS only.

## Running it

```sh
# Every task through both loaders; each solution, wrong variant and fixture
# graded by corpus-source. The browser task's two trees skip without a runtime.
bun test --preload ./tests/scratch-home.ts tests/unit/eval/parity-tasks-sanity.test.ts

# With the browser task graded (Chromium must be able to start):
RUNE_BENCH_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
  PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers \
  bun test --preload ./tests/scratch-home.ts tests/unit/eval/parity-tasks-sanity.test.ts

# A paired series over the supplement, planned only (spawns nothing, writes nothing):
bun run tests/eval/parity/run-pairs.ts --dry-run --arms rune,claude-code \
  --mode product --runs 1 --out <fresh-dir> --model <model> --corpus tests/eval/parity-tasks
```

## Changes

Every change to these tasks goes here, dated, with the reason.

- **2026-09-30** — the supplement is created with six tasks: one each in F2–F5
  and two in F6. Each loads through `corpusTasks` and `corpusParityTasks`; each
  solution grades quality 1 and each wrong variant fails the criteria listed
  above, except the browser task's two trees, which are unobserved.
- **2026-09-30, before any run** — `finish-utils-split`'s single "split"
  criterion became two, `slim` (utils.ts emptied) and `callers` (every caller
  moved), because a tree nobody touched scored two of three on the
  preservation guards alone; it now scores two of four. `rename-quantity-field`'s
  `c4` reads the new field name as a field, because the fixture's own test
  titles already say "quantity" in prose. `review-invoice-rules`' check binds
  the values a review declares and strips `as`/`satisfies`, because a correct
  review that wrote `const lines = [...]` failed `c1`.
