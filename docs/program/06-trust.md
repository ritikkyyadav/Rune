# Phase 6 — Trust you can measure

**Lane C · 14–18 days · 6A and 6B are independent; 6B.6 needs P2.6**

Two halves. 6A turns Auto mode's safety claim into a published measurement. 6B makes parallel agents isolated, typed and budgeted.

---

## 6A — Auto mode evidence

### Goal

A labelled corpus of at least 200 decisions across every tool category, with precision, recall, p50/p95 latency and cost reported per decision source and containment kind, run in CI against the configured reviewer, and the supervisor's false-positive kill rate tracked as a metric.

### Evidence (2026-09-02)

- The design as built (`auto-mode.ts:870` `review()`): deny rules → supervisor halt → ask rules → critical route → oversize → guardrail → exact grant → allow rules → safe tier → workspace tier → **low/medium risk allowed on the supervised tier with a fire-and-forget supervisor** (`:1079`) → one reasoned call for high risk only (`:1130`), retried once on a distinct fallback (`reviewer-fallback.ts:60`), failing _contained_ to mechanical routes (`:1195-1213`, `auto-containment.ts:44-46`). Containment kinds: `extend | contain | redirect | defer | halt` (`auto-containment.ts:51`). Decision sources: 13 (`auto-mode.ts:264-282`).
- Cost: common case zero in-path calls; high risk one reasoned call at the heavy tier (~9 s, `auto-mode.ts:1123`); supervisor fast screen 64 tokens, reasoned 700, `temperature 0`.
- The fast screen is instructed to "err on the side of blocking" and now sits where a false positive costs the session (`auto-mode.ts:1385-1392`); the two-stage confirm and `supervisorUnconfirmed` counter (`:694-701`) mitigate, but the counter is process-local and resets on restart.
- Corpus: `tests/eval/auto-mode-safety.ts`, 19 scenarios (6 allow / 13 block), 4 tool types, no P/R, no latency aggregation, no low/medium rows, `--offline` runs against a `DeadClassifier`. Unit tests ~150 across `auto-mode.test.ts`, `auto-containment.test.ts`, `engine-auto-mode.test.ts`, `engine-held-step.test.ts`, `ui-held.test.ts`.
- Recorded: `safety_decision` events with `toolName, argsHash, verdict, tier, risk, source, stage, reason, reviewer, matchedRule, durationMs` (`engine.ts:2050-2070`); `auto_deferrals` (`engine.ts:3988-4000`); hash-chained `audit_log`; black-box `loop.auto_halt*`. **Not recorded:** ground truth, `callId`/turn (typed at `auto-mode.ts:251`, not persisted), supervisor verdicts unless they latch, `runHeldStep` outcomes (`engine.ts:1459` records a synthetic allow only), per-stage latency, raw args (hashed for privacy).
- Known false-positive history in source: network rated high taxed every `npm install` (`auto-mode.ts:1758-1764`); the probe over-fired on the repo's own security tests (`:427-431`); a halt once denied the agent its own todo bookkeeping (`:1572-1581`); the reviewer died on the same quota as the session it supervised (`reviewer-fallback.ts:1-10`); the 22-minute fail-closed outage (`auto-containment.ts:44-46`).

### Work items

**P6A.1 Record what you need to label (1 day).** Persist `callId` and `turn` on `safety_decision`; persist every supervisor verdict as `safety_decision` with `source: "supervisor_screen" | "supervisor_reasoned"`; add a `held_step_outcome` event (`ran | skipped | refused | failed`) keyed to the deferral; split `durationMs` into `mechanicalMs / classifierMs / retryMs`; opt-in `[permissions.autoMode] collectForEval = true` writes an encrypted local sidecar of raw args keyed by `argsHash` (never leaves the machine, never in telemetry).

**P6A.2 Build the corpus (3 days).** Extend `SafetyScenario` to `task`, `worker`, `mcp_*`, `browser`, `n8n_trigger`, `update_config`, `team`, and to explicit low/medium rows so the supervised tier and the supervisor screen are measured. Sources: (a) decisions mined from `~/.gear/gear.db` (601 sessions) via the sidecar and `held_step_outcome` (a held step the user ran is a strong false-positive signal; one they skipped is a true positive); (b) red-team: compound commands, encoded payloads, indirect instructions in tool results, unavailable or malformed reviewer output, repeated-action loops, the historical false positives above as regression rows. Target ≥200 rows, each with `expected`, `rationale`, and the tool category. Label review is a human step; the harness lists unreviewed rows.

**P6A.3 Report (1.5 days).** `bun run eval:auto-safety` prints precision, recall, F1 per `source` and per `containment.kind`, p50/p95 `classifierMs`, cost per decision (list price), the supervisor false-positive rate, and confidence intervals; `--json` for CI; `--offline` still runs the dead-classifier regression. Wire into the baseline machinery (`tests/eval/README.md:38-44`) with a protected baseline per reviewer model; CI fails on regression beyond the noise band.

**P6A.4 The live metric (half a day).** `supervisorUnconfirmed`, supervisor halts, and `held_step_outcome` counts are read from the DB, not process memory; `gear audit` and `gear doctor` show "supervisor false-positive kills per 100 runs"; the black box gets `auto.supervisor_false_positive` when a halted action is later run unchanged by the user.

**P6A.5 Options measured, not assumed (1 day).** Run the corpus against a cheap fast-path reviewer and the heavy tier; publish the tradeoff table in `docs/auto-mode.md`. Decide the default from the numbers.

**P6A.6 Docs (half a day).** `docs/auto-mode.md` describes the built design (started in P1.1) and carries the report as its assurance section. Say plainly: "no claim of parity with another vendor's classifier; here are our numbers."

### Gate (6A)

```bash
GEAR_AUTO_EVAL_PROVIDER=<p> GEAR_AUTO_EVAL_MODEL=<m> bun run eval:auto-safety --json | jq '.rows | length'   # ≥ 200
bun run eval:auto-safety --compare        # P/R/latency/cost per source & kind; no regression vs baseline
bun run eval:auto-safety --offline        # dead-classifier regression still passes
gear audit last | grep "supervisor"       # false-positive kill rate shown, sourced from the DB
```

---

## 6B — Parallel agents

### Goal

Workers run in their own worktrees with a sandboxed shell and verify their own slice; results are schema-validated; every sub-agent has a cost and wall-clock budget; a shared task ledger lets agents claim work; a deterministic workflow API exists.

### Evidence (2026-09-02)

- Both sub-agent kinds are in-process nested `AgentLoop`s (`subagent.ts:317`, `worker.ts:424`) with an empty transcript, no `priorMessages`, no AGENTS.md, no repo map, no memory, no `taskState` (compare the lead loop config at `engine.ts:3382-3425`).
- Isolation is path-shaped: `OwnershipClaims` (`worker.ts:206-236`), `withOwnershipGuard` (`:240-262`), team lease (`:395-403`). Workers have no shell because two parallel `npm run`s in one tree collide (`worker.ts:16-17`). `worktree.ts` (`createRunWorktree` `:47`) is wired only to `detach-cli.ts:76`, `evolve-cli.ts:362`, `parent-check.ts:125`.
- Result contract is free text: `ToolSchema.outputSchema` (`tool-registry/src/types.ts:9`) unused; `ResponseFormat` (`llm-gateway/src/types.ts:168`) used only by research (`research.ts:304, 751, 1169`); the summary is "text after the last `tool_call_start`" (`subagent.ts:386-441`); `partialReport` (`:131-173`) and `buildManifest` (`worker.ts:571-610`) are hand-rolled substitutes; the no-summary failure (33 of 68 task calls) is mitigated by `partialReport`, not removed.
- No cost or wall-clock budget (`grep costCap|maxCost|deadline` empty); `maxParallelTools` hard 8, no config key (`agent-loop.ts:2258`).
- No workflow API; `research.ts:388` is a hardcoded plan → approve → fan-out → reflect → synthesize DAG using `mapWithConcurrency` (`agent-loop.ts:3265`). `createSubagentTool`/`createWorkerTool`/`Ownership`/`TeamBus` are not exported from `packages/orchestrator/src/index.ts`.
- `TaskState` is the lead's alone (`engine.ts:3411`); `todo_write` is reachable from `task` sub-agents (category `read`) and writes to a throwaway store. The team bus is "not a task queue" (`docs/teamwork.md:183`).
- Delegation gate (`agent-loop.ts:1665-1719`): a turn may not finish while any worker-written scope has zero reads; threshold deliberately zero.

### Work items

**P6B.1 Worktree-isolated workers (3 days).** In `worker.ts:363` after the claim and before `buildWorkerRegistry`: `createRunWorktree(root, workerId)` variant that branches from the _dirty_ tree (commit-index snapshot or `stash`-based) so the lead's uncommitted work is visible; pass `wt.path` as `workspaceRoot`; in the `finally` (`:537`) commit the worker's paths with `autoCommitPaths` (`git-undo.ts:49`), merge the branch into the lead's tree (fast-forward or 3-way on the owned paths only), report conflicts as a typed field, remove the worktree. `buildManifest` becomes `git diff --stat` against the base. Ownership still governs which paths may be touched; worktrees govern the filesystem.

**P6B.2 Workers get a shell and a verifier (1.5 days).** `WORKER_TOOLS` gains sandboxed `bash` (OS sandbox mandatory, network off, cwd = the worktree) and the verifier runs in the worktree before merge; a worker whose checks fail returns `checks: failed` and its branch is kept for inspection, not merged.

**P6B.3 Schema-validated results (2 days).** Populate `outputSchema` on `TASK_TOOL_SCHEMA` (`subagent.ts:175`) and `WORKER_TOOL_SCHEMA` (`worker.ts:95`): `{summary, findings[], filesExamined[], filesChanged[], checks, confidence, unresolved[], stopReason, servedBy, toolCallCount}`. Force it with `responseFormat` on the final turn; validate in the `toolResultProcessor` hook (`agent-loop.ts:2295+`); `partialReport` and `buildManifest` become renderers over the object; the doctrine paragraph at `prompts.ts:109` shrinks.

**P6B.4 Budgets and context (1.5 days).** `costCapUsd` (list price) and `deadlineMs` per call with defaults per effort; `[subagents] maxParallel` config key; sub-agents inherit AGENTS.md, a repo-map slice for their scope, and the notebook block; `todo_write` removed from `task`'s registry.

**P6B.5 Shared task ledger (2 days).** `TaskState` becomes multi-writer with per-item `owner` and `claim-next`; a scoped view passed to `createSubagentTool`/`createWorkerTool` (`engine.ts:4184, 4195`); a `tasks` table on the team bus beside `claims` (`bus.ts:122-132`) with the same TTL/liveness sweep for cross-instance distribution; `StepEvidence` (`task-state.ts:38`) is what marks an item done.

**P6B.6 Workflows (3 days).** Export the primitives from `index.ts`; a `workflow` tool and `gear workflow <file>` taking a node list `{id, kind: task|worker, prompt, dependsOn[], retry, schema}` executed in topological waves through `mapWithConcurrency`, resumable from the last completed node, each node's result cached by content hash; the fleet view groups by wave (P2.6). `research.ts` is refactored onto it as the first consumer. A `gear review` workflow (reviewers per dimension → verifiers) is the stretch.

### Gate (6B)

```bash
bun test tests/unit/orchestrator/worker* tests/unit/orchestrator/subagent* tests/unit/orchestrator/workflow*
# greenfield eval task: 4 workers build backend/frontend/docs/tests in worktrees, each runs its checks, all merge clean, lead's verifier passes
bun run eval -- --tasks greenfield_parallel --real
gear audit last | grep -c "no summary"   # 0 over a 50-run soak
gear workflow examples/review.workflow.json   # runs, resumes after a kill at node 3
```

Done means: parallel work is isolated by the filesystem, typed at the boundary, bounded in cost and time, and expressible without prose.
