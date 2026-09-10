# Phase 2 — one durable task lifecycle

**Written 2026-09-10 at `7522459` (branch `gear/phase-0-stabilize`), read-only survey.** This
is the design the build lanes execute from. It maps what exists today with file:line for every
claim, names where the three consumers disagree, proposes one shared type, specifies the
process-level scenario, and splits the build into three lanes with disjoint file ownership.

Nothing here was changed. No source or test file was modified, no model was called, no
provider was billed. Two numbers below were measured by read-only queries against the
founder's own `~/.rune/rune.db`; they are stated as measurements, not as estimates.

---

## 1. The lifecycle map as it exists today

There is no lifecycle object. There are eight concepts, each defined in a different module,
persisted (or not) by a different mechanism, and reaching each of the three consumers — the
TUI, the persisted session, and the headless envelope — by a different route. The table is
the summary; the subsections carry the citations and the gaps.

| Concept            | Defined                                                                  | Persisted            | Reaches TUI                  | Reaches headless                   |
| ------------------ | ------------------------------------------------------------------------ | -------------------- | ---------------------------- | ---------------------------------- |
| task id            | `sessions.id` (`packages/shared/src/session.ts:58`)                      | column               | —                            | `sessionId` (opt-in)               |
| child task id      | `Checkpoint.id` (`packages/orchestrator/src/delegated-sessions.ts:11`)   | `events` JSON        | inside a tool result         | inside a tool result               |
| objective          | `TaskState.goal` (`packages/orchestrator/src/task-state.ts:97`)          | `events` JSON        | —                            | —                                  |
| user constraints   | `Brief.criteria` (`packages/orchestrator/src/brief.ts:105` via protocol) | **nothing**          | round-trip                   | **nothing**                        |
| workspace revision | —                                                                        | **nothing**          | —                            | —                                  |
| cancellation       | `AbortController` (`packages/orchestrator/src/engine.ts:1167`)           | trace only           | `turn_complete`              | `stopReason`                       |
| budget (turns)     | `turnBudgetForMessage` (`packages/orchestrator/src/turn-budget.ts:51`)   | **nothing**          | `turn_complete.totalTurns`   | —                                  |
| budget (spend)     | `CostTracker` (`packages/llm-gateway/src/cost-tracker.ts:107`)           | `cost` events        | footer                       | `usage.*` tokens only              |
| checkpoint         | `RunState` (`packages/shared/src/state.ts:5`)                            | `checkpoints` table  | `checkpoint_saved`           | ignored                            |
| evidence           | `StepEvidence` (`packages/protocol/src/task.ts:15`)                      | `task_state` JSON    | `todo_updated`, `step_check` | ignored                            |
| files changed      | —                                                                        | `writtenPaths` scope | a third definition           | a fourth definition                |
| terminal result    | `turn_complete.stopReason` (`packages/protocol/src/events.ts:38`)        | **nothing**          | 3 of 7 reasons               | `stopReason`, 4 of 7 silently `ok` |

### 1.1 Task id and parent id

The lead's identity is the session row: `sessions.id`, a UUIDv7 minted in
`SessionManager.createSession` (`packages/shared/src/session.ts:194-222`, id at `:200`).
There is no separate "task" identity for lead work; a task boundary is a _goal roll_ inside
`TaskStateStore.beginTurn` (`packages/orchestrator/src/task-state.ts:571-589`), which
archives the old goal into `priorGoals` and keeps the same session id.

A child's identity is `task_<uuid>`, minted in `withDelegatedSessions`
(`packages/orchestrator/src/delegated-sessions.ts:214-215`) and validated by
`/^task_[a-f0-9-]{36}$/` at `:203`. It is persisted as an `events` row of type
`delegation_checkpoint` (`:35-42`), read back with
`SessionManager.getLatestKeyedEvent(parent, "delegation_checkpoint", id)`
(`packages/shared/src/session.ts:344-353`).

**The parent link is implicit.** The checkpoint row's `events.session_id` _is_ the parent;
there is no `parent_id` column and children get no `sessions` row
(`packages/orchestrator/src/delegated-sessions.ts:21-22`).

A worker's fleet id is `w${++workerSeq}` from a module-level counter
(`packages/orchestrator/src/worker.ts:447`, `:492`). It reaches the TUI as
`ChildAgentEvent.agentId` (`packages/protocol/src/events.ts:212-214`) and is never persisted.

> **Gap 1.1a — no event carries a task id.** Every member of `AgentTurnEvent`
> (`packages/protocol/src/events.ts:27-201`) is anonymous. A child's `task_id` reaches the
> parent only as text appended to the tool result and as `structured.task_id`
> (`packages/orchestrator/src/delegated-sessions.ts:267-271`). The TUI cannot key a row to a
> task, and headless cannot report which children a run created.
>
> **Gap 1.1b — worker ids are not durable.** `workerSeq` resets to 0 on process start. After
> a crash, the next dispatch is `w1` again, `.rune/worktrees/w1` and `refs/heads/rune/worker-w1`
> both already exist, and `createWorkerWorktree` throws `WorkerIsolationError`
> (`packages/orchestrator/src/worker-worktree.ts:157`, `:161-164`). That is caught at
> `packages/orchestrator/src/worker.ts:557-563` and silently degrades the worker to a
> shell-less shared-tree run. A crash therefore _permanently degrades every later worker in
> that repository_ until someone deletes the branch by hand.

### 1.2 Objective and user constraints

The objective is `TaskState.goal` (`packages/orchestrator/src/task-state.ts:97`), capped at
24 000 chars (`GOAL_CAP`, `:202`). It is persisted inside the `task_state` event payload,
written by `persistTaskState` (`packages/orchestrator/src/engine.ts:4548-4565`) and restored
by `TaskStateStore.fromEvents` (`packages/orchestrator/src/task-state.ts:1825-1836`), which
scans backwards for the latest `version === 1` snapshot. **This is the one lifecycle field
whose restart story is complete and tested** (`tests/integration/engine-task-state.test.ts:82`).

Mid-run steering reaches the spine through `AgentLoop.drainInterjections`
(`packages/orchestrator/src/agent-loop.ts:1025-1038`) → `TaskStateStore.noteSteer`
(`packages/orchestrator/src/task-state.ts:596-604`), and undrained interjections are
persisted as `user_msg` rows at run end (`packages/orchestrator/src/engine.ts:5290-5296`).

> **Gap 1.2a — steering is truncated to 200 characters** on the spine
> (`packages/orchestrator/src/task-state.ts:598`, `:585` for `pendingGoal`). A 400-character
> mid-task correction survives in the transcript but not in the durable spine, so after a
> compaction that drops the transcript tail the correction is gone.

"User constraints" as a machine-checkable object are `Brief.criteria` — the `read_back`
contract. `this.brief` and `this.ledger` are plain Engine fields
(`packages/orchestrator/src/engine.ts:1447-1448`, read at `:2273`, `:2278`, `:4871-4873`).

> **Gap 1.2b — the brief and its ledger are never persisted.** There is no `brief` session
> event type anywhere in the repo. `BriefLedger` (`packages/orchestrator/src/brief.ts:87`)
> holds every criterion and its rung (`unmet → reproduced → verified`); a restart discards
> all of it, so a resumed run cannot know which acceptance criteria were already met. This is
> a direct failure of the handoff's "user constraints and unfinished dependencies survive".
>
> **Gap 1.2c — the brief reaches only one consumer.** `setBriefHandler` is called by the TUI
> (`packages/orchestrator/src/bin/ui/tui.ts:671`) and by the engine host
> (`packages/orchestrator/src/bin/engine-host.ts:523`). `runHeadless` never sets one, so with
> no handler the read-back confirmation is skipped
> (`packages/orchestrator/src/engine.ts:1428-1429`) — the brief is still recorded in memory,
> but the headless envelope has no field for it.

### 1.3 Workspace revision

**Nothing records the workspace revision a run started from.** `sessions.workspace_root`
(`packages/shared/src/session.ts:60`) is a path, not a revision. The only git identity in any
schema is `instances.branch` in the _team_ bus (`packages/orchestrator/src/team/bus.ts:157-169`,
derived at `packages/orchestrator/src/team/repo-key.ts:42-49`), which exists only when
`[team] enabled` (`packages/orchestrator/src/engine.ts:1560`).

A commit sha reaches disk in exactly one place, as prose: the auto-commit marker
`{type:"checkpoint", payload:{summary:"auto-commit <shortSha>"}}`
(`packages/orchestrator/src/engine.ts:5258-5261`) — and auto-commit is opt-in
(`[git] autoCommit`, `packages/orchestrator/src/engine.ts:5250`) and runs only on clean
completion. Dirty state is computed on demand and never stored
(`packages/orchestrator/src/git-undo.ts:117`, `:203-242`).

Worker isolation _does_ record a revision: `Checkpoint.retainedWorker = {branch, baseCommit,
recoveryPath}` (`packages/orchestrator/src/delegated-sessions.ts:18`), with `baseCommit`
captured at `packages/orchestrator/src/worker-worktree.ts:202`.

> **Gap 1.3 — evidence has no revision to be stale against.** `record_evidence` compares a
> command's result on the working tree with the same command re-run on the parent commit
> (`packages/orchestrator/src/engine.ts:1476-1487` → `parent-check.ts`), but neither the
> criterion nor the resulting rung stores _which_ revision produced it. After a restart there
> is nothing to compare a stored verdict against, which is why the acceptance criterion "no
> verified status for stale evidence" currently has no durable anchor.

### 1.4 Cancellation

Live cancellation is an in-memory `AbortController`: `engine.currentAbort`
(`packages/orchestrator/src/engine.ts:1167`), set per turn at `:4793-4795`, tripped by
`abort()` at `:5652-5655`, cleared at `:5495-5496`. It is propagated to tools as
`input.signal` and forwarded to the native binary as SIGTERM then SIGKILL after 1.5 s
(`packages/tool-registry/src/tools/rust-bridge.ts:148-162`).

Cancellation leaves three persisted traces, all JSON, all written in the `finally` block:
`task_state.handoff = {reason:"aborted", …}` (`packages/orchestrator/src/engine.ts:5304-5313`),
`retro.outcome` (`:5371`, decided by `packages/orchestrator/src/retro.ts:357-372`), and a
`system_note` (`:5298-5302`). A SIGKILL runs none of them.

### 1.5 Budget

Three independent budgets, none durable.

- **Turns.** `policyForModel` (`packages/orchestrator/src/reliability-policy.ts:89`) resolves
  `maxTurns` (default 80, `:72`) and `secondWinds` (default 2, `:73`); `turnBudgetForMessage`
  (`packages/orchestrator/src/turn-budget.ts:51`) narrows it for conversational messages.
  Both are computed at run start (`packages/orchestrator/src/engine.ts:4627-4629`) and exist
  only in the loop's locals. `turn_complete.totalTurns` is the only turn number that leaves
  the loop (`packages/protocol/src/events.ts:38`).
- **Tokens.** Provider-authoritative usage arrives as the `usage` event
  (`packages/protocol/src/events.ts:87-109`) and is persisted twice: as a `cost` event
  (`packages/orchestrator/src/engine.ts:5757-5765`) and as a `run_trace` row (`:5226-5232`).
  Context occupancy is the one first-class token column, `sessions.last_tokens`
  (`packages/shared/src/session.ts:181-186`).
- **Spend reservations.** `CostTracker.reservations` is a `Map<symbol, number>`
  (`packages/llm-gateway/src/cost-tracker.ts:117`); `reserveRequest` (`:194-233`) admits or
  throws `BudgetExceededError`, and the returned closure releases (`:230-232`). The spend
  _ledger_ is rebuilt on resume by replaying `cost` events (`activateCostSession`,
  `packages/orchestrator/src/engine.ts:5709-5741`) — but the reservations and the
  `observedOutput` running means (`packages/llm-gateway/src/cost-tracker.ts:124`, which size
  every reservation at `:235-240`) are lost.

> **Gap 1.5a — turn budget does not survive a restart.** A run killed at turn 60 of 80
> resumes with a fresh 80-turn ceiling and fresh second winds. That is a cost defect as much
> as a correctness one.
>
> **Gap 1.5b — a delegated child's budget resets on resume.** `resolveSubagentBudget`
> (`packages/orchestrator/src/subagent-budget.ts:48-63`) and
> `budgetState = {spentUsd: 0, startedAt: Date.now()}` are re-created inside `execute`
> (`packages/orchestrator/src/worker.ts:664`, `packages/orchestrator/src/subagent.ts:379`).
> `Checkpoint` (`packages/orchestrator/src/delegated-sessions.ts:9-19`) has no budget field,
> so resuming a `task_id` grants a fresh cost cap and a fresh deadline clock every time.

### 1.6 Checkpoint

Three unrelated things share the word.

1. **`RunState` in the `checkpoints` table** — `packages/shared/src/state.ts:5-13`, schema at
   `:48-60`, saved by `SqliteCheckpointStore.save` (`:74-91`). The Engine writes one every
   `intervalTurns` turns (`packages/orchestrator/src/engine.ts:5004-5022`) and after every
   successful `write_file`/`edit_file` (`:5171-5194`), then emits `checkpoint_saved`.
2. **`delegation_checkpoint`** — the child resume record
   (`packages/orchestrator/src/delegated-sessions.ts:9-19`), bounded to 256 KiB by
   `compactCheckpointMessages` (`:84-132`).
3. **`{type:"checkpoint", payload:{summary}}` marker rows** — `"session_started"`
   (`packages/orchestrator/src/engine.ts:4616-4619`), `"session_ended"` (`:5336-5339`),
   `"auto-checkpoint at turn N"` (`:5024-5028`).

> **Gap 1.6a — the `checkpoints` table is write-only, and it is 74% of the database.**
> `runId = ${sessionId}-${Date.now()}` (`packages/orchestrator/src/engine.ts:4513`) is a new
> value every turn, so no row can ever be addressed after a restart. The only calls to
> `.load()` are the two verification reads immediately after `.save()` (`:5016`, `:5188`);
> `resumeFromCheckpoint` (`packages/orchestrator/src/session-replay.ts:287-294`) is imported
> at `packages/orchestrator/src/engine.ts:159` and **never called**. Measured on
> `~/.rune/rune.db` on 2026-09-10: **747 rows holding 193 414 376 bytes (184 MiB) of a
> 250 MiB database**, spanning 2026-05-30 to 2026-09-09, never read, never pruned. By
> comparison the spine that _is_ read back is `task_state` at 1 245 rows / 6.0 MiB and
> `auto_compaction` at 73 rows / 1.6 MiB.
>
> **Gap 1.6b — the interval checkpoint is dead code.** `turnCount` is declared inside
> `chat()` (`packages/orchestrator/src/engine.ts:4790`) and incremented only on
> `turn_complete` (`:5001`), which the loop emits exactly once per `chat()` call. So
> `turnCount % this.checkpointPolicy.intervalTurns === 0` (`:5004`, interval 5,
> `packages/shared/src/state.ts:31`) is never true. Only the write-tool path at `:5171` ever
> fires.
>
> **Gap 1.6c — no test covers any of it.** `enableCheckpoints` defaults to on
> (`packages/orchestrator/src/engine.ts:1861`) but every Engine-constructing test sets it
> `false`, and no test imports `SqliteCheckpointStore`.
>
> **Gap 1.6d — the child checkpoint is written only after the child returns.**
> `store.save(...)` runs after `handler.execute(input)` resolves
> (`packages/orchestrator/src/delegated-sessions.ts:255-266`). A crash during a four-minute
> worker loses the whole child transcript. Measured: **0 `delegation_checkpoint` rows** in
> `~/.rune/rune.db` against 58 `worker` and 95 `task` tool calls lifetime (3 of them since
> the feature landed on 2026-09-06). The `task_id` resume path has zero production evidence.

### 1.7 Evidence

Everything is inside the single `task_state` JSON payload: `todos[]`
(`packages/protocol/src/task.ts:55-93`) each carrying `StepEvidence` (`:15-53`), plus
`state.checks[]` of `CheckRecord` (pushed at
`packages/orchestrator/src/task-state.ts:691-705`, capped at 60 by `CHECKS_CAP` at `:187`),
plus `state.narrative.hypotheses[]` / `.decisions[]` carrying `EvidenceRef`
(`packages/protocol/src/task.ts:120-135`). The one columnar evidence store is `audit_log`
(`packages/shared/src/session.ts:103-114`), hash-chained and verified by `verifyAuditChain`
(`:459-500`).

Evidence reaches the TUI as `todo_updated` (`packages/protocol/src/events.ts:57`),
`step_check` (`:60`) and `verification_completed` (`:42-48`). **Headless names all three in
its reducer and counts none of them** (`packages/orchestrator/src/headless.ts:218-221`).

### 1.8 Terminal result

`turn_complete { stopReason, totalTurns }` (`packages/protocol/src/events.ts:38`) is the
loop's terminal verdict, emitted from `agent-loop.ts` with `end_turn` (`:999`), `aborted`
(`:1327`, `:1728`, `:1818`, `:2670`, `:3917`), `provider_lost` (`:1977`), `halted` (`:2025`),
`max_tokens` (`:2084`), `max_turns` (`:4142-4145`), and **the provider's own value verbatim**
(`:1673` → `:2567`, e.g. `tool_use`).

Running in parallel is `HandoffReason` (`packages/protocol/src/task.ts:258-270`), eight
values, emitted by `handoffEvents` (`agent-loop.ts:1014-1019`) only when `hasOpenTodos()`.

> **Gap 1.8a — `turn_complete` is never persisted.** `RUN_TRACE_EVENTS`
> (`packages/orchestrator/src/engine.ts:329-341`) is a hand-written set of twelve types and
> `turn_complete` is not one of them, nor does it have a row of its own. The durable proxies
> are `task_state.handoff` — written only when `hasOpenTodos()` is true (safety net at
> `packages/orchestrator/src/engine.ts:5304-5313`) — and `retro.outcome`
> (`packages/orchestrator/src/retro.ts:357-372`). A run that hits `max_turns` with a fully
> closed plan leaves no durable record of how it ended.
>
> **Gap 1.8b — `replayEvents` is not covered by the drift law.**
> `tests/unit/protocol/exhaustiveness.test.ts:47-63` guards exactly three reducers: the TUI
> transcript (`bin/ui/turn.ts` `onEvent`), the TUI formatter (`bin/ui/events.ts`
> `formatEvent`), and `headless.ts` `runHeadless`. The persisted-session reducer —
> `replayEvents` at `packages/orchestrator/src/engine.ts:360-506`, plus the `RUN_TRACE_EVENTS`
> allow-list at `:329` — is the _third consumer the phase is about_ and nothing stops it
> drifting. A **fourth** live consumer is unguarded too:
> `packages/orchestrator/src/bin/ui/tui.ts:5361-5396` reduces the same stream as a chain of
> `if (ev.type === …)` with no `assertNever` and no test. The test itself is a source-text
> scan — it slices each file from an anchor to EOF and collects `case "…":` labels
> (`exhaustiveness.test.ts:65-89`), so it cannot tell a rendering case from an empty one, and
> three `formatEvent` branches are in fact unreachable in the shipped TUI (`tool_call_end`
> `events.ts:146`, `todo_updated` `:156`, `turn_complete` `:268` — `turn.ts` renders all three
> itself and never calls `formatEvent` for them).
>
> **Gap 1.8c — a run with open steps reports success.** The finish path emits
> `handoffEvents("open_steps")` (`agent-loop.ts:2529`) and then falls through to
> `turn_complete { stopReason }` with the accumulated `stopReason`, normally `end_turn`
> (`:2567`). `UNFINISHED_STOP` (`headless.ts:289-294`) does not know `open_steps`, so
> `runHeadless` returns `ok: true` and exit code 0 for a run that ended with planned steps
> open. This is the same class of defect the module's own comment at `headless.ts:206-210`
> records having already fixed once.
>
> **Gap 1.8d — two terminal paths emit no `turn_complete` at all.** The stall path yields
> `handoff{stalled}` then a non-recoverable `error` and returns
> (`agent-loop.ts:3820-3829`; same shape at `:4048`). The envelope then carries `error` but no
> `stopReason` key, because `JSON.stringify` drops an `undefined` value
> (`headless.ts:333-334`).
>
> **Gap 1.8e — `HandoffReason: "context_exhausted"` is declared and never emitted**
> (`packages/protocol/src/task.ts:260`; the only other mention is a comment at
> `retro.ts:967`). A consumer switching on the full union handles a case that cannot occur,
> while the case that _does_ occur — an overlarge fixed prompt — arrives as `provider_lost`
> (Gap 1.5/§6 G15).

### 1.9 Where the three consumers disagree

`AgentTurnEvent` has **30** members (`packages/protocol/src/events.ts:27-202`, manifest at
`:269-300`; the test's own header comment at `exhaustiveness.test.ts:4` still says 22, and
`docs/protocol.md:347-349` still claims five reducers for a repo that has three).

| Value                                      | TUI                                                                                                                                                                                                                           | Persisted session                                                                                                                                                                                                               | Headless envelope                                                                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task / parent id                           | not carried by any event; session id lives on the wire envelope only (`commands.ts:399`)                                                                                                                                      | `sessions.id`; child id in `delegation_checkpoint` JSON                                                                                                                                                                         | `sessionId` only when the caller passes it (`headless.ts:329`, supplied at `rune-cli.ts:1499`)                                                                                      |
| objective (goal)                           | never rendered as a field                                                                                                                                                                                                     | `task_state.goal`                                                                                                                                                                                                               | absent                                                                                                                                                                              |
| user constraints (brief criteria)          | `brief_request` round-trip (`packages/protocol/src/commands.ts:403`)                                                                                                                                                          | **absent**                                                                                                                                                                                                                      | **absent** — `runHeadless` sets no brief handler                                                                                                                                    |
| workspace revision                         | short sha inside `notice` prose (`engine.ts:5257-5262`)                                                                                                                                                                       | short sha inside auto-commit prose                                                                                                                                                                                              | absent                                                                                                                                                                              |
| cancellation                               | **discarded** — `turn.ts:2186-2192` latches only `max_turns\|max_tokens\|halted`; the TUI uses its own local `this.aborting` flag instead (`tui.ts:474`, `:5225`, `:5406`)                                                    | `handoff.reason` + `retro.outcome`                                                                                                                                                                                              | `stopReason:"aborted"` → `UNFINISHED_STOP` (`headless.ts:290`)                                                                                                                      |
| `provider_lost`                            | not in the TUI early-stop set                                                                                                                                                                                                 | `retro.outcome:"provider_lost"`                                                                                                                                                                                                 | **not** in `UNFINISHED_STOP`; surfaces only as the separate non-recoverable `error`                                                                                                 |
| `open_steps` / provider-verbatim stop      | not recognised                                                                                                                                                                                                                | `handoff.reason:"open_steps"`                                                                                                                                                                                                   | **`ok:true`, exit 0** (Gap 1.8c)                                                                                                                                                    |
| turns used                                 | `turn_complete.totalTurns` → `this.turnCount` (`turn.ts:2180`), **never read**; the header shows `listUserTurns().length + 1` instead (`tui.ts:2256`), a different quantity                                                   | only inside `checkpoints.state_json`, which nothing reads                                                                                                                                                                       | **absent**                                                                                                                                                                          |
| turns remaining                            | injected into the model's prompt as text (`agent-loop.ts:1520-1536`)                                                                                                                                                          | absent                                                                                                                                                                                                                          | absent                                                                                                                                                                              |
| spend                                      | footer via out-of-band `getCost()` (`turn.ts:84`, `tui.ts:5314`)                                                                                                                                                              | `cost` events                                                                                                                                                                                                                   | **absent** — only `usage.{inputTokens,outputTokens,cacheReadTokens}`                                                                                                                |
| `usage.cacheCreationTokens`, `usage.model` | **read by nobody** (`turn.ts:2074-2084` keeps `outputTokens` + `context.percent`)                                                                                                                                             | in the `cost` row                                                                                                                                                                                                               | dropped (`headless.ts:176-180`)                                                                                                                                                     |
| checkpoint written                         | `checkpoint_saved` → dead fields `turn.ts:634-635`; `formatEvent` returns `null` (`events.ts:282`); `tui.ts:5376` feeds `taskBarMeta()` into `userBlock`, which **ignores its `_meta`** (`turn.ts:409-411`)                   | `checkpoints` table (unreadable, see 1.6a)                                                                                                                                                                                      | named and ignored (`headless.ts:224`)                                                                                                                                               |
| evidence / check verdicts                  | `todo_updated`, `step_check`, `verification_completed` — but the command and verdict are recovered by **regex over prose** (`turn.ts:1976-1999`, `:2024-2062`) although `CheckRecord` already models them (`task.ts:212-221`) | `task_state.todos[].evidence`, `state.checks[]`, `audit_log`                                                                                                                                                                    | named and ignored (`headless.ts:218-221`)                                                                                                                                           |
| compaction                                 | `compaction` event; `tier` and `trigger` **rendered by nobody** (`events.ts:107-129`)                                                                                                                                         | `auto_compaction` rows; `/compact` writes `trigger:"manual"` (`engine.ts:3763`), a value **outside the union** (`events.ts:132`), normalised to `undefined` on replay (`engine.ts:449-452`), and emits **no live event at all** | named and ignored (`headless.ts:223`)                                                                                                                                               |
| compaction, on reconnect                   | delivered **twice** — live, then again from the `auto_compaction` row (`engine.ts:433-455`), with no id to dedupe on                                                                                                          | —                                                                                                                                                                                                                               | —                                                                                                                                                                                   |
| `error.recoverable`                        | **ignored** — every error sets `hardError` (`turn.ts:2162-2177`)                                                                                                                                                              | on the `run_trace` row                                                                                                                                                                                                          | honoured; only `recoverable === false` is fatal (`headless.ts:199-204`)                                                                                                             |
| files changed                              | `editedFiles`: write/edit/multi_edit **+ `apply_patch`** (`turn.ts:1419-1456`); footer `filesEdited`: **only** write/edit (`tui.ts:5390-5395`)                                                                                | `writtenPaths` (auto-commit scope): write/edit/multi_edit **+ `worker.args.files[]`** (`engine.ts:5150-5168`)                                                                                                                   | write/edit/multi_edit **only** (`headless.ts:166-173`) — a run whose writes came from a worker or `apply_patch` reports `filesChanged: []`                                          |
| worker / subagent lifecycle                | `tool_progress.child` (`events.ts:159-167`)                                                                                                                                                                                   | not persisted — `tool_progress` is not in `RUN_TRACE_EVENTS`                                                                                                                                                                    | named and ignored (`headless.ts:227`)                                                                                                                                               |
| ownership conflict                         | prose inside `tool_call_end.output.result` (`subagent-result.ts:414-421`)                                                                                                                                                     | same prose in the `tool_result` payload                                                                                                                                                                                         | counted as a **success** — `output.success` is true, so `toolErrors` does not move                                                                                                  |
| narrative / `decision_record`              | explicit no-ops (`turn.ts:1943-1948`)                                                                                                                                                                                         | `decision_record` row (`engine.ts:5325-5329`)                                                                                                                                                                                   | named and ignored; and it is yielded from the `finally` **after** `turn_complete` (`engine.ts:5322-5333`), so a consumer that treats `turn_complete` as end-of-stream never sees it |
| session status                             | no event carries it; `SessionSummary` omits it (`commands.ts:52-60`)                                                                                                                                                          | `sessions.status` (`packages/shared/src/session.ts:65`)                                                                                                                                                                         | absent                                                                                                                                                                              |
| terminal result                            | three of seven reasons                                                                                                                                                                                                        | **absent**                                                                                                                                                                                                                      | `stopReason` verbatim, but four of seven are silently `ok:true`                                                                                                                     |

Read the table as one sentence: **headless is the only consumer that reads the terminal
verdict at all, the persisted session is the only consumer that keeps the objective, and the
TUI is the only consumer that ever sees the user's constraints.** The three do not agree on
any single lifecycle field — including which files the run changed.

---

## 2. What already tests durability

Complete enumeration. "In-process" means a fake provider and/or direct function calls inside
one Bun process; "process-level" means a real spawned child process or real git/sqlite on disk.

### 2.1 Restart and resume

| Test                                                                                                                                     | Kind                                                                                                             | Does not cover                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/engine-task-state.test.ts:82` "todos recorded in run 1 reach the model of run 2 across an engine restart"             | in-process; real sqlite file, real loopback SSE server, two `Engine` objects (`:114`, `:125`)                    | nothing is spawned or killed; `enableCheckpoints:false` (`:57`); asserts only that the `[Task state]` block reaches the model |
| `tests/unit/orchestrator/delegated-sessions.test.ts:32` "a child retains findings across follow-up, process restart, and parent scoping" | in-process; real sqlite; "restart" is `sessions.close()` + `new SessionManager(path)` (`:63-64`)                 | `DelegatedSessions` is rebuilt in memory each time, so cross-process lease state is untested                                  |
| `tests/integration/engine-runtime-reliability.test.ts:110` (inside the test at `:80`)                                                    | in-process; second `Engine` on the same db via the file-local `setup()` at `:35`, then `resumeSession` at `:111` | same process; `resumeSession` is the only resume API exercised anywhere                                                       |
| `tests/unit/orchestrator/workflow.test.ts:220` "a kill at node 3 resumes without re-running the first two"                               | in-process; real JSON state file; the "kill" is `controller.abort()` (`:244`)                                    | kills nothing; a torn state write is only simulated by the corrupt-file case at `:309`                                        |
| `tests/integration/workflow-examples.test.ts:122` "a kill at a middle node resumes without paying for the prefix twice"                  | **process-level** — `Bun.spawn(["bun", CLI, "workflow", …])` at `:44`                                            | the "kill" is a cooperative `--stop-after` flag (`:130`); the child exits 0                                                   |
| `tests/unit/orchestrator/task-state.test.ts:528-578` snapshot/restore/`fromEvents`                                                       | in-process, pure                                                                                                 | no db, no engine                                                                                                              |
| `tests/integration/engine-host-socket.test.ts:63` "host survives a dead client"                                                          | **process-level**                                                                                                | the host is never killed mid-turn; only the client disconnects                                                                |
| `tests/integration/engine-host-tcp.test.ts:202` stale-rendezvous takeover                                                                | **process-level, `host.kill("SIGKILL")` at `:223`**                                                              | the host is idle; asserts only rendezvous-file takeover, nothing about session state                                          |

### 2.2 Compaction persistence

- `tests/integration/engine-runtime-reliability.test.ts:140` "automatic compaction persists
  its actual working set into the next engine's first request" — **the strongest test in the
  repo for this**, in-process: seeds 16 turns, drives a real `compact_context`, asserts the
  `auto_compaction` event landed with `version:1` (`:166-168`), then builds a second Engine
  (`:172`) and asserts the new engine's first request carries the summary and not `ARCHIVE_0:`
  (`:174-177`). Does not cover: no process restart, `enableCheckpoints:false`, no
  mid-compaction crash.
- `tests/unit/orchestrator/session-replay-compaction.test.ts` — `:38`, `:87`, `:106`, `:131`,
  `:151`, `:160`, `:206`, `:223`, `:242`, `:260`, `:283`, and `:301` (the one case with a real
  `SessionManager`). In-process; "restart" means re-running the reducer.
- `tests/unit/orchestrator/compaction-degradation.test.ts:60` three successive compactions;
  `agent-loop-endurance.test.ts:30` 105 tool turns; the `context-*compaction*.test.ts` family
  (14 tests in `context-tiered-compaction.test.ts:136-371` alone). All in-process, pure.
- Eval tasks `tests/eval/tasks-compaction.ts:472,504,570,619,656,752,848` and
  `tests/eval/tasks-task-spine.ts:209`. **The eval harness never restarts an Engine** — one
  `new Engine` per task at `tests/eval/harness.ts:383`, `close()` at the end.

### 2.3 Worker snapshot, integration, conflict

`tests/unit/orchestrator/worker-worktree.test.ts` is process-level _for git_ (real
`spawnSync("git", …)` repos, helper at `:37`, `makeRepo()` at `:42`) and has no model:
seeding from the working tree `:61`, clean tree `:76`, two disjoint filesystems `:92`,
untracked source plus `node_modules` `:243`, dirty dispatch preserving the lead's index
`:263`, provisioning cost `:354`, isolation-vs-snapshot error split with no debris `:342`,
owned files land `:106`, unowned withheld `:120`, nothing left staged `:143`, delete an owned
file `:290`, **concurrent-lead-edit refuses the whole integration `:276`**, branch retained
`:156`, branch removed on success `:168`, empty-branch discard refused `:299`, follow-up
restore `:320`.

`tests/unit/orchestrator/worker.test.ts` covers ownership (`:46`, `:62`), the
**concurrent-overlap refusal `:332`**, the guarded registry (`:83`, `:106`, `:132`) and the
disk-measured manifest (`:169`, `:233`, `:285`). The three isolation tests — shared-tree
fallback `:429`, partial-snapshot refusal `:457`, provisioning receipt `:483` — are all
`skipIf(!HAS_RUST_BIN)` and vanish on a checkout without `cargo build -p rune-tools`.

**No worker is ever a real process.** `subagent.ts`, `worker.ts`, `delegated-sessions.ts` and
`delegation-pool.ts` contain no `Bun.spawn` and no `child_process` import; a child is a
nested `AgentLoop` in the parent process (`packages/orchestrator/src/subagent.ts:313`).

### 2.4 Leases

- `tests/unit/orchestrator/delegated-sessions.test.ts:95` — the resume lease. In-process, and
  the `DelegatedSessions` is constructed **with no store**, so the lease under test is a pure
  in-memory `Set` (`packages/orchestrator/src/delegated-sessions.ts:25`). Two processes
  resuming one `task_id` is untested, as is a lease held by a crashed holder.
- `tests/integration/team-multi-instance.test.ts:235` — cross-instance worker leases, real
  shared `team.db`, two `Engine` objects **in one process**; `:253` covers `warn` enforcement.
  Neither instance is killed.
- `tests/unit/orchestrator/task-ledger.test.ts:74` "a step whose owner went quiet is
  reclaimable" and `:172` "an expired claim releases the task rather than deleting it" —
  "went quiet" is a timestamp, never a dead process.
- `tests/unit/orchestrator/host-reaper.test.ts` — 13 tests, but `process.kill` is
  monkey-patched for the whole file (`:44-53`), so no real signal is ever delivered.
- `tests/integration/zz-no-leaked-hosts.test.ts:68` — a `ps`-based assertion, not a cleanup;
  returns early and asserts nothing on a machine without `ps` (`:74`).

### 2.5 Budget

- `tests/unit/gateway/budget-reservations.test.ts` — `:6` concurrent admission, `:30`
  **cancellation and provider failure release reservations**, `:48` unpriced refusal, `:58`
  the shared ceiling admitting exactly three concurrent children. All in-process.
- `tests/unit/gateway/cost-budget.test.ts:18-76`; `subagent-budget.test.ts:22-97`;
  `turn-budget.test.ts:35-74`; `turn-refunds.test.ts:16-66`;
  `agent-loop-turn-refund.test.ts:98`, `:113`, `:134`; `delegation-pool.test.ts:14`;
  `supervisor-queue.test.ts:86`.
- `tests/integration/engine-runtime-reliability.test.ts:80`, `:125`, `:183`, `:252` — real
  Engine and real sqlite, fake provider.

**Not covered:** no test holds a reservation while a process dies; no end-to-end sub-agent
budget breach.

### 2.6 Child results

`tests/unit/orchestrator/subagent-no-summary.test.ts` is the max_turns/empty-final file:
partial report instead of nothing `:141`, the cause named as out-of-turns `:153`, the ground
covered `:163`, the INCOMPLETE label `:175`, recovery advice `:185`, NARROWER at the top
budget `:193`, **no text and no tools is the one genuine failure `:203`**, and the real cause
carried even then `:212`. All in-process with a custom `ToolOnlyProvider`.

`subagent-result.test.ts:96`, `:107`, `:118` prove the harness's facts beat the model's
claims; `:131`, `:153`, `:168`, `:183` cover the empty report, the INCOMPLETE render, a
claimed-but-missing file, and the conflict block. `subagent-summary-provenance.test.ts:147-264`
covers report boundaries and mid-run model swaps. `agent-loop-empty-completion.test.ts` has 17
tests including `:201`, `:348`, `:400`, `:415`, `:572`.
`tests/integration/engine-runtime-reliability.test.ts:193` is the one real-Engine case.

### 2.7 Cancellation

`agent-loop-empty-completion.test.ts:688` "cancellation mid-loop ends as aborted and keeps
what was said" — in-process; asserts exactly one model call, `stopReason:"aborted"`, no error
event, text retained, `handoff.reason:"aborted"`. It cleans up no process.
`tests/integration/acp-conformance.test.ts:296` is process-level: a real ACP client cancels a
turn blocked on a permission request and the prompt answers `cancelled` — but nothing asserts
that the `sleep 600` subprocess actually died.

### 2.8 The one-sentence summary

**No test in the repository SIGKILLs a Rune engine mid-turn and then re-reads the database.**
The only SIGKILL (`engine-host-tcp.test.ts:223`) targets an idle host, and the only
process-level "kill and resume" (`workflow-examples.test.ts:122`) is a cooperative flag.

---

## 3. Existing fault-injection and mock facilities

### 3.1 The in-process fake provider (`bun run eval`)

`package.json:15` runs `tests/eval/runner.ts`, which calls `runSuite`
(`tests/eval/harness.ts:571`) → `runTask` (`:307`). The Engine is built normally — real
registry, real native binary (`:272-275`), real permissions (`:383-392`) — and the fake is
then injected by reaching into the private gateway:

```ts
// tests/eval/harness.ts:399-409
const gw: any = (engine as any).gateway;
gw.providers.clear();
gw.registerProvider(mock);
```

`MockProvider implements LlmProvider` (`tests/eval/mock-provider.ts:93`) with
`name = "anthropic"` (`:94`). It scripts by index (`ScriptedResponse` at `:16`, `Script` at
`:43`, consumed at `:160`) or content-addressed (`Responder` at `:59`), drives the
**non-streaming** summarizer path separately (`Summarizer` at `:80`, `infer` at `:134`), and
already carries three fault levers: `streamError` mid-stream (`:30`, emitted at `:222-224`),
`rawToolArgs` malformed tool JSON (`:40`, `:203-210`), and script exhaustion (`:166-169`).

### 3.2 A fake provider CAN drive a real child process — and six tests already do it

The seam is the `custom` OpenAI-compatible provider, configured entirely from disk:

```ts
// tests/integration/acp-conformance.test.ts:128-141 (identical at engine-serve.test.ts:261,
// rune-action.test.ts:212)
writeFileSync(
  join(runeHome, "model.json"),
  JSON.stringify({ provider: "custom", model: "fake-model" }),
);
writeFileSync(
  join(runeHome, "secrets.json"),
  JSON.stringify({
    custom: { baseUrl: `http://127.0.0.1:${model.port}/v1`, model: "fake-model", key: "fake-key" },
  }),
  { mode: 0o600 },
);
```

`CUSTOM_PROVIDER_ID = "custom"` (`packages/shared/src/providers.ts:323`);
`buildGateway` registers it at `packages/orchestrator/src/provider-registry.ts:257-265`;
`rune-cli.ts` supplies it from `secrets.custom` at
`packages/orchestrator/src/bin/rune-cli.ts:1084`, and `engine-host.ts` at `:423`.
`OpenAIProvider` accepts any key and any base URL with `maxRetries: 0`
(`packages/llm-gateway/src/providers/openai.ts:94-117`), and its non-streaming `infer()` hits
the _same_ `/chat/completions` endpoint (`:169-185`) — so one fake server sees both the loop's
stream calls and the summarizer's `stream:false`, `role:"summarizer"` call
(`packages/llm-gateway/src/types.ts:360`).

Existing process-level rigs to copy: `acp-conformance.test.ts` (server `:112-126`, spawn
`:139-152`, SSE helpers `chunk`/`sseText`/`sseToolCall` at `:49-69`, request-indexed script
with a clamp at `:120`); `fresh-home-onboarding.test.ts` (spawn `:109-121`, including a real
`rune -P` headless turn); `engine-serve.test.ts:251-291`; `rune-action.test.ts:194-252`.

Relevant env seams: `RUNE_HOME` (`packages/shared/src/paths.ts:190`), `RUNE_SECRETS_PATH`
(`packages/shared/src/secrets.ts:82-89`), `RUNE_CONFIG_PATH`
(`packages/shared/src/config.ts:1059-1061`), `RUNE_MODEL_PATH`
(`packages/shared/src/model-store.ts:22-28`), `RUNE_DB_PATH`, `RUNE_WORKSPACE`,
`RUNE_TOOLS_BIN`/`RUNE_TOOLS_BINARY`, `RUNE_ROUNDTRIP_TIMEOUT_MS`
(`tests/integration/engine-serve.test.ts:287`).

### 3.3 The in-process scripted provider (`UsageProvider`)

`tests/helpers/usage-provider.ts:13` — `name = "anthropic"`, records `requests` (`:15`),
scripts by 1-based call index through `onRequest` (`:16`), carries a fixed `usage` (`:17`) so
a test can drive token accounting, and exposes `pending?: Promise<void>` awaited inside
`infer` (`:32`) — an existing latency/stall injection seam.
`tests/integration/engine-command-evidence.test.ts` is the canonical wiring: redirect
`RUNE_HOME` (`:45-46`), build a lean real Engine (`:76-95`), `registerProvider` over the
matching slot (`:97-100`), script as `ContentBlock[][]` (`:101-153`), dispatch by index with a
safe tail (`:154-155`), then assert on events, persisted `task_state`/`retro` and
`provider.requests.length`.

### 3.4 Making the summarizer fail deterministically

The one model round trip is `ContextEngine.generateSummary` →
`this.gateway.infer({… stream:false, role:"summarizer" …})`
(`packages/orchestrator/src/context-engine.ts:958-967`). Five levers, in increasing
intrusiveness:

1. **Fake server 500s the `stream:false` request** — works across a process boundary; this is
   the lever the scenario should use.
2. `MockProvider.setSummarizer` returning `""` → the empty-summary branch at
   `context-engine.ts:971`.
3. `opts.budgetMs` (`:857`, clamped at `:863`; default `DEFAULT_SUMMARY_BUDGET_MS = 120_000`
   at `:42`) → `"summarizer budget of Ns exhausted"` (`:867-870`).
4. `opts.signal` (`:856`) → `"compaction aborted with the turn"` (`:869`).
5. Collapse the candidate list — `summarizerCandidates()` at `:1093-1123`.

Failure handling: all candidates exhausted → `recoverWithLiveModels` (`:1023`, capped at
`MAX_LIVE_ATTEMPTS = 12`, `:1026`) → `lastSummaryFailure` set and `null` returned (`:1009-1010`)
→ `compactWorkingSet` falls back to `evictInstead("summarizer failed")` and otherwise returns
`{compacted:false, failed:true, failureReason}` (`:749-762`). The loop surfaces it three
times: the run-killing overflow path at `packages/orchestrator/src/agent-loop.ts:1771-1784`,
turn-end auto compaction at `:2542-2552`, and `:4108-4118`.

### 3.5 Simulating an overlarge fixed prompt

`this.lastFixedPromptTokens = systemTokens + toolTokens + auxUsed`
(`packages/orchestrator/src/context-engine.ts:388`), recalibrated against provider-authoritative
counts at `:416`, and subtracted from the compaction target at `:619-627`.

In-process, the window is settable to any positive value:
`TokenCounter.registerContextLimit(model, limit)`
(`packages/orchestrator/src/tokenizer.ts:104-107`), which outranks the static family table
(`:122-123`); `clearContextLimits` at `:110` is documented test-only. The existing rig is
`tests/eval/tasks-compaction.ts:56-60` with `EvalTask.teardown`
(`tests/eval/harness.ts:52-57`). The header note at `tasks-compaction.ts:28-33` records the
practical floor — system prompt plus 29 tool schemas is ~19.5k tokens, so any window below
that _is_ the overlarge-fixed-prompt case.

**Across a process boundary** the static map is not inherited. Use the live-catalog path
instead: `Engine` registers a model's window from the provider's `listModels()`
(`packages/orchestrator/src/engine.ts:6002`, `:6014`, `:6021`), so a fake server that answers
`GET /v1/models` with a tiny `context_length` sets the child's window from outside.

### 3.6 Interrupting a tool or worker boundary

The native tool is a real child process per call: `Bun.spawn([binaryPath, ...args])`
(`packages/tool-registry/src/tools/rust-bridge.ts:137`), aborted as SIGTERM then SIGKILL after
1.5 s (`:148-162`). Its pid is proc-local and never recorded, so a scenario must enumerate it
with `ps`/`pgrep -P`. Background shells _do_ keep a pid and kill by process group
(`packages/tool-registry/src/tools/background.ts:151-154`), and `engine-host` pids are
persisted in `~/.rune/serve.json` (`packages/orchestrator/src/bin/serve-cli.ts:73`, `:881`).

Signal handlers: CLI `SIGINT` → `engine.abort()` without exiting when busy
(`packages/orchestrator/src/bin/rune-cli.ts:3667-3698`); `SIGHUP`/`SIGTERM` → discard-if-empty,
`engine.close()`, exit 129/143 (`:1405-1417`); the `exit` hook disarms the crash sentinel
(`:1383-1391`). `engine-host` has `SIGTERM`/`SIGINT` (`bin/engine-host.ts:1299-1300`) and a
15-second dead-man's poll of the supervisor pid (`:1302-1316`).

**The instrument the scenario should assert on already exists**: the pid-scoped crash
sentinel. Armed at `rune-cli.ts:1377-1383`, disarmed on clean exit, and swept at the _next_
startup into a `crash.dirty_exit` critical incident carrying the spooled flight trail
(`:1356-1373`; implementation `packages/telemetry/src/sentinel.ts:50`, `:55`, `:73`, `:92`).
Its comment states the contract: it survives only a SIGKILL/power-loss death.

The closest existing precedent for a scripted kill is
`tests/integration/engine-host-tcp.test.ts:216-241`.

---

## 4. The shared lifecycle contract

One type, built entirely from types that already exist. It is a **read model** — a projection
every consumer can produce and compare, not a new coordinator and not a new store. The Engine
derives it; the TUI renders it; `replayEvents` reconstructs it from the log; headless
serialises it.

```ts
/** What the TUI, the persisted session and a headless caller must agree on. */
export interface TaskLifecycle {
  /** `sessions.id` for lead work; `task_<uuid>` for a delegated child. */
  id: string;
  /** The parent's `id`; absent for lead work. */
  parentId?: string;
  /** "lead" | "task" | "worker" — the existing `Kind` widened by one member. */
  kind: "lead" | Kind;

  /** TaskState.goal, verbatim and uncapped-at-200. */
  objective: string;
  /** The read-back criteria and their rungs. Brief.criteria as they stand. */
  constraints: Criterion[];

  /** Where the work is, and what it was against. */
  workspace: { root: string; head: string | null; dirty: boolean };

  /**
   * How it ended; "running" until then. One vocabulary, replacing today's two:
   * `stopReason` (7 values) and `HandoffReason` (8, overlapping on 5).
   */
  status:
    | "running"
    | "end_turn"
    | "aborted"
    | "halted"
    | "max_turns"
    | "max_tokens"
    | "provider_lost"
    | "open_steps"
    | "stalled";

  budget: {
    turnsUsed: number;
    turnsMax: number;
    secondWindsUsed: number;
    tokensIn: number;
    tokensOut: number;
    spentUsd: number;
    capUsd: number | null;
    reservedUsd: number;
  };

  /** Where a restart would pick up. */
  checkpoint: { seq: number; at: string; compactions: number } | null;

  /** The plan and what moved it. */
  evidence: { todos: TodoItem[]; checks: CheckRecord[]; verifiedCriteria: number };

  /** Children this task dispatched, by id, with their own terminal status. */
  children: Array<{
    id: string;
    kind: Kind;
    status: TaskLifecycle["status"];
    integration?: "merged" | "retained" | "shared";
    conflicts?: string[];
  }>;
}
```

Provenance of every field, and what must change:

| Field                        | Comes from                                                                                                                                             | Change required                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `sessions.id` (`packages/shared/src/session.ts:58`) / `Checkpoint.id` (`delegated-sessions.ts:11`)                                                     | none                                                                                                                          |
| `parentId`                   | `events.session_id` on the child's checkpoint row                                                                                                      | add it to `Checkpoint` so it is explicit rather than inferred                                                                 |
| `kind`                       | `Kind` (`delegated-sessions.ts:8`)                                                                                                                     | widen with `"lead"`                                                                                                           |
| `objective`                  | `TaskState.goal` (`task-state.ts:97`)                                                                                                                  | none                                                                                                                          |
| `constraints`                | `Criterion` (`packages/protocol/src/roundtrips.ts:105`), held by `BriefLedger` (`brief.ts:87`)                                                         | **persist it** — a `brief` session event, restored beside `task_state`                                                        |
| `workspace.root`             | `sessions.workspace_root`                                                                                                                              | none                                                                                                                          |
| `workspace.head` / `.dirty`  | `isGitRepo`/`workspaceDiff` (`git-undo.ts:44`, `:203`)                                                                                                 | **record it once per run** on the existing `checkpoint:"session_started"` row                                                 |
| `status`                     | `turn_complete.stopReason` (`packages/protocol/src/events.ts:38`) unioned with `HandoffReason` (`task.ts:258-270`)                                     | **persist it** (add `turn_complete` to `RUN_TRACE_EVENTS`, `engine.ts:329`) **and reconcile the two vocabularies** — G21, G22 |
| `budget.turns*`              | `TurnBudget` (`turn-budget.ts:21`), `ReliabilityPolicy.maxTurns/secondWinds` (`reliability-policy.ts:48`, `:50`), `TurnRefunds` (`turn-refunds.ts:48`) | **persist the used counts** on the same row                                                                                   |
| `budget.tokens*`             | the `usage` event (`events.ts:87-109`)                                                                                                                 | none — already in `cost` rows                                                                                                 |
| `budget.spentUsd` / `capUsd` | `CostTracker` (`cost-tracker.ts:107`), rebuilt by `activateCostSession` (`engine.ts:5709`)                                                             | none                                                                                                                          |
| `budget.reservedUsd`         | `CostTracker.getReservedUsd()` (`cost-tracker.ts:190`)                                                                                                 | none durable; report live only                                                                                                |
| `checkpoint.seq`             | `events.seq` of the latest `task_state` row                                                                                                            | none — already `lastSeq` from `replayEvents` (`engine.ts:364`)                                                                |
| `checkpoint.compactions`     | count of `auto_compaction` rows                                                                                                                        | none                                                                                                                          |
| `evidence.todos` / `.checks` | `TodoItem` / `CheckRecord` (`packages/protocol/src/task.ts:55`, `:95`)                                                                                 | none                                                                                                                          |
| `evidence.verifiedCriteria`  | `BriefLedger.met` (`brief.ts:94-96`)                                                                                                                   | follows `constraints`                                                                                                         |
| `children[]`                 | `SubagentResult` (`subagent-result.ts:23`) + `structured.integration`/`branch` (`worker.ts:892-900`)                                                   | **emit it as an event** so the TUI and headless see it without parsing prose                                                  |

Deliberately **not** in the type: the transcript (it is already `eventsToMessages`), the
narrative (already `decision_record`), and anything a consumer can derive. The type is small
on purpose — it is the contract, not the state.

The delivery mechanism is equally minimal: **one new event, `lifecycle`, carrying
`TaskLifecycle`**, emitted at run start, at every checkpoint boundary and at run end. It
enters `AGENT_TURN_EVENT_TYPES` (`packages/protocol/src/events.ts:255`), which forces all
three guarded reducers to name it (`tests/unit/protocol/exhaustiveness.test.ts:84-90`), and it
joins `RUN_TRACE_EVENTS` so `replayEvents` reconstructs it. No new table; no coordinator.

---

## 5. The process-level scenario spec

One scenario file plus one mock-model server, both under `tests/`. It spawns a **real** `rune`
process against a **real** git repo, a **real** `rune.db`, and a scripted loopback model
server. Everything is deterministic: the server decides what the model says and when the child
dies.

### 5.1 Fixture

1. `mkdtempSync` a workspace; `git init`; commit `src/api.ts`, `src/client.ts`, `check.mjs`
   (an exit-code-bearing acceptance script). Record `HEAD`.
2. Leave the tree **dirty**: edit `src/api.ts` without committing, and create an **untracked**
   `src/notes.md`. Both must reach the worker's snapshot
   (`packages/orchestrator/src/worker-worktree.ts:172-186`, `worker-snapshot.ts:33`).
3. `mkdtempSync` a `RUNE_HOME`; write `model.json` (`provider:"custom"`) and `secrets.json`
   (`custom.baseUrl = http://127.0.0.1:<port>/v1`) exactly as
   `tests/integration/acp-conformance.test.ts:128-141`.
4. `config.toml`: `[reliability] maxTurns = 12`, `[git] autoCommit = false`,
   `[team] enabled = true` (so the lease path is exercised), `[subagents] maxParallel = 1`.
5. Start the mock server (`Bun.serve({port: 0})`), which implements `POST /v1/chat/completions`
   (SSE for `stream:true`, JSON for `stream:false`) and `GET /v1/models`.

### 5.2 The script (request index → response)

| #     | Server responds                                                                                           | Purpose                                   |
| ----- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1     | `read_back` tool call with three `done_when` criteria                                                     | records constraints                       |
| 2     | `todo_write` with four steps, step 2 depending on step 1                                                  | the dependent plan                        |
| 3     | `edit_file src/api.ts`                                                                                    | lead edit on top of the user's dirty edit |
| 4     | `worker { files: ["src/client.ts"], prompt: … }`                                                          | dispatches the worker                     |
| 4′    | (worker's own requests) `edit_file src/client.ts`, then a final report                                    | the child                                 |
| 5     | text only — **the harness injects a steering message before this request**                                | steering mid-task                         |
| 6–9   | four large `read_file` calls returning ~40 KB each                                                        | forces compaction #1                      |
| 10–13 | four more                                                                                                 | forces compaction #2                      |
| 14    | `bash node check.mjs` — **the server SIGKILLs the child after the request arrives and before responding** | kill at a tool boundary                   |
| 15+   | (second process) `todo_write` closing step 3, `record_evidence`, final text                               | recovery                                  |

Determinism: the server holds each request and responds only when the harness's `await`
resolves, so "before responding" is a hard ordering guarantee, not a sleep. The child's own
requests are distinguished by `role: "subagent"` on the `InferenceRequest`
(`packages/llm-gateway/src/types.ts:254`).

### 5.3 The two kill points

- **Tool boundary (run A).** On request 14 the server records `child.pid`'s tool children via
  `ps -eo pid,ppid,command`, then `child.kill("SIGKILL")` and never responds. The native
  `rune-tools` process for the in-flight `bash` is the orphan candidate
  (`packages/tool-registry/src/tools/rust-bridge.ts:137`).
- **Worker boundary (run B, a separate fixture from the same seed).** The kill lands on the
  _worker's_ request 4′-2, i.e. after the worker wrote `src/client.ts` inside
  `.rune/worktrees/w1` and before `saveWorkerChanges`/`mergeWorkerWorktree` run in the
  `finally` (`packages/orchestrator/src/worker.ts:908-946`).

### 5.4 Recovery run

Relaunch `rune` with the same `RUNE_HOME`, `RUNE_DB_PATH` and workspace, resuming the same
session id, and drive it with script entries 15+.

### 5.5 The two child-result cases

Run as separate, cheap process-level cases against the same rig:

- **Tool-heavy `max_turns` child.** Script the `task` child to call `read_file` on a different
  path every turn until its ceiling. Assert the parent's `tool_call_end.output.result`
  contains the INCOMPLETE label and names out-of-turns, matching
  `tests/unit/orchestrator/subagent-no-summary.test.ts:153`, `:175`, and that
  `structured.stopReason === "max_turns"` with a non-empty `filesExamined`.
- **Tools-then-empty-final child.** Script two `edit_file` calls then an empty `end_turn`.
  Assert `structured.filesChanged` is the two paths (harness-measured, not model-claimed —
  `subagent-result.test.ts:96`), `confidence === "low"`, and `unresolved[0]` names the missing
  summary (`packages/orchestrator/src/subagent-result.ts:250`).

### 5.6 Acceptance criteria → concrete assertions

| Handoff criterion                                | Assertion                                                                                                                                                                                                                                                                                                                                         | Artifact read                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| user constraints survive                         | after recovery, the lifecycle projection lists all three `done_when` criteria with their pre-kill rungs                                                                                                                                                                                                                                           | a `brief` event in `events` (new); today: nothing exists to read                       |
| unfinished dependencies survive                  | `TaskStateStore.fromEvents(getEvents(sid,1))` returns four todos, steps 3–4 not `completed`, and step 2's `evidence.writes >= 1`                                                                                                                                                                                                                  | `events` rows `type='task_state'`                                                      |
| steering survives                                | the recovered spine's `directive` equals the full steering text (not the first 200 chars)                                                                                                                                                                                                                                                         | `task_state.state.directive`                                                           |
| no duplicated side effects on replay             | `check.mjs` writes one line per invocation to `runs.log`; after recovery the file has exactly the number of lines the successful `bash` calls justify                                                                                                                                                                                             | file on disk                                                                           |
| no duplicated spend on replay                    | `SUM(json_extract(payload_json,'$.costUsd'))` over `cost` rows equals the sum of the mock server's per-request accounting; no `cost` row is written twice for one request id                                                                                                                                                                      | `events` rows `type='cost'`                                                            |
| no lost edits                                    | `src/api.ts` contains both the user's uncommitted edit and the lead's edit; `src/notes.md` is unchanged and still untracked; `src/client.ts` contains the worker's edit (run B: after recovery, via the retained branch)                                                                                                                          | working tree + `git status --porcelain`                                                |
| the run _reports_ the edits it made              | the headless envelope's `filesChanged` includes the worker-authored `src/client.ts`. **This fails today** — `headless.ts:166-173` counts only `write_file\|edit_file\|multi_edit`, while the engine's own auto-commit scope also counts `worker.args.files[]` (`engine.ts:5160-5168`) and the TUI also counts `apply_patch` (`turn.ts:1419-1456`) | headless envelope `filesChanged`                                                       |
| a conflicted merge is not a success              | after run B's recovery, the worker's ownership conflict is visible as a typed field, not only as `[MERGE CONFLICTS — …]` prose; `toolErrors` or an equivalent counter moves. **Fails today** — `output.success` is `true` for a conflicted merge (`worker.ts:892-900`)                                                                            | headless envelope + `tool_result` payload                                              |
| a run with open steps is not reported as done    | after the recovery run closes only steps 1–3, `rune -P --json` reports a `stopReason` that is not `end_turn` and a non-zero exit. **Fails today** (Gap 1.8c)                                                                                                                                                                                      | headless envelope `stopReason` + exit code                                             |
| no orphan processes                              | after the kill and a 5-second settle, `ps -eo pid,ppid,command` shows no `rune-tools` and no `engine-host` whose command names this workspace                                                                                                                                                                                                     | process table (`tests/integration/zz-no-leaked-hosts.test.ts:49` has the exact filter) |
| no orphan leases                                 | `SELECT * FROM claims` in `team.db` is empty after the recovery process starts (pid-reaped by `TeamBus.sweep`, `packages/orchestrator/src/team/bus.ts:793-810`); and a second `worker` dispatch after recovery is **not** refused                                                                                                                 | `team.db` `claims` table                                                               |
| no orphan worktrees                              | `git worktree list` names no `.rune/worktrees/*` after recovery; the retained branch `rune/worker-w1` still exists and holds the worker's committed work                                                                                                                                                                                          | git                                                                                    |
| no verified status for stale evidence            | the criterion that was `verified` before the kill is reported `verified` **only if** `workspace.head` and the file digest are unchanged; after a post-recovery edit to the cited file it drops to `reproduced`                                                                                                                                    | lifecycle projection + `task_state.checks[]`                                           |
| usable partial result                            | the recovery process's first response includes the pre-kill work; and in the abandon case `rune -P --json` exits with `stopReason` set and non-empty `text`                                                                                                                                                                                       | headless envelope `stopReason`, `text`, `filesChanged`                                 |
| summarization failure is bounded                 | with the server 500-ing every `stream:false` request, the run emits at most `maxOverflowCompactions` (2) forced compactions and ends with a terminal event; `provider.requests` shows no unbounded retry loop                                                                                                                                     | `run_trace` rows + the mock server's request log                                       |
| overlarge fixed prompt is bounded and observable | with `GET /v1/models` reporting `context_length: 8000`, the run ends with a named reason rather than three generic stream errors; assert the envelope's `error` mentions the window, not "Too many consecutive errors"                                                                                                                            | headless envelope `error` + `stopReason`                                               |
| terminal result is durable                       | after the kill, the recovery process can report how run A ended without re-running it                                                                                                                                                                                                                                                             | a `turn_complete` `run_trace` row (new); today: nothing exists to read                 |

**Seven of these eighteen fail or have nothing to read against today's code** — user
constraints, steering above 200 chars, reported edits, conflicted merges, open steps, stale
evidence, and the terminal result. That is the point of section 6. Lane S should write all
eighteen from day one and mark those seven `test.todo`, so the build lanes have an executable
definition of done rather than a prose one.

---

## 6. Gap list and build plan

Ordered by dependency. Every item names the smallest change.

| #   | Gap                                                                  | Where                                                                                        | Smallest change                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `turn_complete` is not persisted                                     | `packages/orchestrator/src/engine.ts:329-341`                                                | add `"turn_complete"` to `RUN_TRACE_EVENTS`; `replayEvents` already unpacks `run_trace` verbatim (`:495-503`)                                                                                                                         |
| G2  | `replayEvents` is outside the drift law                              | `tests/unit/protocol/exhaustiveness.test.ts:47-63`                                           | add a fourth `REDUCERS` entry for `replayEvents` and assert `RUN_TRACE_EVENTS ∪ dedicated rows` covers the manifest                                                                                                                   |
| G3  | the brief/ledger is never persisted                                  | `packages/orchestrator/src/engine.ts:1447-1448`                                              | append a `brief` event when the ledger is created and after every rung change; restore it beside `TaskStateStore.fromEvents` at `:4530-4534`                                                                                          |
| G4  | no workspace revision is recorded                                    | `packages/orchestrator/src/engine.ts:4616-4619`                                              | put `{head, dirty}` on the existing `checkpoint:"session_started"` payload                                                                                                                                                            |
| G5  | evidence has no revision to be stale against                         | `packages/orchestrator/src/brief.ts:87`, `task-state.ts:691-705`                             | store the `head` (G4) on each `CheckRecord` and each criterion rung; demote a rung whose cited file changed after it                                                                                                                  |
| G6  | turn budget resets on restart                                        | `packages/orchestrator/src/engine.ts:4627-4629`                                              | persist `{turnsUsed, secondWindsUsed}` with G1's row; seed the next run from it while the plan has open steps                                                                                                                         |
| G7  | the `checkpoints` table is write-only and is 184 MiB of a 250 MiB db | `packages/orchestrator/src/engine.ts:4513`, `:5004`, `:5171`; `packages/shared/src/state.ts` | **decide** (director): either make `runId` session-stable and call `resumeFromCheckpoint`, or delete the writes and the table. Do not leave it as it is                                                                               |
| G8  | the interval checkpoint is dead code                                 | `packages/orchestrator/src/engine.ts:5004`                                                   | falls out of G7                                                                                                                                                                                                                       |
| G9  | steering truncated to 200 chars on the spine                         | `packages/orchestrator/src/task-state.ts:598`                                                | raise the `directive` cap to `GOAL_CAP` or store the full text in `log`                                                                                                                                                               |
| G10 | the child checkpoint is written only after the child returns         | `packages/orchestrator/src/delegated-sessions.ts:255-266`                                    | save at each child tool boundary, not only on resolve — the `bindDelegatedLoop` accessor (`:150-153`) already exposes the live messages                                                                                               |
| G11 | a child's budget resets on resume                                    | `packages/orchestrator/src/delegated-sessions.ts:9-19`                                       | add `{spentUsd, elapsedMs}` to `Checkpoint`; seed `budgetState` from it in `worker.ts:664` / `subagent.ts:379`                                                                                                                        |
| G12 | the resume lease is memory-only                                      | `packages/orchestrator/src/delegated-sessions.ts:25`, `:43-53`                               | persist the claim with an owner pid and a TTL, and reap it on pid death — reuse `TeamBus.sweep`'s pattern (`team/bus.ts:793-810`)                                                                                                     |
| G13 | worker ids are not durable; a crash degrades every later worker      | `packages/orchestrator/src/worker.ts:447`, `:492`; `worker-worktree.ts:157-164`              | derive the id from the session id plus a persisted counter, and add a startup reaper that prunes `.rune/worktrees/*` whose owning pid is dead, keeping the branch                                                                     |
| G14 | no event carries a task id                                           | `packages/protocol/src/events.ts:27-201`                                                     | the `lifecycle` event of §4                                                                                                                                                                                                           |
| G15 | overlarge fixed prompt reports as `provider_lost`                    | `packages/orchestrator/src/agent-loop.ts:1745-1793`                                          | preflight `lastFixedPromptTokens >= usage.limit` before the retry loop and end with a named, non-recoverable reason                                                                                                                   |
| G16 | summarizer failure surfaces only as a `notice`                       | `packages/orchestrator/src/agent-loop.ts:1771-1784`                                          | carry `failureReason` on the `compaction` event (add `failed?: boolean; failureReason?: string`) so all three consumers see it                                                                                                        |
| G17 | headless drops turns, spend, evidence and children                   | `packages/orchestrator/src/headless.ts:44-71`, `:319-348`                                    | add `lifecycle` to `HeadlessResult`/`headlessEnvelope` from the G14 event                                                                                                                                                             |
| G18 | `provider_lost` is in neither early-stop set                         | `packages/orchestrator/src/bin/ui/turn.ts:2186-2191`; `headless.ts:289-294`                  | add it to both, with the wording each surface already uses                                                                                                                                                                            |
| G19 | dead schema                                                          | `packages/shared/src/session.ts:82-101` (`files`, `permissions`)                             | drop the `CREATE TABLE`s or wire them; they mislead every reader of the schema                                                                                                                                                        |
| G20 | `appendEvent` computes `MAX(seq)+1` outside a transaction            | `packages/shared/src/session.ts:279-289`                                                     | wrap in `db.transaction`; concurrent hosts on one file currently race into a swallowed `UNIQUE` throw                                                                                                                                 |
| G21 | a run with open steps exits 0 as `end_turn`                          | `packages/orchestrator/src/agent-loop.ts:2529`, `:2567`; `headless.ts:289-294`               | carry the handoff reason on `turn_complete` (`stopReason:"open_steps"`, or a `handoffReason?` field) and add it to `UNFINISHED_STOP`                                                                                                  |
| G22 | two terminal paths emit no `turn_complete`                           | `packages/orchestrator/src/agent-loop.ts:3820-3829`, `:4048`                                 | emit `turn_complete { stopReason: "stalled" }` before the non-recoverable error, so every path has exactly one terminal event                                                                                                         |
| G23 | `filesChanged` has four incompatible definitions                     | `headless.ts:166-173`; `engine.ts:5150-5168`; `turn.ts:1419-1456`; `tui.ts:5390-5395`        | one exported predicate in the orchestrator, used by all four; it must include `apply_patch` and `worker.args.files[]`                                                                                                                 |
| G24 | a conflicted worker merge counts as a successful tool call           | `packages/orchestrator/src/worker.ts:892-900`                                                | keep `success:true` (the work is retained, not lost) but put `integration` and `conflicts[]` on the `lifecycle` event's `children[]`, and count them in the envelope                                                                  |
| G25 | `error.recoverable` honoured in one consumer, ignored in the other   | `turn.ts:2162-2177` vs `headless.ts:199-204`                                                 | make the TUI branch on `recoverable` as headless already does                                                                                                                                                                         |
| G26 | `checkpoint_saved` is rendered nowhere                               | `turn.ts:634-635`, `:2086-2095`, `:409-411`; `events.ts:282`                                 | falls out of G7 — if the table goes, so does the event; if it stays, `userBlock` must stop discarding `_meta`                                                                                                                         |
| G27 | `/compact` emits no event and persists an out-of-union `trigger`     | `packages/orchestrator/src/engine.ts:3725-3775`, `:3763`                                     | add `"manual"` to the `trigger` union (`events.ts:132`) and yield the `compaction` event from `compactSession`                                                                                                                        |
| G28 | compaction is delivered twice to a reconnecting client               | live `agent-loop.ts:4107` + replayed `engine.ts:433-455`                                     | carry the `events.seq` on the replayed event so a client can dedupe; `ReplayFrame.seq` (`commands.ts:70-73`) already exists for backfill frames                                                                                       |
| G29 | `tui.ts`'s own reducer is unguarded                                  | `packages/orchestrator/src/bin/ui/tui.ts:5361-5396`                                          | make it a `switch` ending in `assertNever` and add it as a fifth `REDUCERS` entry                                                                                                                                                     |
| G30 | the drift law cannot see an empty or unreachable case                | `tests/unit/protocol/exhaustiveness.test.ts:65-89`                                           | out of scope to fix properly; at minimum, correct the stale "22 members" header (`:4`) and `docs/protocol.md:347-349`'s five-reducer claim, and delete the three unreachable `formatEvent` branches (`events.ts:146`, `:156`, `:268`) |

### 6.1 Lane split (disjoint file ownership)

**Lane L — lead lifecycle, compaction, headless, protocol.** Owns
`packages/protocol/src/events.ts`, `packages/orchestrator/src/engine.ts`,
`agent-loop.ts`, `context-engine.ts`, `headless.ts`, `session-replay.ts`, `task-state.ts`,
`brief.ts`, `turn-budget.ts`, `reliability-policy.ts`, `packages/shared/src/session.ts`,
`packages/shared/src/state.ts`, `packages/orchestrator/src/bin/ui/turn.ts`,
`bin/ui/events.ts`, `bin/ui/tui.ts`. Items G1–G9, G14–G23, G25–G30. **Lands the `lifecycle`
type and event first** — both other lanes consume it.

**Lane W — children, workers, leases.** Owns
`packages/orchestrator/src/delegated-sessions.ts`, `subagent.ts`, `subagent-result.ts`,
`subagent-budget.ts`, `worker.ts`, `worker-worktree.ts`, `worker-snapshot.ts`,
`worker-verification.ts`, `packages/orchestrator/src/team/bus.ts`. Items G10–G13, G24.
**Constraint:** Lane W must not edit `engine.ts`. New dependencies go on `WorkerDeps`
(`worker.ts:88`) / `SubagentDeps` (`subagent.ts:45`) as **optional** fields with working
defaults; Lane L wires them in one follow-up commit once both lanes have landed. G23's shared
predicate is exported by Lane L and _consumed_ by Lane W.

**Lane S — the scenario harness.** Owns `tests/` exclusively: a new
`tests/helpers/mock-model-server.ts` (the scripted OpenAI-compatible server of §3.2/§5.1), a
new `tests/helpers/scenario.ts` (fixture, spawn, kill, recover), and
`tests/integration/lifecycle-durability.test.ts`. May also add the fourth reducer entry in
`tests/unit/protocol/exhaustiveness.test.ts` **only if Lane L has not** — assign that file to
Lane L to avoid the collision. Lane S can build and run the whole rig against today's code
from day one: every assertion in §5.6 that has no artifact yet becomes a `test.todo`, and
flips to a real assertion as L and W land.

### 6.2 Changes that alter user-visible behavior or cost

- **G7** either adds a real resume path or deletes a table holding 184 MiB of the founder's
  own database. Deleting the writes is a measurable _reduction_ in per-edit latency and disk;
  deleting the table's contents is destructive and needs an explicit decision.
- **G6** makes a resumed run inherit spent turns. A user who kills and resumes today gets a
  fresh 80-turn ceiling; afterwards they will not. That is the correct behavior and it is a
  behavior change.
- **G13**'s startup reaper deletes `.rune/worktrees/*` directories. It must keep every
  `rune/worker-*` branch — the branch is the only copy of a failed worker's work
  (`packages/orchestrator/src/worker-worktree.ts:366-370`).
- **G3** and **G14** add two event types to every session's log. Sized against today's data
  the cost is small (`run_trace` is 1 548 rows / 484 KB lifetime), but it is not zero.
- **G12** makes a resume refusal survive a crash. A user whose process died mid-delegation
  will, after this, see a refusal until the TTL expires rather than an immediate retry. The
  TTL must be short and the message must say how to clear it.
- **G21** and **G23** change what a machine consumer sees. A run that ends with open steps
  will start exiting non-zero, and `filesChanged` will start listing worker-authored and
  `apply_patch` files. Both are corrections, and both will change the score of any benchmark
  adapter that already reads this envelope — including `tests/eval/comparison/`. Re-baseline
  deliberately; do not silently absorb the difference.
- **G15**, **G16**, **G18**, **G22**, **G25** change the words a failing run prints. No cost
  change.
- **G30** deletes three unreachable `formatEvent` branches. It will look like a coverage
  regression to the drift-law test unless the test is updated in the same commit.

---

## 7. Risks

**The scenario cannot run under a restricted sandbox.** Measured on 2026-09-10 in this
session: `Bun.serve({port: 0})` fails with `EADDRINUSE`, and `Bun.serve({unix})` under
`$TMPDIR` fails with `EPERM`. `tests/integration/engine-task-state.test.ts` — an existing,
passing test — fails the same way here. Lane S must be run with the sandbox off, and the
director should expect that to be the first thing a build agent hits.

**Ports.** Use `port: 0` and read `server.port`, never a fixed port; the repo's existing
servers already do (`tests/integration/acp-conformance.test.ts:126`). Never assume the child
resolved the URL — assert the server saw request 1 before scripting request 2.

**SIGKILL races.** A kill issued from the server's `fetch` handler is ordered _after_ the
request arrived but says nothing about what the child had flushed to sqlite. Two mitigations:
(a) the session store is WAL with `busy_timeout = 5000`
(`packages/shared/src/session.ts:53-55`), so a torn write is a rolled-back transaction, not
corruption — but `appendEvent` is not itself transactional (G20), so fix G20 _before_ relying
on this; (b) assert on _sets_, not on exact counts: "the recovered plan has step 2 open" is
stable, "the log has exactly 47 rows" is not.

**Orphan-process assertions are timing-dependent.** `ps` immediately after a kill will still
show the child. Poll with the existing retry shape — 24 attempts at 250 ms
(`tests/integration/zz-no-leaked-hosts.test.ts:49-53`) — and skip the assertion where `ps` is
absent, exactly as that test does.

**`skipIf(!HAS_RUST_BIN)` silently deletes coverage.** Three of the existing worker-isolation
tests already vanish without `cargo build -p rune-tools`
(`tests/unit/orchestrator/worker.test.ts:429`, `:457`, `:483`). The scenario needs the native
binary for its `bash` acceptance check; make its absence a **failure**, not a skip, and say so
in the test name.

**Two lanes, one working tree.** Concurrent sessions in this checkout have swept each other's
in-flight edits before. Lane ownership above is file-level and disjoint; the rule that makes
it hold is that no lane runs `git add -A`.

**The mock server is a second implementation of a provider wire.** It will drift. Keep it in
`tests/helpers/` with one owner (Lane S), script it by request index with a clamped tail
(`tests/integration/acp-conformance.test.ts:120`), and assert on the request bodies it
received rather than on how many requests happened.

---

## 8. What the director must decide before the build starts

1. **G7 — the `checkpoints` table.** Resume path, or delete? It is 184 MiB of a 250 MiB
   database, written on every file edit, and read by nothing. Deleting existing rows is
   destructive and is not something a build lane should decide.
2. **G6 — turn budget inheritance on resume.** Correct, but it changes what a user gets after
   a crash. Confirm.
3. **Sandbox.** Lane S cannot listen on a socket under the current policy. Confirm it may run
   unsandboxed, or the scenario stays unexecutable.
4. **Scope of §4's `lifecycle` event.** It is the smallest thing that makes all three
   consumers agree, and it touches the protocol package, which is the one file every lane
   would otherwise want.
5. **G21 + G23 re-baseline the headless envelope.** Runs that end with open steps will start
   exiting non-zero, and `filesChanged` will start including worker and `apply_patch` files.
   Every comparison figure recorded under `docs/evidence/` was produced by the old envelope.
   Confirm that the corrected envelope is the new baseline and that the old numbers stay
   preserved and labelled rather than being re-run.
