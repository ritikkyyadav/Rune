# Phase 7 — Self-improving, not self-mutating

**Lane C · 10–14 days · needs P1.1 (retro scope) and P1.2 (the organ committed)**

## Goal

A closed loop: a proposed change to a declared knob is run as a paired A/B on the eval harness and promoted only on a measured win, with lineage and one-command revert. A permanent control group. Structural tests that prove the loop cannot touch what it is allowed to change.

## The distinction, stated once

A change is **self-improvement** when it is (1) in a declared, enumerable space, (2) measured against a fixed yardstick, (3) attributable to the run that produced the evidence, and (4) revertible in one command. A change missing any one of those is **mutation**. Size does not matter; a boolean flipped without measurement is mutation, a 400-line skill promoted through a paired A/B with a ledger entry is improvement.

## Evidence (2026-09-02)

- Designed loop (`docs/self-evolution.md`): run → retro → notebook → playbook → next run; retro → scorecard → tune (proposals only); black box → gardener (a branch, a person on the merge). The doc says the A/B "is not built."
- The trunk run → retro → notebook → playbook is real and automatic. It has run 10 times, all in another workspace (`evolab7`); zero retros exist for this repo. `writePlaybook` (`engine.ts:3923`) would fire on the next completed run here (its threshold of two sessions is met by `monorepo-layout` with seven).
- The retro is turn-scoped but reads the session spine (`retro.ts:209, 214, 261`); fixed in P1.1.
- History is read and never written back: `evolve-cli.ts:113` derives 128 retros with lessons, `cmdStatus` counts them (`:380`), and `recordLessons` has one call site (`engine.ts:3916`), never the backfill. Hence 0 pitfalls.
- Three of four tune rules key on `unproven`, `stalled`, `open_steps` (`retro.ts:593-636`): zero occurrences in 601 sessions. The failure modes that occur (`aborted` 71, `error` 64, `max_turns` 16, `halted` 9) are counted by `scorecard` (`retro.ts:511-529`) and read by no rule. `TuneProposal.config` is prose (`retro.ts:579-585`), not a patch.
- The eval harness (`tests/eval/harness.ts`) runs real or mock models, verifies artifacts only, gates in CI (`ci.yml` `eval`, `eval-real` nightly), can sweep models (`GEAR_MODEL_SWEEP`) but **cannot A/B configurations**: `new Engine({...})` at `harness.ts:270-277` threads six fields; `doctrineDelivery` (`engine.ts:394`), `effortRouting` (`:401`), `reasoningEffort` (`:386`), `notebook`, `verify`, `context.repoMap` are not threaded.
- Nothing records which configuration produced a run: `system_prompt_hash` exists in the schema (`session.ts:55`) and is NULL for all 601 sessions; the retro payload is `{retro, model, provider}` (`engine.ts:3907-3914`); `AGENT_DOCTRINE` has no version or hash.
- The incident → eval flywheel is built and empty: `tests/eval/from-incidents.ts` scaffolds tasks; `tasks-from-incidents.ts:12-15` is `[]`; `covered.json` is `{}`; the black box holds ~5.8 MB.
- The widest automatic action has the weakest gate: the playbook writes an executable skill into the user's workspace (`playbook.ts:18`) on a recurrence count of 2, with no measurement and no revert but git. The narrowest action (a TOML boolean) is blocked entirely.
- `GARDENER_OFF_LIMITS` (`retro.ts:687-696`) is enforced only as text in a prompt (`:735`).
- `CostGovernor` (`notebook/governor.ts`) is built and never called.

## Work items

**P7.1 Attribution (1 day).** `prompts.ts` exports `DOCTRINE_VERSION` and `doctrineHash(ctx)`; `session.ts:182-184` writes `system_prompt_hash`; the retro payload gains `doctrineHash`, `configHash` (over the A/B-relevant `EngineConfig` fields), and `arm`. Without this, nothing downstream is attributable.

**P7.2 The harness can express a configuration (1 day).** `RunOptions.configOverrides?: Partial<EngineConfig>` and `arm?: string` spread into `new Engine` (`harness.ts:270-277`); `TaskResult.arm`.

**P7.3 The variants registry (1 day).** `packages/orchestrator/src/evolve/variants.ts`: a closed, typed map from variant id → `Partial<EngineConfig>` (+ optional doctrine-section overrides). This is the allowlist. Structurally absent: anything under `permissions`, `sandbox`, `autoMode`, `yoloMode`, `trustWorkspace`, cost caps, `verify.*` gates, and everything in `GARDENER_OFF_LIMITS`. `TuneProposal.config` becomes `variant: VariantId`. Add rules that key on `aborted`, `errored`, `max_turns`, `halted`.

**P7.4 Paired A/B (2 days).** `runner.ts --ab <variantId>`: control then treatment on the same task set, same order, same seeds, same process; `report.ts compareArms()` reports the per-task delta and gates on: no task regresses; `cleanPassRate` up beyond the noise band; `totalListCost` not up beyond a band; throttles acceptable. Mock mode (deterministic) is the cheap gate; real mode carries the noise band. Two-key rule: both must pass.

**P7.5 Promote and revert (1.5 days).** `evolve/promote.ts`: on a passing A/B write the variant's lines into `~/.gear/config.toml` inside a generated fenced block (same marker discipline as `playbook.ts:117-126`) and append to `~/.gear/evolve-ledger.jsonl` (variant, both config/doctrine hashes, both reports, per-task deltas, eval-suite commit sha, timestamp). `gear evolve ab <id>`, `gear evolve promote <id>` (refuses without a passing ledger entry for that exact hash pair), `gear evolve revert [n]`, `gear evolve why <id|lesson>` (lineage: born from incidents, fired in sessions, win curve, transitions). One promotion per interval; automatic halt after two consecutive reverts.

**P7.6 Lessons lifecycle (1.5 days).** `candidate → trial → active → retired` per the 2026-07 plan §2.4: candidates stored and never injected; trial injected with `(lessonId, sessionId, outcome)` logged; active after ≥5 firings with win-rate ≥ baseline + margin; retired on decay, disuse, contradiction (already built for `avoid:`), or user disable. Outcome signal: a turn is a win when the evidence gate passed, no `error+` incidents, no correction/rephrase (`struggle.*`). Repo-scoped lessons may promote on live signal; global-scope and every variant need the offline A/B. The backfill path calls `recordLessons` as candidates. `CostGovernor.allow()` gates any model-assisted distillation.

**P7.7 The playbook under the same discipline (1 day).** The playbook skill is written only for `active` lessons; its promotion is a ledger entry; `gear evolve revert` removes it; the notice names the change. A learned skill that can direct multi-step behaviour is inert until the user enables it once (the consent gate from the 2026-07 plan §2.2 Layer 3).

**P7.8 The flywheel (1.5 days).** `from-incidents.ts` promotes every fingerprint class with ≥3 occurrences into a deterministic task in `tasks-from-incidents.ts`; `covered.json` tracks coverage; CI fails when an uncovered class crosses the threshold. Gardener fixes are validated by the same harness.

**P7.9 External anchors (1 day + monthly).** A pinned SWE-bench Verified subset (50 tasks) and a Terminal-Bench subset run monthly with `--pristine` and evolved arms; numbers published in `docs/benchmarks.md` with dates and models. This is the yardstick nothing inside the loop may edit.

**P7.10 Invariants as tests (1 day).**
- Dependency-graph test: `permissions.ts`, `security.ts`, `org-policy.ts`, `auto-mode.ts`, `auto-containment.ts`, sandbox modules import nothing from `notebook/`, `retro`, `playbook`, `evolve/`.
- Off-limits enforcement: the gardener worktree gets a mechanical write-deny (pre-commit check) on `GARDENER_OFF_LIMITS`; a test proves a gardener run cannot commit a change to `prompts.ts`.
- Yardstick lock: any diff under `tests/eval/**` voids promotions until a human re-baselines.
- Superstition red-team: noise outcomes → nothing reaches `active`.
- Poisoning red-team: hostile repo content → no command lesson without prior user-approved provenance.
- Lifecycle property: every `active` artifact has ≥N firings and evidence-linked transitions; nothing skips `trial`.

## Gate

```bash
git ls-files packages/orchestrator/src/retro.ts packages/orchestrator/src/playbook.ts packages/orchestrator/src/bin/evolve-cli.ts | wc -l   # 3 (tracked)
bun test tests/unit/evolve/ tests/unit/orchestrator/evolution-invariants.test.ts
bun run eval -- --ab doctrine_full            # paired report; mock deterministic
gear evolve ab doctrine_full && gear evolve promote doctrine_full   # ledger entry written, config block written
gear evolve revert                            # block removed, ledger says so
gear evolve status                            # ≥1 active lesson with lineage, ≥1 retired, last measured lift with date
```

Done means: Gear can connect an action to an observation, and cannot change what it is permitted to do.
