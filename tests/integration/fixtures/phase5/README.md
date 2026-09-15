# Phase 5 fixtures — two tasks the corpus lane adopts

Written 2026-09-15 by the Phase 5 Lane F session. These are the two fixtures
[the Phase 5 spec](../../../../docs/program/phase-5-frontend-architecture-m5-corpus.md)
asks Lane F to build and Lane C (the frozen diagnostic corpus, M5) to pick up:
the frontend family's second task and the migration family's
`dependent-migration`.

**They are plain files on purpose.** Nothing here imports from the corpus
runner, and nothing in the corpus runner is imported here, so the corpus lane
can adopt them by copying the directory to `tests/eval/corpus/<id>/` and adding
its own `scenarios/*.json` — the scripted-provider transcripts — without
touching anything Lane F owns. `task.json` and `acceptance.json` are already in
the shapes that lane's README specifies; `acceptance.json` is in the
`--acceptance` shape (`{ "criteria": [ { id, text, command, source } ] }`) and
is parsed by `parseAcceptanceSpecs`, which ignores the extra keys used here.

## Layout

```
<id>/
  task.json              id, family, the prompt verbatim, fixture files, constraints
  acceptance.json        evaluator criteria the model never sees, in the --acceptance shape
  files/                 the starting tree, copied to the workspace root
  solution/              a hand-written correct solution, copied OVER files/
  solution-inconsistent/ (dependent-interface only) the deliberate defect
```

Every command in `acceptance.json` runs from the workspace root and addresses
the tree by relative path, so a fixture can be materialised anywhere.

## The two tasks

**`form-states`** (frontend). A contact form that is unimplemented: three
fields from an existing schema module, validation on submit, and a state for
each thing that can be true — nothing typed, a refused submit, sending, sent —
plus keyboard operability, a visible focus ring, and a draft that survives a
reload. Eight criteria run offline against the pure exports (`validate`,
`renderForm`, `saveDraft`/`loadDraft`) and the stylesheet. One criterion,
`mobile-no-overflow`, needs a real browser: it prints `not-applicable` and
exits 0 when `RUNE_TEST_PLAYWRIGHT` is unset, which M1's acceptance semantics
derive as `needs_review` rather than as a pass. A skip is reported as a skip
and is never counted as a pass.

Two of the criteria are there because they are the ones a plausible-looking run
fails: `reuses-field-schema` (a second copy of the field list is the easy
wrong answer) and `no-second-palette` (a hex colour that is not one of the
project's tokens).

**`dependent-interface`** (migration). The three-module change the handoff asks
for, whose third step fails on the first step's interface. Step 1 replaces
`computeTotal(items) -> number` with `priceFor(sku, qty) -> Money`; step 2 moves
the discount tiers into `rules.js`; step 3 rewrites `checkout.js` onto step 1's
interface.

`solution-inconsistent/` is the defect, and it is the point of the fixture: its
`checkout.js` is written against the interface step 1 was ASSUMED to expose — a
bare number of cents — while step 1 exposes a Money object. Nothing throws,
nothing is a syntax error, the module imports cleanly, and the total renders as
`$NaN`. Measured against this acceptance it scores **5 of 7 green**: every
criterion that checks step 1 or step 2 in isolation passes, and only
`checkout-total` and `checkout-currency` — which exercise step 1's interface
_through_ step 3's caller — go red. That gap is what "the acceptance tests can
detect a late architectural inconsistency, rather than judging only the plan's
prose" means in practice.

## Running them

`tests/integration/frontend-loop.test.ts` and
`tests/integration/architecture-plan.test.ts` materialise each fixture in a
scratch directory, copy the solution over the starting tree, and run the
acceptance. The architecture test also runs it against
`solution-inconsistent/` and asserts the two seam criteria fail while the rest
hold. No model call is made by either.

## Rules

Per the spec: once these have been through an offline corpus run, no task is
added or dropped without a dated note. The prompts are verbatim and must not be
edited to make a run look better; if a prompt is genuinely ambiguous, the fix
is a new task with a new id.
