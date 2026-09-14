# Phase 5 + M5 — the frontend and architecture workflows, and a frozen corpus to find their defects

Written 2026-09-14 by the supervising session at `bafe9ca`. Two lanes with disjoint files:
**Lane C (corpus)** owns `tests/eval/corpus/**` and one runner; **Lane F (frontend +
architecture loop)** owns the doctrine, the visual-review record, the browser pre-flight and
two new fixtures. Lane C can start now; Lane F waits for the M3 lane (it touches
`agent-loop.ts`). Requirements:
[the handoff's Phase 5](../CLAUDE_CODE_HANDOFF.md#phase-5--frontend-quality-and-planning-depth)
and [the review's M5](guarantees-plan-review-20260914.md#m5--measure-the-thesis-on-a-small-frozen-corpus).

## What exists, and is kept

- `visual-verification.ts`: G6 product sight. Captures are bound to the run's revision and to
  an origin the run itself served or a `file:` URL inside the workspace; a plain fetch is
  partial evidence and never "reviewed"; without a mounted browser the bar is the fetch.
- The Playwright MCP behind `--browser` / `[browser] enabled` (`tool-registry/src/mcp/browser-server.ts`).
- `tests/eval/comparison/frontend-task.ts`: functional acceptance in real Chromium at 1440
  and 390 wide — columns, keyboard, `aria-pressed`, persistence across reload, filtering,
  search, empty state, horizontal overflow, console errors — with desktop and mobile
  screenshots saved. It does not grade aesthetics, and must not start to.
- The art-direction ask (`artDirectionNote`, the twenty-genre catalogue): a visual style is
  the user's choice, asked once.
- M1's `--acceptance <file>`: evaluator criteria the model never sees, run by the runtime.

## Lane C — the frozen diagnostic corpus (M5)

`tests/eval/corpus/<task-id>/` with, per task: `task.json` (id, family, prompt verbatim,
fixture files, untracked files, browser: bool, pinned constraints), `acceptance.json` in the
`--acceptance` shape (evaluator criteria with commands; the model never sees it), and
`scenarios/*.json` — scripted-provider transcripts that drive the REAL engine offline:
`correct` (does the task), `omission` (does all but one required part, tests green), `wrong`
(a plausible wrong change, its own test green), `silent` (writes, then an empty completion),
`stopped` (budget or provider loss mid-way). Twelve tasks, families fixed before any run:

| family                     | tasks                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| fix (3)                    | the CSV parser (`csv-state-machine`), an off-by-one with a red test, a race in a queue         |
| omission-prone feature (2) | "add X AND update Y" shapes where Y is easy to forget (the audit's silent case)                |
| migration (2)              | `dependent-migration`; a three-module change where step 3's test depends on step 1's interface |
| frontend (2)               | `responsive-project-board`; a form with validation, keyboard flow and an empty/error state     |
| research / explanation (2) | "explain how the parser handles quotes" (question shape); "propose a plan for…" (plan)         |
| dirty-worktree (1)         | `working-tree-integration` (an untracked API that must not be modified)                        |

Rules: tasks, fixtures, acceptance, versions, budgets and arm order are pinned in
`tests/eval/corpus/README.md` with the reporting protocol; official SWE-bench / Harbor stay
separate; no task is added or dropped after the first offline run without a dated note.

**The offline runner** (`tests/eval/corpus/run-offline.ts`): for each task × scenario,
drive the real `Engine` with the scripted provider and the task's `--acceptance` file, then
record per row: `verdict.kind`, per-criterion status, `execution.status`, correction turns
(harness re-prompts), completions, wall time, spend fingerprint, and the **false-completion
verdict**: `omission`/`wrong`/`silent` scenarios that end `met` are false completions; a
`correct` scenario that ends `partial` for a reason other than a declared gap is a false
negative. Output `docs/evidence/corpus-offline-<date>.json` with rates AND denominators.
This measures the harness's detection, never a model's ability, and the README says so.

**The live runner** is the existing `tests/eval/comparison/runner.ts` pointed at the corpus
with the same acceptance files; it refuses to start unless `RUNE_EVAL_BUDGET_USD` is set,
and it is NOT run in this program (no budget is authorised). Add the flag guard and a test
that proves the refusal; do not add a live series.

Exit: twelve tasks with acceptance files that run green against a hand-made correct solution
in a scratch checkout (the fixture's own sanity check), and the offline report over all
scenarios, with the false-completion rate stated per family.

## Lane F — the frontend loop and the architecture plan

**F1 — the loop as doctrine, just in time.** A `frontend` doctrine section (the JIT
mechanism `doctrineForRequest` already routes by request shape) stating the loop the handoff
names, in order: inspect requirements and reference assets; identify the project's actual
stack and reuse its components; the art-direction ask; implement; launch a preview the
runtime can reach (a local origin, so `VisualVerification.own` recognises it); capture
desktop and mobile through the browser; exercise keyboard and state persistence; fix; hand
back with the screenshots delivered. It must not add a model call to non-frontend tasks.

**F2 — pre-flight, before the expensive run.** When a request is frontend-shaped and no
browser is mounted, say so on the first turn's notice and in the read-back's `leave`
("no browser in this run: visual review will be a fetch, not a capture"); `rune doctor`
gains a browser line (Playwright module found / Chromium present / off by config). No
fabricated preview: a capture that names an origin the run did not serve is refused (already
so — pin it with a test that tries).

**F3 — the visual record, blind and rubric-bound.** `docs/program/visual-rubric.json`,
versioned: hierarchy, spacing rhythm, type scale, contrast, responsive integrity, state
clarity (loading / empty / error), focus visibility, consistency with a supplied reference.
`visual-review.ts` runs the rubric on the preserved screenshots with a reviewer that is NOT
the generating model (a different model family when one is configured, else recorded as
`no independent reviewer`), blind to the prompt, producing per-criterion `pass | fail |
unclear` with a one-line quote each and **no numeric score**. Recorded as evidence with
`verifier: "visual-review@1:<model>"` on a criterion of `method: review` — which M1 derives
as `needs_review`, never `satisfied`: a second model supplements; it cannot certify. The
screenshots and the defect list are preserved under the session's evidence directory and
named in `rune audit`.

**F4 — the architecture plan.** For architecture-shaped work the plan ledger's steps carry
`interface`, `invariant`, `migration` and `acceptance` fields when the model supplies them
(schema additive; the runtime never invents them), dependency order is checked (a step
naming a dependency on an open step cannot close), and a replan is requested when a check
fails on an earlier step's interface. No ten-call planning for every task: the section is
JIT, on architecture shape only.

**F5 — two fixtures** that the corpus lane will pick up: the form task (frontend family) and
the three-module dependent change whose step-3 test fails when step 1's interface is not
what step 3 assumed — the "late architectural inconsistency" the handoff asks for.

Exit: F1–F4 each with a test through the real engine and a scripted provider (zero model
calls); the existing `frontend-task` still passes in Chromium when `RUNE_TEST_PLAYWRIGHT`
is set (do not count a skip as a pass); the pre-flight refusal and the origin refusal pinned.

## What neither lane may claim

No "better design" without the rubric run by an independent reviewer on several varied
tasks; no capability improvement from one fixture; no live number without a budget; no
numeric aesthetic score from the generating model. Phase 5 closes when Lane F's exits hold
and Lane C's corpus has been run offline once with its false-completion rates written down.
