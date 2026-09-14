# The guarantees program (2026-09-14)

**Thesis.** Rune is a model-independent execution runtime that turns one
instruction into a verified result. The intelligence is rented and replaceable.
The guarantees (verification, recovery, evidence) belong to the runtime.

**Where we are (checked at HEAD b5aef39):** architecture 68/100, product 36/100.
Ten termination guards vote inside `agent-loop.ts` (5,139 lines) and nothing
arbitrates; completion is judged against the model's own restatement of the
request; the in-process sub-agents are real but the cross-instance scheduler is
dead; the comparison rig exists with zero recorded runs; nobody but the author
has run the binary. Adversarial verification found five holes in the assurance
layer in one week (all fixed, all promoted to red tests).

**Target, honestly.** On harness mechanics, ~85 is reachable: within reach of
Claude Code's ~88 on the same scorecard. Product past 60 has no code path; it
moves on strangers running the binary and on a published table they can
reproduce. "The only choice" is not a deliverable. "The best-evidenced
open-source harness for teams that must not be owned by a model vendor" is.

**Definition of production grade (applies to every subsystem below).** A typed
state; one ledger row per transition; a mock-rig scenario per failure class; a
floor eval that gates every change to it; a `rune doctor` check; a NO-SPEND
proof path. Nothing counts as done until a verifier attacked it.

## Phase 5 — the control core (the hole)

Everything later depends on this. Estimated 3–4 weeks at two concurrent lanes.

- **5A Guard inventory (1 day, design lane).** Every site in `agent-loop.ts` /
  `engine.ts` that can end, extend, refund, or redirect a turn: refunds, second
  winds, empty-completion counter, verify-attempt counter, evidence gates,
  plan-ledger / open-steps gate, loop detector, barren breaker, ask_user orbit
  breaker, budget caps, supervisor halts, provider recovery. Table: guard →
  what it reads → what it decides → tests covering it. The table sizes 5C.
- **5B TaskContract.** Created at intake from the request: intent (verbatim),
  scope, deliverable shape (fix / feature / question / plan), acceptance
  criteria promoted from the read-back brief, each with a rung (stated →
  observed → verified → refuted) and an evidence ref; budget (turns, cost,
  time); stop conditions. Persisted in the ledger and shown to the user.
  "Done" means every required criterion is `verified` or a named gap is
  declared. No completion without a contract verdict.
- **5C RunState.** One state machine: intake → contracted → working →
  verifying → repairing → blocked(ask | halt) → complete(verdict) |
  abandoned(reason). Every guard becomes a predicate that PROPOSES a
  transition; ONE arbiter applies precedence (safety halt > budget > contract
  verdict > progress heuristics). Every transition is a ledger row. The loop
  body becomes observe → propose → arbitrate → act. Migration is guard by
  guard: re-point the guard's tests at its predicate, delete the inline code,
  and a test asserts the line count of both files goes DOWN every commit.
- **5D AcceptanceGraph.** Every check (test run, typecheck, lint, pty capture,
  diff inspection, manual verification) binds to a criterion; unbound checks
  are "health", never "acceptance". The rung is computed, not narrated. When a
  file changes, only criteria whose evidence depends on it fall back to
  `observed` (targeted re-verification).
- **5E RepairEngine.** Typed failure classes (test failure, type error, tool
  error, provider error, budget, permission denial, contract mismatch) → a
  policy per class (what to retry, with what, when to escalate, when to stop)
  → targeted re-verification. Replaces the scattered retries.

**Proof.** The existing 45 lifecycle + 260 integration scenarios pass through
the migration unchanged. New: one arbitrated transition per guard trigger with
its ledger row; the audit's example (typechecks and tests green, a requested
feature silently omitted) FAILS acceptance — red today, green after; the
`agent-loop.ts` cap enforced by a test. Expected: architecture 68 → ~80.

## Phase 6 — long-horizon runtime (hours and days)

Depends on 5. Estimated 2 weeks.

- **Mission.** A durable object in `rune.db`: contract + schedule of runs +
  watch conditions + cross-run budget. Survives process death; on restart the
  RunState resumes from the last checkpoint (possible only because 5C moved
  the guards' in-memory counters into typed state).
- **Keel (the supervisor process).** Deterministic, not a model. Watches
  triggers (file changes, CI status, cron tick, quota-reset time), decides
  whether to wake a run, enforces the daily cap across runs, backs off and
  re-routes on provider outages, and on a 429 schedules the resume at the
  reset time the error carries (three long runs died exactly here).
- **Sleep awareness.** Host sleep (`pmset` log, monotonic-clock jumps) counts
  as neither elapsed budget nor a stall.
- **Responding to change.** Watch mode: a change in the watched inputs creates
  a new contracted run carrying the delta, bounded by the mission budget.
- **Monitoring.** The agents panel becomes the mission view; `rune status`
  headless; the ledger is the single source.

**Proof.** Mock rig with a fake clock: a 48-hour mission in minutes; `kill -9`
at every state and resume; a 429-with-reset-time scenario resumes at the reset;
host sleep burns no budget; one real overnight dogfood run on a free route with
the ledger as proof (zero spend). Expected: recovery 6 → 10, durable state 8 → 9.

## Phase 7 — production-grade Auto, sandbox, sub-agents, security

Partly parallel with 5 (the CI items are independent). Estimated 2 weeks.

- **Auto mode.** The auto-safety floor (P 92.8 / R 89.1 / F1 90.9 plus the 93
  supervisor rows at 100) gates every gateway change; the classifier's
  fail-closed path is a typed `blocked` state, not a counter; injection-aware
  review keeps its own floor.
- **Sandbox.** The Linux containment image runs in GitHub Actions on every PR
  (ends the dependence on the founder's Docker Desktop); the toolchain-root
  symlink probe joins it; the three-tab policy gets a doctor check.
- **Sub-agents.** A child gets a sub-contract derived from the delegation, its
  own budget and sandbox policy, and returns evidence (receipts), which the
  master accepts through the AcceptanceGraph, never through prose. The dead
  cross-instance TeamBus and workflow code is deleted (an unproven claim
  removed is a point gained).
- **Security.** Threat-model refresh (the wildcard-bind list), secrets never in
  config/log/transcript (asserted in tests), a prompt-injection eval set with a
  floor, `rune doctor --security`.

**Proof.** A child that reports "done" with no evidence is rejected; a runaway
child is stopped at its budget with a ledger row; containment green on Linux
in CI; floors unchanged or better on every change.

## Phase 8 — evidence strangers can check

Baseline runs DURING Phase 5 (compute time, not lane budget), the after-table
once 5 lands. Estimated 1–2 weeks of wall clock.

- Same model, same tasks, same limits, different harness: Rune vs OpenCode vs
  Pi on a SWE-bench Verified subset (~50) and the Harbor set through the
  existing adapters, on a free route (zero budget), throttled runs excluded as
  the rig already does. Columns: first-pass acceptance, silent defects (tests
  green, requirement missed: measurable only once 5B exists), cost per
  accepted task, correction turns.
- Published with its caveats where practitioners read; one reproducible
  command.
- The docs diet: fix the eval README drift, archive prose that does not
  describe the current system, one README that says the thesis sentence. Stop
  renaming.

**Expected:** product 36 → ~50 with the table; past 60 only with users.

## What is deferred, and why

Handoff rows 5 (frontend workflows) and 6 (self-evolution) are capability work
on a loop that does not yet hold; they return after Phase 6. The semantic
ownership graph and model profiles stay deferred indefinitely.

## Sequence and budget

| Order | Phase                            | Depends on | Est.                 | Score moved       |
| ----- | -------------------------------- | ---------- | -------------------- | ----------------- |
| now   | 4 (landing)                      | —          | this week            | product → low 40s |
| 1     | 5 control core                   | —          | 3–4 wk               | arch → ~80        |
| 1′    | 7 CI items (containment, floors) | —          | days, parallel       | robustness        |
| 1″    | 8 baseline runs                  | free route | wall clock, parallel | evidence          |
| 2     | 6 long-horizon                   | 5          | 2 wk                 | recovery → 10     |
| 3     | 7 remainder                      | 5          | 2 wk                 | arch → ~85        |
| 4     | 8 after-table + docs diet        | 5          | 1–2 wk               | product → ~50     |

Two concurrent Opus lanes maximum with a verifier per lane (five concurrent
hit the weekly cap twice on 2026-09-11 and 2026-09-14). Roughly one quarter,
and the guard inventory will correct the estimate in the first week.

## Founder decisions needed

1. Approve Phase 5 as the next phase (replacing handoff rows 5–7 in this order).
2. Delete the cross-instance TeamBus and workflow code, or quarantine it.
3. Which free route carries the benchmark baseline, and the task count.
4. Push the branch, and reset Docker Desktop (or accept CI-only Linux proof).

## The five-day cut (founder decision 2026-09-14: "5 or more days, contract first")

The subscription funding the Opus lanes ends in about five days; after that the
founder continues alone or through Rune on a free route. The cut is ordered so
that whatever the cutoff, the tree is coherent and the next step is a failing
test with a spec.

| Day | Lands                                                                                                                                                                                      | Keep-if-cut-here                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 1   | Phase 4 committed, one verifier for all four lanes, fixes, gates, install, push                                                                                                            | the UI, usable                                        |
| 2   | 5A guard inventory; 5B TaskContract at intake + completion verdict (additive, guards stay); Linux containment + install smoke in GitHub Actions                                            | completion defined; Linux proof off the founder's Mac |
| 3   | 5B verified and repaired; 5C as a SHADOW arbiter (RunState typed, predicates propose, ledger rows, guards keep control)                                                                    | zero behaviour risk, migration data                   |
| 4   | shadow arbiter verified; arbiter-vs-guards report over the 93 stored runs; red tests defining 5D/5E/6 (silently omitted feature must fail acceptance; 429 resume at reset; kill -9 resume) | next steps as failing tests                           |
| 5   | final gates, install, evidence manifest, continuation guide (lanes through Rune itself on a free route)                                                                                    | the leave-behind                                      |

Budget rules: at most two build lanes at once; verifiers, captures, inventories
and CI work on Sonnet; Opus only for contract/arbiter design and build; one
verifier per phase, not per lane. Not attempted in the window: the full guard
migration, the mission runtime, the benchmark table (SWE-bench evaluation needs
Docker per task). Expected at the stop: architecture ~73, product low 40s.
