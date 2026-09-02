# Gear eval suite

The measurement layer every reliability claim rests on. Three tiers, cheapest first:

1. **Scripted mock suite** (this directory) — deterministic tasks driving the real engine
   with a scripted `MockProvider`. Verifies the _harness_: tool routing, permissions,
   audit chain, loop guards, context replay. Runs on every PR; must stay at 100%.
2. **Real-model runs** (`--real`) — the same tasks judged purely by artifacts, driven by a
   live provider. This measures _capability_ (ours + the model's). Nightly in CI when a
   key is configured; the clean rate over measured tasks is the number that matters.
3. **External anchors** — SWE-bench Lite / Terminal-Bench via a headless adapter
   (not yet built; tracked in the prescription plan, P1). Monthly, for calibration
   against the field — never leaderboard-chasing.

## Commands

```bash
bun run eval                          # mock suite (all tasks)
bun run eval -- --compare             # + regression gate vs the mode's baseline
bun run eval -- --tasks comprehension # one category (or a task-name substring)
bun run eval -- --real                # live model (needs the provider's API key)
bun run eval -- --real --compare --noise 0.05
bun run tests/eval/from-incidents.ts  # mine the black box for uncovered failure classes
```

Real-mode env: `GEAR_EVAL_PROVIDER` / `GEAR_EVAL_MODEL` (default google/gemini-2.5-flash),
`GEAR_MODEL_SWEEP="prov:model,prov:model"` for side-by-side runs.

## The rules the numbers depend on

- **Verify artifacts, never prose.** A task passes because the file changed, the test
  exited 0, the audit rows show the right order — not because the model said it did.
  No LLM-judged pass/fail anywhere in the suite.
- **Throttle ≠ failure.** A run defeated by a provider rate/usage limit with zero
  completed turns is excluded from the clean rate (marked ⚠). This is what keeps a
  free-tier quota from masquerading as a 16% agent.
- **Caps are verdicts.** Real runs get per-task tool-call (default 40,
  `GEAR_EVAL_TASK_MAX_TOOL_CALLS`) and optional cost caps (`GEAR_EVAL_TASK_MAX_COST`);
  blowing the cap fails the task even if the artifact eventually appeared.
- **Baselines are per-mode and protected.** Mock runs anchor `baseline-mock.json`
  (deterministic — any task flip is a regression); real runs anchor `baseline.json`
  (rate-gated within `--noise`). Subset runs (`--tasks`/`--max`) and runs that failed
  the gate never auto-promote; `--write-baseline` is the explicit override. `--compare`
  across different modes or models skips instead of guessing.
- Every run is archived to `results/` regardless.

## Incident → eval pipeline (the flywheel)

The black box (`~/.gear/blackbox.db`) fingerprints every failure. The contract:
**any class that fires ≥3 times gets a deterministic eval reproducing it.**

```bash
bun run tests/eval/from-incidents.ts              # report: which classes lack coverage
bun run tests/eval/from-incidents.ts --scaffold   # write task stubs for the uncovered ones
```

Workflow: finish the generated stub in `from-incidents/<fp>.task.ts` (real setup +
script + artifact verify), export it from `tasks-from-incidents.ts` (which feeds
`ALL_TASKS`), and record the fingerprint in `from-incidents/covered.json` so the miner
stops flagging it. Provider-throttle classes usually don't deserve evals (the harness
already discriminates throttles); crashes, tool failures, and loop incidents do.

## Adding a task by hand

Pick the family file (`tasks-<category>.ts`), follow the local idiom: `setup()` writes a
minimal fixture workspace, `script` is the deterministic model behavior for mock mode,
`verify()` checks artifacts and (in real mode) content invariants. Wire it into the
family's export array. Run `bun run eval -- --tasks <name>` until green, then a full
`bun run eval -- --compare` to refresh the mock baseline.

---

## The Auto-mode assurance report (`bun run eval:auto-safety`)

A separate corpus with its own runner and its own baseline, because it measures a different thing:
not whether the agent completes a task, but whether the safety layer's decisions are right.

```bash
bun run eval:auto-safety --offline            # no key, no network, no quota — runs on every change
bun run eval:auto-safety --offline --compare  # against tests/eval/baselines/auto-safety.json
bun run eval:auto-safety --provider <p>       # live, against a credentialed reviewer
bun run eval:auto-safety --json | jq '.rows | length'
bun run eval:auto-safety --list               # the corpus, with unreviewed labels marked "?"
```

**What it prints.** Precision, recall and F1 per decision _source_, per containment _kind_ and per
tool _category_, with Wilson confidence intervals; p50/p95 of `classifierMs` (not `durationMs`,
which averages a regex match with a nine-second model call and describes neither); cost per decision
at list price from real token usage; and the supervisor's own false-positive rate from the same run.

**Positive is BLOCK.** Recall is the share of unsafe actions stopped — the safety number. Precision
is the share of blocks that were warranted — the approval-fatigue number. They trade against each
other, which is why one blended score was never enough.

**The offline contract.** Every corpus row declares whether the _mechanical_ layer alone reaches the
correct verdict. Offline, only those rows are a contract; a `mechanical: false` row is expected to
resolve the other way, because a reviewer-required decision with no reviewer is exactly what
containment is for. The two groups are reported separately rather than folded into one pass rate —
the difference between "99% correct" and the true statement, which is "this fraction is correct with
no model at all, this fraction needs one, and here is what happens to the second fraction during an
outage".

**The gate.** A mechanical block that stops holding is a safety regression. An allow row that starts
being blocked is an approval-fatigue regression, and this system's history says that is the one that
actually ends runs. Reviewer-only blocks are reported, never gated.

**Budget.** `--max-requests` (default 250) is a real ceiling: the runner stops calling the reviewer
and says so in the report rather than quietly spending more.

**Unreviewed labels.** Rows whose label was inferred rather than derived carry `reviewed: false` and
are listed by `--list`. They stay in the corpus and in the aggregate numbers, because hiding an
uncertain label is worse than reporting one.
