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
