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
          │
          ├──▶ scorecard ──▶ tune (proposals only)
          │
          └──▶ black box ──▶ gardener (a branch, a person on the merge)
```

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

Lessons are written to the notebook as repo-scoped entries, which the next
session is briefed from under the existing 600-token budget. A pitfall that a
later run contradicts — the command passes as-is — is retired on the spot,
and revives if learned again. The notebook converges on what is true now.

## The playbook

The notebook is machine-facing: rows in `~/.gear`, injected into the prompt,
invisible to anyone but the model. The playbook is the same knowledge made a
file in the workspace:

```
.gear/skills/playbook/SKILL.md
```

Only lessons that **recurred** get in — two sessions or more. One session's
observation is a note; two are a fact about the repository. The file is a
real skill: the loader lists it to the model like any other, a person can read
it, edit it, diff it and commit it. The generated block sits between markers;
everything written outside them is kept on every rewrite. It is rewritten
only when the block changes, and the run says so with one notice.

`[evolve] playbook = false` turns the file off. The retro itself is always
written.

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

## Tuning: proposals, never applications

```bash
gear evolve tune
```

Rule-based proposals from the scorecard, each with its signal, its
confidence, and the config line that would apply it:

- ≥ 30% of completed steps unproven → keep the step check, route planning to a heavier tier
- ≥ 20% of runs stalled → broad reads up front, not a longer leash
- verification failing more than passing → pin `[verify] commands`
- ≥ 40% of runs ending with steps open → sub-agents for the parallel parts

Nothing is applied by itself. The A/B over enough runs that would justify
applying a proposal is not built, and this page says so rather than
pretending the rule is the evidence.

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

## Benchmark

`bun run bench` drives the long-horizon eval tasks through the real engine
against a live model and prints each result with its retro next to it — how
the run ended, steps done and unproven, checks, gates — so a change to the
harness is judged on how it got there, not only on whether the artifact
appeared. `bun run bench:mock` runs the same pack on the scripted provider.
