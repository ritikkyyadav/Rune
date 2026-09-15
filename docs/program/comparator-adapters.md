# Comparator adapters — a Claude Code arm and a Codex arm for the frozen corpus

Written 2026-09-15 by the supervising session. The founder asked how Rune scores against
Claude Code and Codex. The honest answer today is "unmeasured": the comparison rig has a Rune
arm and an OpenCode arm, and the review's M5 says a comparator counts only once its adapter is
validated. This spec adds the two arms so that, once a live budget or quota is authorised, the
twelve-task corpus can produce a number that means something. Building and validating the
adapters is offline work; running them is not.

## What an arm must do (the same for every comparator, or the number is not comparable)

1. Materialise the task's fixture into a fresh directory (the corpus already does this).
2. Run the comparator headless on the task's prompt, verbatim, in that directory, with the
   same wall-clock limit, the same primary model and reasoning setting where the tool exposes
   one, and no network beyond the model host.
3. Capture: exit code, wall time, the tool's own usage report when it prints one (tokens,
   cost), stdout/stderr, and the resulting tree.
4. Grade with the task's `acceptance.json` — the same evaluator commands the Rune arm is
   graded with — from outside the workspace (the staging rule from Fix lane A).
5. Record infrastructure interruptions (quota, auth, timeout) as **unscored**, with usage
   retained; never as a failure of the comparator, never as a success.

## The two adapters

- **Claude Code**: `claude -p "<prompt>" --output-format json` in the fixture directory, with
  a permission setting that allows edits and shell in that directory only (the tool's own
  mechanism; document the exact flags and the version). The JSON envelope gives the result
  text, `duration_ms`, `total_cost_usd` when present, and `num_turns`.
- **Codex**: `codex exec "<prompt>"` (or the current non-interactive form; check `codex --help`
  at the pinned version) in the fixture directory, sandbox at the tool's workspace-write
  level, `--json` where available; parse its usage line when printed.

Both adapters live beside the OpenCode one in `tests/eval/comparison/` with the same
interface (`runArm(task, dir, limits) → ArmResult`). Version, flags and environment are pinned
in the corpus README; each adapter records the comparator's reported version in every result.

## Validation before any scoring (offline, no live call)

- **Argument construction**: a unit test per adapter asserts the exact argv and cwd for a
  sample task and the exact env passed (no provider keys beyond the comparator's own).
- **Parsing**: recorded sample outputs (checked in, credential-free) for success, quota
  refusal, auth failure, timeout and a malformed envelope → the adapter classifies each
  correctly (`scored` / `unscored:<reason>` / `error`).
- **Dry run**: `--dry-run` prints the plan for all twelve tasks without executing.
- **Refusal**: the live path refuses without `RUNE_EVAL_BUDGET_USD` (already the rule for the
  Rune and OpenCode arms; the same guard covers the new arms).

## What the number will and will not mean

Per the review's M5: report attempted tasks, infrastructure interruptions, accepted outcomes,
false completion, later-detected regressions, correction turns, wall time and all inference
overhead, with denominators; cost per accepted task includes failed attempts; subscription
quota is not dollars and is reported separately from API list cost; two model families before
any model-independence claim. A comparator run on a subscription (Claude Code on Max, Codex on
the plan) spends the founder's quota and is an external action: **it runs only when the
founder authorises it in their own words, with the task count and the arm order.** Until then
the adapters are validated and idle, and Rune's standing against these tools stays unmeasured.
