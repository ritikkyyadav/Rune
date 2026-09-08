# Audit response — 2026-09-06

On 2026-09-06 GPT-6 (via the Codex desktop app) audited Rune against OpenCode `bbd72fb`,
put Rune at roughly 70/100, and listed eight problems. This file records what was true,
what was done about it, what remains, and how it was verified — so the next audit starts
from evidence rather than rediscovery.

## The eight findings

All eight were **true against the committed code at `8d7c89f`**; the audit's line references
match those files exactly. Fixes then landed in the working tree in two waves (03:13–03:31 and
12:16–12:40 IST, by the same Codex session), and a review of those fixes found six residual
gaps, closed the same afternoon.

| #   | Finding                                                                   | Fix                                                                                                                                                                                                                                            | Residual gap, and its fix                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | One reviewer call per allowed action; 25 in flight; unbounded by the pool | `supervisor-queue.ts`: a 10 ms burst is batched, deduplicated by exact action key (≤8 keys / 24k chars per batch, split on user-message and write epochs); `ReviewSlots(2)` bounds background reviews. 25 identical actions → 1 call.          | A full queue **denied** the action. Now the action runs under the mechanical breakers and a `supervisor_skipped` row is recorded (also for a transcript at the reviewer's input limit). A repeat of a shape already waiting rides along; new shapes are refused at 64 pending, 256 total.                                                                    |
| 2   | Worker checkouts missed untracked files and installed dependencies        | `worker-snapshot.ts`: untracked source copied (≤10k files, ≤100 MiB, links checked), `node_modules` and `.venv` reflink-copied with links remapped; the snapshot is committed as the worker's base.                                            | Creation failures threw where they used to fall back. Now `WorkerIsolationError` (checkout cannot be created) falls back to the shared tree with an `[ISOLATION UNAVAILABLE]` note; `WorkerSnapshotError` (partial snapshot) still fails the dispatch. Provisioning cost is reported per worker; Go/pip/npm caches are pointed into the worktree for checks. |
| 3   | The ledger accepted "Implement and verify authentication" on one read     | `step-evidence.ts`: change-steps need a write, verify-steps need a passing check after the latest write; `todo_write` gained `kind`.                                                                                                           | A step with no recognisable verb and no `kind` closed on "something ran". Now such a step gets one note asking for its `kind`; `stepShape()` is the shared classifier.                                                                                                                                                                                       |
| 4   | No child continuity across task/worker dispatches                         | `delegated-sessions.ts`: `task_id` on both tools; the child transcript is checkpointed in the parent session's event store; model, workspace and ownership are pinned; overlapping resumes are refused; workers restore their retained branch. | The whole transcript was re-saved per follow-up. Now `compactCheckpointMessages` trims tool results to 1,500 chars, drops images, and removes whole exchanges oldest-first under a 256 KB ceiling, always keeping the prompt, the final report and every tool_use/tool_result pair.                                                                          |
| 5   | Any browser call or attached image satisfied "saw own work"               | `visual-verification.ts`: receipts at the current revision — a screenshot of a preview the workspace served, a ≤480 px and a ≥1024 px capture, and an interaction followed by a capture. Reference images no longer count.                     | The receipts need the Playwright browser, which is off by default, so every UI run ended "incomplete". Now a run without a browser accepts a fetch of the served page as its receipt and says once, at the finish, how to get screenshot review (`--browser`).                                                                                               |
| 6   | Lessons promoted on association                                           | `notebook/trials.ts`: deterministic include/withhold per session, 20 verified outcomes per arm per cohort, separated Wilson 95% intervals, cost per verified success ≤1.1× control; advice edits reset the trial.                              | None in code. Honest but inert at current run volume: the offline anchors (`docs/benchmarks.md`) are the realistic evidence path.                                                                                                                                                                                                                            |
| 7   | No reservation for concurrent spend; unpriced models weakened the cap     | `cost-tracker.ts`: `reserveRequest` holds an estimate synchronously before the provider call, released on completion, failure or stream cancel.                                                                                                | The hold charged the full output allowance at cache-write rates, refusing a third parallel child on paper. Now it is twice the running mean of observed output per model (ceiling = allowance). An unenforceable cap (unpriced model) is a one-line notice, not an error on the first request.                                                               |
| 8   | No independent yardstick; the benchmark scaffolding recorded no runs      | `tests/eval/comparison/`: a three-task Rune-vs-OpenCode pilot with isolated profiles, cost read from each harness's own database, fresh-process acceptance checks, alternating arms, recorded provenance.                                      | **Zero runs.** OpenCode 1.18.23 is installed and every flag the runner passes exists. Running it needs a credentialed model on both sides; see the plan.                                                                                                                                                                                                     |

## Verification

Run on the working tree after the gap fixes, sandbox off where the native sandbox is exercised:

| Check                                     | Result                                                    |
| ----------------------------------------- | --------------------------------------------------------- |
| Unit suite                                | 3,819 pass, 0 fail (323 files; 13 new tests)              |
| Typecheck, cache bypassed                 | 14 / 14 tasks, 0 errors                                   |
| Lint / format (prettier)                  | 7 / 7 tasks; format:check clean after formatting the wave |
| Offline Auto corpus vs 2026-09-03 base    | P 90.0 · R 89.1 · F1 89.6, +0.0pp                         |
| Integration (engine reliability, sandbox) | 6 pass, 0 fail                                            |

New regressions: a slow reviewer never denies ordinary work and unsupervised actions are
recorded; isolation vs snapshot errors and their cleanup; provisioning cost reported; the
resume checkpoint stays under its ceiling with tool pairs intact; reservations follow observed
output; the no-browser fetch receipt (and that a fetch never stands in for pixels); the `kind`
ask fires once.

## What is still open

- Nothing here is measured live. Only the comparison pilot moves the score:
  `bun run tests/eval/comparison/runner.ts --real --model <id> --out bench/pilot-1 --runs 3 --budget-usd 2`.
- The supervisor's token saving is designed and unit-tested, not counted on a real run: count
  `supervisor_screen` / `supervisor_reasoned` / `supervisor_skipped` rows in `rune.db` over the
  same hour on the old and new binaries.
- The worker's own shell (not just its checks) still gets the curated environment; Go and pip
  builds run by the worker itself, rather than by its check commands, keep the default caches.
- The lesson trial will not accumulate 40 scored sessions per lesson; run the anchors.
