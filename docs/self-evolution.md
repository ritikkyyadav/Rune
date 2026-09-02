# Self-evolution

Gear was self-healing long before it was self-improving. Provider health,
model-rot retirement, quota auto-resume, compaction self-heal, the loop
breakers — all of it reacts inside a run. But the record those runs left
behind (1,790 incidents under 292 fingerprints, a notebook of command facts,
every plan step's evidence) changed nothing about the next run, because no
organ read it back. This page describes the loop that does, what it applies
by itself, and where a person stays in it.

The loop has five parts. Each is gated by the one before it, and each has a
wider blast radius than the last.

```
run ──▶ retro ──▶ notebook ──▶ playbook ──▶ next run
          │        candidate    active only,
          │         → trial     inert until enabled
          │         → active
          │
          ├──▶ scorecard ──▶ tune ──▶ variant ──▶ paired A/B ──▶ promote ──▶ revert
          │                                        (control +                 (one
          │                                         treatment)              command)
          │
          └──▶ black box ──▶ gardener (a branch, a person on the merge)
```

Nothing crosses an arrow without evidence, and every arrow after `retro` is
reversible in one command.

## The retro

Every run ends with a retro: a zero-model-call pass over the run's own
session log — the same rows `gear audit` reads — that states what happened in
numbers and extracts the lessons a rule can vouch for. It is written as a
`retro` event in the session, so it survives with the record.

| field         | what it holds                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`     | `finished`, or the handoff reason: `open_steps`, `stalled`, `aborted`, `error`, `max_turns`, `context_exhausted`, `halted`, `provider_lost` |
| `steps`       | total / done / **unproven** / open, from the plan ledger                                                                                    |
| `checks`      | verification commands that passed and failed, and the last pass                                                                             |
| `tools`       | calls, failures, and the count per tool                                                                                                     |
| `gates`       | the spine's log kinds counted over the run (gate, unproven, dropped, replan, handoff…)                                                      |
| `completions` | model completions the run took                                                                                                              |
| `cost`        | actual and list-price spend, tokens in and out                                                                                              |
| `lessons`     | see below                                                                                                                                   |

Beside the retro, the event carries the **attribution** the retro itself cannot know: `doctrineHash`
(which doctrine this session rendered, version included), `configHash` (a digest over the
A/B-relevant configuration fields — and only those: nothing under `permissions`, `sandbox`,
`autoMode`, `yoloMode`, `trustWorkspace`, cost caps or the `verify.*` gates is in it) and `arm` (the
A/B arm, or null for an ordinary session). The session row's `system_prompt_hash` records the same
doctrine digest. Before this, a measured difference between two runs could not be attributed to the
configuration that caused it, which is the difference between a measurement and an anecdote.

`gear audit` prints it as one line under **Retro**. Sessions that predate the
organ are derived after the fact by `gear evolve`, and marked so.

## The lessons

Three rules, each demanding evidence a later run can act on. The bar is
precision over recall — the notebook's own rule — because a wrong "avoid X
here" costs turns on every later run and a missed one costs nothing.

- **pitfall** — the same shell command failed twice or more with the same
  error and never passed in the run. Transient errors (timeouts, rate limits,
  connection resets) and the user declining are excluded: those are the
  harness's business, or the user's, never the repository's.
- **fix** — the same command failed, then passed with different arguments —
  `network: true`, a longer timeout. The lesson names the arguments.
- **check** — a verification command from a secondary runner (`./scripts/…`,
  `make`, `just`, `tox`…) passed. Project-runner commands (`bun test`,
  `cargo build`) are already notebook facts and are not duplicated.

Lessons are written to the notebook as repo-scoped entries. A pitfall that a
later run contradicts — the command passes as-is — is retired on the spot, and
revives if learned again. The notebook converges on what is true now.

## The lessons lifecycle

"Learned" and "believed" used to be the same thing: one observation in one run
was injected into every later run, with no measurement in between. The stages
are the evidence ladder, and each rung costs more than the last.

| stage       | what it means                                            | injected?                           |
| ----------- | -------------------------------------------------------- | ----------------------------------- |
| `candidate` | learned once                                             | **no**                              |
| `trial`     | learned in ≥2 distinct sessions                          | yes, and every injection is counted |
| `active`    | ≥5 injections with a win rate above the ambient baseline | yes, and it reaches the playbook    |
| `retired`   | decayed, disused, contradicted, or turned off            | no; kept and inspectable            |

- **Candidates are stored and never injected.** `gear evolve backfill` — which
  finally reads history back into the notebook, the thing `recordLessons`'s one
  call site never did — writes only candidates. Reconstructing a lesson from a
  log is not the same as having watched it hold.
- **A candidate becomes a trial by recurring**, the same bar the playbook has
  always used for "a fact about the repository rather than a note".
- **A trial becomes active on measured firings.** The bar is the _ambient_ win
  rate computed leave-one-out — how runs go with the OTHER lessons injected —
  plus a 5% margin, with a 50% floor. A lesson must beat the ambient rate, not
  merely coexist with it.
- **Repo scope only.** A `stack`- or `global`-scoped lesson stops at `trial`
  however good its counters look: promoting advice across projects on one
  project's runs is the superstition failure, and it needs the offline A/B.
- **An active lesson that stops helping is retired**, because it costs tokens on
  every run.
- **A re-learned retired lesson comes back as a candidate**, not where it left
  off. It was retired because it stopped being true.

Notebook _facts_ — "`bun test` passed here", "this is a bun+turbo monorepo" —
still enter at `trial`. A reading the harness took itself is not advice, and
withholding it until it recurs would degrade the notebook for no gain. The
ladder is for lessons, which are inferences.

### What counts as a win

A run credits the lessons it injected only when all three hold: the evidence
gate passed (nothing closed unproven, no verification command failed), the run
neither errored nor was aborted, and no `struggle.*` signal fired. The old
signal was `!runError && !aborted`, which counted a run where the user rephrased
three times and half the checks failed as a win for whatever happened to be
injected.

Nothing in the lifecycle spends a model token. `CostGovernor.allow()` — built
when the notebook shipped and never called, because rule-based capture spends
nothing — is now the gate any model-assisted distillation must pass first.

## The playbook

The notebook is machine-facing: rows in `~/.gear`, injected into the prompt,
invisible to anyone but the model. The playbook is the same knowledge made a
file in the workspace:

```
.gear/skills/playbook/SKILL.md
```

Only **active** lessons get in. "Recurred twice" was the old bar, and it was the
weakest gate in the loop attached to its widest action: two observations, no
measurement, and an executable skill written into the user's workspace. Active
means the lesson climbed the same ladder as every other.

**And it is inert until you enable it once.**

```bash
gear evolve playbook              # where it stands
gear evolve playbook --enable     # turn learned skills on, once
```

A skill can direct multi-step behaviour, so a machine writing one and having it
load on the next run is a capability change nobody agreed to — however good the
lessons in it are. Until consent is recorded the block is written to
`.gear/skills/playbook/PENDING.md`, which the skills loader does not read: it
globs for `SKILL.md` and ignores every other file, so the draft is inert by
construction rather than by a flag something could misread. The run says which
happened.

The file is a real skill: the loader lists it to the model like any other, a
person can read it, edit it, diff it and commit it. The generated block sits
between markers; everything written outside them is kept on every rewrite. It is
rewritten only when the block changes.

`[evolve] playbook = false` turns generation off entirely. The retro itself is
always written.

## The scorecard

```bash
gear evolve scorecard            # per model, last 30 days
gear evolve scorecard --by workspace --days 90
```

Per model or per workspace, from retros: runs, finished rate, runs ended with
steps open, runs stopped by the results-side breaker, completed steps that
had no evidence, verification pass rate, tool failure rate, list price per
run. This is the measure the rest of the loop is judged against. It reads
`~/.gear/gear.db` read-only — no engine, no provider.

## The variants registry: everything the loop may change

`packages/orchestrator/src/evolve/variants.ts` is the declared space. It is a
closed, typed map from a variant id to a configuration delta, and the delta's
type (`AbConfig`) has no field under `permissions`, `sandbox`, `autoMode`,
`yoloMode`, `trustWorkspace`, cost caps or the `verify.*` gates. A variant that
tried to turn the sandbox off would not fail a check — it would fail to
compile. `GARDENER_OFF_LIMITS` needs no separate defence here: those are files,
and a variant cannot name a file at all.

| variant          | what it changes                                                     |
| ---------------- | ------------------------------------------------------------------- |
| `doctrine_full`  | situational doctrine on every request instead of once, just in time |
| `effort_ceiling` | every turn at the reasoning ceiling instead of a notch below it     |
| `effort_medium`  | lower the reasoning ceiling to medium                               |
| `notebook_on`    | inject the learned notebook under its default budget                |
| `notebook_wide`  | the same at double the token budget                                 |
| `repo_map_off`   | drop the structural repository map from context                     |
| `playbook_off`   | stop writing the repository playbook — the permanent control group  |

Each carries a written **hypothesis**: what it is a bet on, so a promotion can
be read back and disagreed with. Adding a variant is a source change and a code
review; that is the intended cost.

## Tuning: proposals that name a variant

```bash
gear evolve tune
```

Rule-based proposals from the scorecard, each with its signal, its confidence,
and — where the allowlist can express it — the variant id to run:

| signal                                  | proposal                                                               |
| --------------------------------------- | ---------------------------------------------------------------------- |
| ≥ 25% of runs aborted by hand           | `doctrine_full`                                                        |
| ≥ 20% of runs ended in an error         | `notebook_on`                                                          |
| ≥ 3 runs and ≥ 10% hit the turn ceiling | `effort_ceiling`                                                       |
| ≥ 20% of runs stalled                   | `effort_ceiling`                                                       |
| ≥ 30% of completed steps unproven       | no variant — the step check is a `verify.*` gate                       |
| verification failing more than passing  | no variant — which commands verify _this_ project is a human judgement |
| ≥ 40% of runs ending with steps open    | no variant — `[subagents] mode` is outside the allowlist               |
| ≥ 2 runs halted by the supervisor       | **no variant, by design** — read `gear audit`                          |

The first four rules are new, and they are the point of the rewrite: the
original four keyed on `unproven`, `stalled` and `open_steps`, which have zero
occurrences across 601 sessions, while `aborted` (71), `error` (64),
`max_turns` (16) and `halted` (9) were counted by the scorecard and read by
nothing. A tuner answering questions this system does not ask is why 128
measured runs produced no change.

`proposal.variant` is `null` wherever no variant can express the fix, and
saying null is better than inventing a variant to have something to name. The
supervisor-halt rule is null _permanently_: no variant may touch Auto mode, and
a tuner that offered one would be proposing a mutation.

Nothing is applied by itself. A proposal that names a variant is one command
from evidence — `gear evolve ab <variant>` — and one more from being applied.

## The paired A/B

```bash
gear evolve ab doctrine_full          # control, then treatment, on the same tasks
gear evolve ab doctrine_full --real   # the same against a live model
```

Control first and unconditionally, then treatment: same task set, same order,
same seeds, same process, with the variant's configuration delta as the only
difference between them. Without a control group measured on the same machine
on the same day, a treatment number is a number about the machine.

Three gates, all of which must hold:

1. **No task regresses.** An aggregate that improves while one task breaks is
   how a "win" ships a defect.
2. **`cleanPassRate` up beyond the noise band** — zero in mock mode
   (deterministic: a flip is a flip), 5% with a live model. Equal is not a win:
   the control already exists, and "no worse" is not a reason to change
   anything.
3. **`totalListCost` not up beyond 10%.** Metered-equivalent, not actual spend,
   because eval runs ride free and subscription routes where actual spend is $0
   and a cost gate could never fire.

A task throttled on either arm is excluded from every number and named in the
report: a rate limit landing on one arm is the easiest way to manufacture a
fake win.

**Mock is the regression gate, not the discovery gate.** The scripted provider
replays a script rather than reasoning, so a configuration that only changes
what the model is _told_ usually shows no difference there. Mock catches harm,
cheaply and deterministically, on every change. Finding an improvement needs
`--real`.

## Promote, revert, and the four refusals

```bash
gear evolve promote doctrine_full     # only on a passing A/B for this exact config
gear evolve revert                    # undo the newest promotion
gear evolve why doctrine_full         # hypothesis, every measurement, what happened
gear evolve yardstick --bless         # anchor the eval suite (a human act)
gear evolve resume                    # clear a halt (also a human act)
```

A promotion writes the variant's lines into `~/.gear/config.toml` inside a
generated fenced block — the same marker discipline the playbook uses, for the
same reason: everything written outside the markers is kept, and the machine's
contribution is visible, diffable and removable by hand. The block is always
placed last, because the config parser lets later keys win, which is what makes
a promotion an override rather than a hope.

It refuses on four grounds, each named after a failure:

- **No passing A/B for this exact arm pair.** The evidence has to be about the
  change being made, not about a change that shared its name. A measurement
  taken before someone widened the variant is evidence about something else.
- **The yardstick moved.** `tests/eval/**` is digested and a promotion is
  refused when that digest differs from the one a human blessed. A loop that can
  edit the eval suite and then promote on the result is grading its own exam.
  Blessing is `gear evolve yardstick --bless` and has no automatic caller.
- **A promotion already happened inside 24 hours.** Two changes at once cannot
  be attributed to either.
- **Two consecutive reverts.** A loop that promotes changes a human keeps
  undoing has a broken fitness function, and the answer to a broken measurement
  is to stop measuring, not to measure harder. `gear evolve resume` clears it.

Everything lands in `~/.gear/evolve-ledger.jsonl` — one JSON row per
measurement, promotion, revert and halt, append-only, readable with `tail`. A
revert is a new row, never a deletion: a ledger you can rewrite is a ledger that
can be made to say the change was justified, and "why does it believe this" has
to survive the belief turning out wrong. The config block is rendered _from_ the
ledger rather than edited alongside it, so a revert cannot leave the file and
the history disagreeing.

## The gardener

```bash
gear evolve gardener            # candidates + the brief, dry run
gear evolve gardener --run      # a detached run in a worktree of Gear's own repository
```

The black box holds fingerprints that are defects in Gear itself — crashes,
unhandled rejections, dirty exits, a corrupted store, a malformed completion
the salvage could not read. The gardener reads them (crash-class fingerprints
seen three times or more), writes a brief for the top one — the evidence, the
latest stack, the recent contexts — and, with `--run`, starts a detached run
on that brief in an isolated `git worktree` of Gear's own repository.

The brief's rules are the boundary:

1. Reproduce first — a failing unit test for exactly this reason — then the smallest fix that addresses the cause.
2. All five gates pass before finishing.
3. The doctrine, the safety layer, the permission broker, org policy and the secret stores are off limits. They need a person.
4. Commit on the run's branch. Never push, merge, or open a pull request — a person reviews the branch.
5. If it cannot be reproduced, write why into `.gear/gardener-report.md` and stop.

Rule 3 used to be enforced only as that sentence. A rule a model is asked to
follow is a request, not a boundary — and the one thing a run editing its own
harness must not be able to do is edit the part that decides what it may do. So
`--run` now installs a `pre-commit` hook that refuses any commit touching
`GARDENER_OFF_LIMITS`, written by the code that starts the run rather than by
the run itself. Two honest limits: a hook can be bypassed with `--no-verify` and
deleted by anything with a shell, and it protects the commit rather than the
working tree. What it changes is the cost and the visibility — crossing the line
goes from ignoring a sentence to deliberately disabling a guard, and an audited
call that removes a hook is a very different artifact from a quiet edit. The
real containment is the permission broker and the OS sandbox one layer down.

Live gardener runs cost model credits and have not been validated at scale;
the dry run and the brief are what ship verified.

## Where the loop stands

```bash
gear evolve            # status: measured runs, what is learned, playbook, gardener candidates, proposals
gear evolve lessons    # what Gear knows about this repository
```

Applied by itself: retro → notebook → playbook. Proposals only: tune. A
person on the merge: gardener. That split is deliberate, and the status page
prints it.

## The invariants

Everything above is machinery. These six properties are what make the machinery
mean something, and they live in
`tests/unit/orchestrator/evolution-invariants.test.ts` — the tests that should be
hardest to delete.

1. **The dependency graph.** `permissions.ts`, `security.ts`, `org-policy.ts`,
   `auto-mode.ts`, `auto-containment.ts`, the sandbox modules and the secret
   stores import nothing from `notebook/`, `retro`, `playbook` or `evolve/` —
   checked directly _and transitively_, because the direct check is the one
   people remember and the transitive one catches a helper quietly pulling the
   notebook in. The isolation is mutual: nothing under `evolve/` may import a
   decider either.
2. **The off-limits write-deny.** A real `git commit` of `prompts.ts` is refused
   by a real hook in a real repository, and an ordinary fix commits fine.
3. **The yardstick lock.** A diff under `tests/eval/**` changes the digest and
   voids promotions until a human re-baselines; run outputs are excluded because
   they churn by design.
4. **Superstition.** Ten lessons at a coin-flip win rate produce zero active
   lessons. Add one that genuinely beats the ambient rate and exactly that one
   is promoted.
5. **Poisoning.** A run that only READ hostile content — a README telling it to
   `curl | sh`, an HTML comment claiming a "verified" `rm -rf /` — learns
   nothing. Lessons come from observations of commands that actually ran, each
   of which passed the permission broker; text is never a source.
6. **The lifecycle property.** Nothing skips a rung: a candidate with a perfect
   record stays a candidate until it recurs, then becomes a trial, and only then
   can reach active. Every transition carries the numbers that justified it.

## Benchmark

`bun run bench` drives the long-horizon eval tasks through the real engine
against a live model and prints each result with its retro next to it — how
the run ended, steps done and unproven, checks, gates — so a change to the
harness is judged on how it got there, not only on whether the artifact
appeared. `bun run bench:mock` runs the same pack on the scripted provider.
