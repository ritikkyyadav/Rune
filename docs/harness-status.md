# Rune: verified progress and remaining work

Last updated: 2026-09-10. This is the current status page; dated audit reports preserve the history.

**The overall goal is not yet achieved.** Rune has concrete reliability improvements, an installed
build and passing tests. We do not have evidence that it is the world's best harness, matches
OpenCode's cost across workloads, or improves itself reliably over long tasks.

## What is actually delivered

Installed locally: **Rune v0.4.1-dev+99a22f8**, CLI SHA-256
`a2be4b866aea31395611891d95ee716d789fb435d93f6ab5e0f493ba7a1b08a8`, native tools unchanged at
`4aedd8ed0b215ff04a308d884d2d6caa75684f43d4006ccac78414a349e3c287`, built 2026-09-10 00:52 IST from
`99a22f8` plus the whole working tree (the command-evidence, empty-completion, classifier and
ephemeral-tail changes below). The `ae1847c` delivery in the
[delivery manifest](evidence/verification-20260909-final.json) is the binary Pilots G and H ran;
the `961b8739…` build of 2026-09-09 23:38 IST ran Pilot I. All of these working changes are
**uncommitted**. A published 0.4.1 release should not be assumed to contain them.

| Problem                          | Delivered behavior                                                                                                                                  | What remains                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Sluggish Auto coordination       | Bounded, batched reviewer queue; ordinary mechanically allowed work does not stall behind a full background queue.                                  | Repeated live latency/cost evidence; skipped background reviews remain explicitly recorded.             |
| Broken compaction continuity     | The actual reduced working set survives Engine restart; opaque provider blocks and task state are preserved.                                        | Hours-long, repeated live restart stress.                                                               |
| Fragile subagents                | Workers receive dirty/untracked source and dependencies; integration detects lead changes; child checkpoints and leases support resume.             | Broader live worker and long-horizon evaluations.                                                       |
| Disconnected completion tracking | Custom test scripts count as checks; native child exits consistently feed plans, citations and live/replayed lessons. Writes invalidate old checks. | Command naming is still a heuristic, not proof of test coverage or intent satisfaction.                 |
| Sandbox/browser failures         | Chromium starts in foreground/background macOS containment, with tested denied reads/writes and secret stripping retained.                          | This pass does not prove Linux/Windows containment or VM isolation.                                     |
| Difficult TUI configuration      | Settings are visible at 80×24; one validator applies/persists settings; restart restores changes without inference.                                 | Broader usability feedback and connector coverage.                                                      |
| Weak frontend delivery           | Browser evidence, image delivery and revision checks exist; the latest generated frontend passed interactions and desktop/mobile checks.            | General design quality, architecture quality and external-browser receipt coverage are not established. |
| Excess cost                      | Shared spend reservations, usage attribution, task-scaled guidance and deferred schemas are implemented.                                            | Same-cost competitive parity remains unproven; older paired runs found Rune more expensive.             |
| Uncontrolled self-evolution      | Lesson promotion requires controlled outcome cohorts and cost/quality checks; unpriced/mixed cohorts do not establish benefit.                      | No measured controlled learning lift yet.                                                               |

Implementation detail and links: [audit follow-through](audit-followthrough-20260908.md).

## Evidence from the installed build

- **4,309 unit + 141 integration + 94 Rust tests passed**, zero failures. One unit skip needs a
  case-sensitive disk; five integration skips need Go/Java toolchains.
- **14 typecheck tasks, seven lint tasks, formatting and 63/63 mock evaluations passed.**
  The mock baseline was unchanged. These are engineering checks, not paid-model capability scores.
- **Actual TUI test:** open Settings at 80×24, edit the evidence gate, restart, confirm the saved
  value, and exit cleanly. Zero model usage events. Budget/concurrency values remained visible.
- **Actual browser tests:** both installed native execution paths launched Chromium and passed
  local interaction/screenshot checks while the tested path denials remained in force.
- **Actual model run:** on a copy of the previously generated frontend, Rune ran its browser
  test once, read both screenshots, cited the pass and closed the verification step. Normal exit,
  **53.4 seconds, six primary calls, $0.0647 estimated list cost**. Implementation and test bytes
  were unchanged. This was a targeted verification smoke, not a fresh coding benchmark.

Receipts: [local gates and artifact hashes](evidence/verification-20260909-final.json),
[live verification](evidence/verification-live-20260909.json).
Raw logs/databases remain private; their hashes are recorded. Aggregate comparison results
are preserved separately, with explicit corrections rather than overwritten failures.

## 2026-09-10: where Rune's time and money actually went in Pilot H

Pilot H ran the CSV task on the `ae1847c` binary: Rune passed acceptance but hit the 240 s limit
after 13 primary completions (16 usage entries with three supervisor calls) at an estimated
$0.158; OpenCode finished in 209.2 s with 9 steps at $0.112. Read from the run's own
`rune.db` (cost events and checkpoints) rather than from the summary:

- **Per-step cost was identical.** Rune $0.0122 per completion, OpenCode $0.0124 per step. The
  whole gap is the number of completions, not the price of one.
- **Three completions were lost to the command classifier.** `record_evidence` answered
  "nothing on record" twice for compound checks it had executed (`git diff --check && test "$(…)"
= 2 && git status --short`), so the model re-ran and re-cited. The fixed classifier in the
  working tree accepts both exact commands (checked directly, and in the unit suite); the
  frozen Pilot H binary predates it. With the fix the run would have been about 10 completions.
- **OpenCode spent three of its nine steps on its own todo list.** Rune's `read_back` and
  `record_evidence` completions are the same kind of bookkeeping; the ledger is not the differentiator.
- **The prompt cache stopped extending at 12,160 tokens for nine completions** while prompts
  grew from 14,927 to 18,212, so the whole conversation tail was re-billed every turn: about
  $0.042 of the $0.158, and the difference between Rune's cost and OpenCode's. Pilot G shows
  the same freeze (10,496 cached for sixteen completions) and so does the live verification run.
  Rune's request items were a byte-identical prefix of the next request's (rebuilt from the
  checkpoints through the real adapter), so Rune was not mutating its prompt. The freeze begins
  on the first request that carries the plan-ledger block as a trailing `user` message.

A live probe (`scripts/verify-codex-tail-cache.ts`, gpt-5.6-sol, reasoning low, one cache key per
variant) reproduced it on the same backend: a four-step tool loop that ends each request on
`function_call_output`, the Codex CLI's shape, extended its cache every turn (1,536 → 2,176 →
2,688 cached); the same loop ending on a ledger user message read 0 cached tokens on later turns
in one run and 0 / 2,176 / 1,536 in another; the same block appended to the last tool output
extended on three of four turns in an unpaused run. A paused five-turn run was lost to a 429 on
its last request and the quota is now exhausted, so the paused numbers are still owed.

**Delivered:** on the `codex` provider only, the ephemeral tail (plan ledger, team presence,
turn budget) now rides at the end of the last stable message instead of as a trailing user
message (`foldsEphemeralTail`, `withTailFolded`); every other host keeps the shape it had. The
composition meter reads the same on both shapes, the stored transcript never carries the
block, and the classifier also recognizes `turbo` / `nx` tasks. Gates on the installed build:
**4,363 unit passed, 1 skip, 0 failed** (unsandboxed); the two new integration suites 14/14;
orchestrator and gateway typecheck clean; formatting clean; **63/63 mock evaluations**,
governance 0.26 completions/task, baseline unchanged. Pilot I on the 23:38 binary was
**unscored** (Codex 429 after 56.7 s, three requests); no paired result exists yet for the
installed build.

## 2026-09-10, later: the step-count leaks, closed in the working tree

Four more changes landed after the cache fold, all pinned by tests and typechecked; the
full-suite confirmation, the install and the commit are queued behind the machine (below).

- **Silent re-prompts now say who they are.** Every finish gate, loop nudge and second wind
  tags the message it appends (`gate:execution-evidence`, `gate:open-steps`,
  `nudge:result-loop`, `wind`, …), the engine persists it as a `user_msg` event with a
  `harness` field, and each gate's notice names the gate. A detached run's database now
  shows what re-prompted the model. The dogfood case itself was the fix-verified gate: a
  `git commit` already counts as execution, so what re-prompted after the commit was the
  demand for a fail-on-parent test.
- **A settled plan stands the evidence gates down.** When every planned step is completed
  and none is unproven, the execution-evidence and fix-verified gates no longer refuse the
  finish; a write after a step's check already marks that step unproven, so an unverified
  last edit still trips them.
- **Same-response citations.** The check log is now written the moment a shell check returns,
  before the next call in the same batch, and a serial call is a barrier so calls run in the
  order the model gave them (`record_evidence` is a read-class tool and used to run in the
  parallel phase ahead of `bash`). `bash` then `record_evidence` in one response now records;
  the tool description says so. Measured in the engine regression: the citation costs one
  completion fewer than a separate one.
- **The recurrence detector sees failures.** Executed errors and deterministic refusals now
  count, refusals keyed on the tool they keep refusing, every answer in a batch is checked
  rather than only the last, and the second recurrence after the nudge ends the run with a
  resumable handoff. Before, five identical "Unknown tool" refusals beside productive reads
  were invisible, and the repeated-failure breaker kept refusing forever without stopping.
- **Narrate-then-silence.** An empty `end_turn` after tool results the model never spoke to
  gets one nudge and is then accepted on the earlier narration, never a failed run.
- **Supervision.** Under the default `unusual` scope, harness bookkeeping tools (`read_back`,
  `record_evidence`, `todo_write`, `ask_user`, `load_tools`, `compact_context`) are no longer
  screened; Pilot H spent a frontier-model screen on a `read_back`. The reviewer's model stays
  the session model by design (helper-route.ts states why); `[permissions.autoMode]
classifierModel` is the knob for a cheaper same-family reviewer, and is a founder's call.

Targeted gates: the seven affected suites pass (27 + 12 + 63/63 mock, baseline unchanged);
the doctrine is unchanged in size, since the same-response guidance rides in the tool
description instead. **The full-suite confirmation, the reinstall and the commit are queued:**
from about 02:30 IST the Mac has been in clamshell sleep on battery, waking for 2 to 6 seconds
every 25 to 30 seconds (`pmset -g log`: "Maintenance Sleep", one 908 s sleep). A plain Python
loop was frozen for 925 s; four unit tests that failed in that window failed on timing only.
`caffeinate` cannot override a closed lid on battery: plug the Mac in or open the lid, then run
`bun test tests/unit/` and `bash scripts/install.sh`.

## Next work, in order

1. Wake the machine, confirm the full suite, reinstall, commit the working tree in three
   chunks (the Codex session's audit follow-through, the cache fold, the step-count leaks).
2. Re-run the paused cache probe and Pilot H's CSV task on the new build against OpenCode when
   the Codex quota returns. The expectation, not a claim: about ten completions, a cache that
   extends every turn, and cost at or below OpenCode's on this task.
3. Repeat on the free route, three tasks by two runs, on the new build:
   `bun run tests/eval/comparison/runner.ts --real --model gpt-oss:120b --rune-provider
ollama-turbo --opencode-provider ollama-cloud --tasks csv-state-machine,working-tree-integration,dependent-migration
--runs 2 --budget-usd 1 --timeout-seconds 300 --out <fresh dir> --rune-bin ~/.rune/bin/rune-compiled`.
4. Use the measured request count and prompt breakdown to target what overhead remains.
   Do not substitute a schema-byte saving for a measured task-cost saving.
5. Repeat dependent changes and worker/restart tasks under fixed budgets; retain failures and
   check source artifacts independently of the model's completion claims.
6. Accumulate controlled lesson outcomes before claiming self-evolution helps. Run reproducible
   external benchmarks and OS-specific containment checks before broader competitive claims.

The license stays unchanged at the user's request. The local fixes do not alter the licensing decision.
