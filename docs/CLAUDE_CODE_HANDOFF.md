# Rune: execution handoff to Claude Code

Prepared 2026-09-10 in `/Users/ritikyadav890/Project/Alan`.

## Start here

The founder wants a cohesive, reliable, affordable coding harness: download Rune, configure intelligence and internet access in the terminal, and start working. Priorities are dependable Auto mode, useful subagents, durable compaction and planning, strong sandboxing, better frontend work, and bounded self-evolution. The immediate request is a handoff because the founder has approximately 5% of their Codex weekly allowance left. This document is a plan, not a claim that the remaining work has been completed.

**Continue the existing implementation. Start with Phase 0 below. Do not restart the entire audit or rewrite the product.** Complete a phase, preserve its evidence, and update the progress table before moving on. Routine local engineering is already requested; do not repeatedly ask permission to inspect, fix, or test. This document does not authorize new provider spending, external messages, publishing, or changing the license.

The user explicitly chose **keep the current license**. Preserve `LicenseRef-Proprietary`; do not describe the current licensing as open source. Current product branding is Rune; Alan/Gear names occur in paths and compatibility internals. The terminal is the product surface; do not revive removed web/desktop interfaces as part of this plan.

## Snapshot and ownership

- Checkout: `/Users/ritikyadav890/Project/Alan`.
- Branch: `gear/phase-0-stabilize`.
- Observed HEAD: `8c4c58f885f4eb3058d1bd1f839b06a1a3011189`.
- **The branch and installed binaries advanced while this session was paused.** Re-read HEAD, status, and relevant diffs before changing anything. Preserve other contributors' work. Do not reset, clean, blanket-stage, or replace files from an older snapshot.
- Installed metadata says `Rune v0.4.1-dev+8c4c58f`, source dirty, guarded with macOS `uchg`.
- Observed CLI: `~/.rune/bin/rune-compiled`, SHA-256 `296e185328c1b20aeeb6007acbba3171a55526d1ad91a505ff3874ae6ef88f4a`.
- Observed native tools: `~/.rune/bin/rune-tools`, SHA-256 `f849020a257b10c26eb6f72ad97c7c49960be48170e5e1faf5259031996633c2`.
- Those hashes were checked, but this handoff **does not certify the latest installation against the latest combined source**. The previous installation had different hashes.

Tracked changes still present when this handoff was written:

```text
crates/rune-sandbox/src/linux.rs
crates/rune-sandbox/src/spawn.rs
docs/harness-status.md
packages/orchestrator/src/agent-loop.ts
packages/orchestrator/src/brief.ts
packages/orchestrator/src/engine.ts
packages/tool-registry/src/tools/plugin-tools.ts
tests/integration/background-sandbox.test.ts
tests/integration/engine-command-evidence.test.ts
tests/integration/plugin-tools-sandbox.test.ts
tests/unit/orchestrator/agent-loop-settled-plan.test.ts
tests/unit/orchestrator/brief-ledger.test.ts
```

Untracked evidence to preserve: `docs/evidence/cache-probe-20260910.json`, `comparison-20260909-i.json`, and `verification-20260910.json`. This handoff also adds `comparison-20260910-j.json` in that directory. Inspect any additional changes that appear after this snapshot.

Private raw logs are under `.codex/audit-20260909/` and `.codex/audit-20260910/`. Keep those private: provider errors and session databases can contain credentials or response headers. Do not publish credential stores or copy them into containers. Older `/tmp` evidence was purged during pauses; use preserved aggregate reports where raw evidence is unavailable and state that limit.

## What has already been implemented

Read [the audit follow-through](audit-followthrough-20260908.md) for details rather than repeating that work. Existing code includes:

- Bounded/batched Auto supervisor review, shared spend reservations, recorded review skips, and separate mechanical risk checks.
- Worker snapshots carrying dirty/untracked code and dependencies; ownership-aware integration, conflict retention, child checkpoints, leases, and resume handling.
- Compaction that persists the reduced working set and opaque provider content through restart; prompt budgeting, incremental pruning, and unchanged-state no-op handling.
- Step evidence tied to real writes and checks, browser receipts and delivered screenshots, command exit-code propagation, and ordered same-response check/citation handling.
- TUI settings that validate, apply, persist, and reload through one path; an earlier installed 80×24 smoke made no inference calls.
- Bounded empty-response/recurrence recovery, control-cohort learning promotion rules, and independent acceptance/provenance/cost comparison machinery.

Core coordination work is in `f1b9366`; much subsequent work is in `897b192`; `0946e42` adds Linux CI prerequisites and binary environment variables. These components exist, but broader reliability and cost superiority remain unproven.

Newer commits require reconciliation with the uncommitted patch:

| Commit               | Change                                                                        | Review concern                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9984109`            | Inline assertion-script classification; comparison credential-path forwarding | Overlaps the execution-receipt patch. Current `inline-check` integration expectation still treats a genuine inline assertion as unclassified. Resolve semantics and tests together.     |
| `d18fde0`            | Silent responses can finish after writes or earlier narration                 | A write is not sufficient proof of task completion. Verify finish gates and incomplete-result reporting still hold.                                                                     |
| `be0b468`            | Bounded nudges for tool arguments printed as JSON                             | `misencodedToolCall` returns the first matching schema, although its comment says exactly one. Test ambiguous schemas and deliberately requested JSON answers before changing behavior. |
| `8003ec2`, `73f52d4` | Preserved free-route comparison series                                        | Keep them as separate model/build series; do not mix with frontier-model results.                                                                                                       |
| `8c4c58f`            | TUI, diff, help, picker, piped output, native list/edit changes               | Preserve these changes; verify the combined installation, including real terminal behavior.                                                                                             |

## Evidence: what passed, and on which source

| Evidence                                                                  | Scope                                                                                                                                                                                                                                     | Limitation                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [September 10 verification manifest](evidence/verification-20260910.json) | `0946e42` plus the completed-plan correction: 4,375 unit passes/1 skip; 148 integration passes/5 skips; 14 uncached typecheck tasks; 7 uncached lint tasks; 63/63 mock evaluations; guarded install and installed settings/browser checks | Predates newer shared commits and the subsequent receipt/plugin/Linux changes. Do not relabel these results as latest-HEAD validation.                                                                                |
| Earlier native verification                                               | 94 Rust tests; recorded native artifact unchanged at that point                                                                                                                                                                           | Predates the latest `spawn.rs` changes.                                                                                                                                                                               |
| `.codex/audit-20260910/receipts-plugins-targeted.log`                     | 67 passes, 0 failures, across brief-ledger, Engine command-evidence, plugin-sandbox suites                                                                                                                                                | Passed before the newer shared commits. Plugin tests prefer `target/release/rune-tools` over debug and currently ignore the explicit binary environment variable, so this does not prove the newest Rust plugin code. |
| `.codex/audit-20260910/linux-tests-fixed.log`                             | Earlier corrected Linux image: 17 passes, 4 failures; background containment and Engine cases passed                                                                                                                                      | Four plugin failures led to the latest fixes. Preserve the failures.                                                                                                                                                  |
| `.codex/audit-20260910/linux-build-complete.log`                          | Final Linux image compiled successfully                                                                                                                                                                                                   | **The final image was not executed in this handoff.** It also predates the latest shared commits.                                                                                                                     |

Historical skips: one unit needs a case-sensitive disk; five integrations need Go/Java. Earlier restricted-PATH `doctor` reported missing `npx`, even though native tools and settings checks passed. State skips and diagnostics rather than reporting a fully green installation.

Live evidence is mixed:

- [Pilot H](evidence/comparison-20260909-h.json): Rune passed artifact acceptance but timed out at 240 s, estimated $0.15845; OpenCode finished in 209 s at $0.11180.
- [Pilot I](evidence/comparison-20260909-i.json): interrupted by provider quota, unscored; no OpenCode arm.
- [Pilot J](evidence/comparison-20260910-j.json): `0946e42` plus the plan fix, before receipt/inline fixes. Rune artifact passed but timed out at 240.033 s, 11 usage entries, estimated $0.138516. OpenCode completed in 154.189 s, 10 entries, $0.0751745. Rune cost about 84% more on this attempt. A passing inline assertion was repeatedly refused as “never ran”; fixing that is not yet measured proof of parity.
- [Free-route series C](evidence/comparison-20260910-free-c-notes.json), recorded by another contributor: `be0b468`, `gpt-oss:120b`, three tasks × two runs; Rune 5/6 completed and OpenCode 4/6. Recorded estimated totals $0.0273 and $0.0496. This is useful local evidence on a different route, not a universal ranking or an invoice comparison.
- [Cache probe](evidence/cache-probe-20260910.json): four requests/layout; total cached tokens control 2,688, folded 1,536, trailing-user 5,888. No consistent benefit from folding was established. One small sequence does not establish causality either way.

These are internally authored pilots. Do not assign an overall “OpenCode = 100, Rune = X” score from them. SWE-bench/Harbor adapters exist; an adapter is not an official benchmark result.

## Execution order

| Phase                                             | Status at handoff                                    | Completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Reconcile and finish current correctness fixes | **Done** 2026-09-10, committed `980bf1e` + `c053ca4` | Focused regressions 233/0; Linux image `:20260910-final` ALL STEPS PASSED (16/16 crate, 32/0/0 integration); source diff reviewed and committed in two scoped commits                                                                                                                                                                                                                                                                                           |
| 1. Verify and deliver one coherent build          | **Done** 2026-09-10, with named gaps                 | [Phase 1 manifest](evidence/verification-20260910b.json): unit 4,480/0/1, integration 159/0/5, typecheck 14/14 uncached, lint 7/7 uncached, cargo 97/0, clippy 0 warnings uncached, evals 63/63 baseline unchanged; guarded install with no override, `v0.4.1-dev+c053ca4`, CLI `78239eb4…`; doctor/tools-smoke/Chromium green. **Not covered:** installed 80×24 settings save/restart, picker/resize/cancellation, headless exit codes on the installed binary |
| 2. Stress one durable task lifecycle              | Components implemented; sustained proof pending      | Process-level restart/compaction/worker/steering scenario                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3. Reduce avoidable Auto and model overhead       | Partial fixes; mixed live results                    | Per-role overhead report and fixed-workload comparison                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4. Finish terminal onboarding and configuration   | Basic settings implemented                           | Fresh-profile first-run and restart walkthrough                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5. Improve frontend and architecture workflows    | Evidence machinery implemented                       | Independent functional, visual, and migration assessments                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6. Validate bounded self-evolution                | Controls implemented; lift unmeasured                | Frozen control/candidate outcomes and rollback proof                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7. Establish release and competitive evidence     | Partial local evidence                               | Platform gates, reproducible benchmark reports, accurate release manifest                                                                                                                                                                                                                                                                                                                                                                                       |

### Phase 0 — finish the current patch before extending the system

Read applicable `AGENTS.md`/`CLAUDE.md`, `git status --short`, `git log -8 --oneline`, and the actual diff. Earlier searches found no root instruction file; recheck instead of treating unrelated plugin instructions as repository-wide. Record a private patch snapshot and source hashes. Keep current user changes intact.

**0A. Completed plans must not waive evidence for later edits.**

Files: `packages/orchestrator/src/agent-loop.ts`, `tests/unit/orchestrator/agent-loop-settled-plan.test.ts`, `tests/integration/engine-command-evidence.test.ts`.

The working fix tracks `settledPlanAtWriteCount`. The waiver applies only when an accepted transition actually completes an evidenced plan and no subsequent write occurs. A loaded historical plan or repeated completed list cannot renew the waiver. Preserve this rule while reconciling silent-finish changes. Acceptance: checked closure finishes without needless calls; a later write, resumed old plan, failed check, or open step cannot use old evidence to claim verified completion.

**0B. Separate execution receipts, check verdicts, and fulfilled intent.**

Files: `packages/orchestrator/src/brief.ts`, `engine.ts`, `verification-command.ts`, and their ledger/command tests.

The working patch records every actually executed Bash result with `kind: "check" | "execution"`. A successful unclassified command provides an `observed` execution receipt, never automatic reproduced/verified status or automatic parent replay. Failed commands remain failures. Command normalization preserves quoted whitespace and command-list newlines.

Reconcile this with `9984109`: a real inline assertion can be an eligible check, while `echo`, printed assertion words, assertions inside comments/strings, masked nonzero exits, and unrelated checks cannot establish correctness. The new classifier is a textual regex, so add adversarial cases before accepting it as proof. Do not merely weaken the conflicting integration assertion. Preserve the broader receipt behavior: a command that really ran must not be described as “never ran.” Explicitly separate check classification from eligibility to replay a command on a parent revision; arbitrary scripts can mutate state. Use isolated, controlled verification when comparison requires re-execution.

Acceptance: valid inline/file/project checks get real verdicts; ordinary execution remains citable without promotion or replay; failed checks and subsequent edits invalidate completion; duplicate citations do not create artificial reproduction evidence. Check the full Engine path, persisted events, lessons, and final status together.

**0C. Complete Linux and plugin containment.**

Files: `crates/rune-sandbox/src/linux.rs`, `spawn.rs`, `packages/tool-registry/src/tools/plugin-tools.ts`, and background/plugin integration tests.

The earlier Linux test could write `../outside.txt` into a writable synthetic namespace parent. This demonstrated a containment-policy defect, not a proven host filesystem escape. The working fix makes the namespace root read-only after mounting the explicitly writable workspace/temp/cache roots; uses `--unshare-all`, `--new-session`, `--cap-drop ALL`; and restores only network sharing when permitted.

Plugin fixes keep the plugin's own code mounted read-only, use the plugin root as cwd so relative entrypoints work, and pass a curated environment rather than all of `process.env`. Explicit declared environment values remain supported. Linux cannot enforce the advertised plugin host/port restriction today: the working TypeScript patch refuses such plugins unless the existing plugin-specific `allowUnsandboxedTools` opt-in explicitly accepts unrestricted networking. Do not silently add that opt-in or relax the shell sandbox to make tests pass. Actual per-host Linux egress enforcement is later work, not provided by bubblewrap alone.

First fix test binary selection so explicit `RUNE_TOOLS_BINARY`/`RUNE_TOOLS_BIN` can select the freshly built artifact. Verify all of: allowed workspace/temp writes; denied parent/outside writes; plugin code outside the workspace mounted read-only; relative plugin entrypoints; dropped capabilities; separate PID namespace; absence of inherited provider secrets; allowed declared environment; network refusal and explicit opt-in behavior; foreground/background cleanup. Also investigate the separate CI report that home-installed toolchains are invisible without exposing the whole home directory.

The final image already exists as `rune-containment-audit:20260910-complete`. Its Dockerfile and tracked-source archive are under `.codex/audit-20260910/linux/`. Its recorded manifest is `sha256:778d90a8772b8df0863f688201389bab765b59c89f97166b9f7c0daac9c69a1e`.

```sh
docker run --rm --name rune-containment-handoff --privileged \
  rune-containment-audit:20260910-complete \
  > .codex/audit-20260910/linux-tests-complete.log 2>&1
```

Inspect that result, then rebuild the source snapshot from the final combined tree and rerun. The Docker Desktop outer container needed privilege for nested bubblewrap; it uses no host workspace mount or host credentials. This is an explicit test-environment qualification, not proof on an ordinary hosted Ubuntu runner. Do not copy this privileged setting into Rune's default runtime. The macOS Chromium tests are Darwin-only; they do not establish Linux browser support.

**0D. Review recovery without adding new loops.**

Reconcile `d18fde0`/`be0b468` with finish gates and headless output. Test ambiguous tool schemas, intentional JSON responses, repeated misencoded calls, read-only silence, edits followed by silence, provider failure after a tool call, and cancellation. Recovery must stay bounded, preserve the partial result and stop reason, and distinguish completed, unverified/incomplete, blocked, cancelled, and provider-failed outcomes. Keep stdout's answer contract and structured terminal events consistent.

### Phase 1 — validate the combined source and the actual installation

Start with focused tests, including the files touched by the newer commits. Build the native binary first and point tests at it explicitly after fixing the selection issue:

```sh
cargo build --locked -p rune-tools
export RUNE_TOOLS_BIN="$PWD/target/debug/rune-tools"
export RUNE_TOOLS_BINARY="$RUNE_TOOLS_BIN"
bun test tests/unit/orchestrator/agent-loop-settled-plan.test.ts \
  tests/unit/orchestrator/agent-loop-empty-completion.test.ts \
  tests/unit/orchestrator/verification-command.test.ts \
  tests/unit/orchestrator/brief-ledger.test.ts \
  tests/integration/engine-command-evidence.test.ts \
  tests/integration/background-sandbox.test.ts \
  tests/integration/plugin-tools-sandbox.test.ts </dev/null
```

After final fixes, run the following once against the same source. Capture command, exit status, source/patch hash, artifact hashes, and private log hash. Do not reuse cached Turbo results as fresh proof; repeat only when later changes or failures warrant it.

```sh
bun test tests/unit </dev/null
bun test tests/integration </dev/null
bun run typecheck --force
bun run lint --force
cargo fmt --all -- --check
cargo test --locked --workspace
cargo clippy --all-targets --all-features -- -D warnings
bun run eval
bun run eval:auto-safety --offline
git diff --check
```

For browser integration set `RUNE_TEST_PLAYWRIGHT` to an existing actual Playwright module, as described in `tests/eval/comparison/README.md`; do not count skipped browser tests as passed. Strictly typecheck edited test files that are outside the normal TypeScript projects. Run the repository format check, but scope formatting edits to owned files. Preserve the mock baseline; do not re-anchor it to conceal failures. Honor remaining CI gates and distinguish local checks from hosted CI.

Then use `bash scripts/install.sh` with its existing guards; do not set a downgrade/non-fast-forward override automatically. Inspect the guard's reason if it stops installation. Confirm the command the user actually runs in a fresh shell with `command -v rune`, `rune --version`, `rune doctor`, and `rune tools-smoke`. Record metadata and hashes again. Repeat settings save/restart at 80×24 and actual foreground/background browser checks against the installed native binary. Verify 80- and 120-column TUI behavior, long tool rows, diffs, help, picker, resize, cancellation, and piped output affected by `8c4c58f`.

Write a new dated verification manifest; retain historical manifests unchanged. Reconcile `docs/harness-status.md`, `docs/program/status.md`, and backlog claims against actual receipts. A checked-in, coherent source change is distinct from a tested installation and from a published release. Keep commits scoped and inspect their staged diff; do not auto-push or publish as a side effect of this plan.

### Phase 2 — one durable task lifecycle

Primary files: `engine.ts`, `agent-loop.ts`, `context-engine.ts`, `reliability-policy.ts`, `subagent.ts`, `subagent-result.ts`, `worker.ts`, `worker-snapshot.ts`, `worker-worktree.ts`, and their replay/budget/evidence modules.

Build on the existing session/task state rather than adding another coordinator. Establish a shared lifecycle for lead work, workers, tools, verification, compaction, and recovery: task/parent IDs, objective and user constraints, workspace revision, cancellation, budget, checkpoint, evidence, and terminal result. UI, persisted session, and headless clients must agree on that state.

Add a process-level scenario: a dependent multi-step change starts with user edits and an untracked file, dispatches a worker, accepts steering, compacts more than once, is interrupted during a tool/worker boundary, restarts, recovers the partial work, resolves or reports an ownership conflict, and completes independent acceptance checks. Use deterministic fault injection first; reserve live long runs for an agreed budget. Include tool-heavy `max_turns` and tool-then-empty-final child results so “no summary” never erases useful work or a stop reason.

Acceptance: user constraints and unfinished dependencies survive; no duplicated side effects or spend on replay; no lost edits; no orphan processes/leases; no verified status for stale evidence; the user receives a usable partial result when recovery cannot continue. Summarization failure or an overlarge fixed prompt must produce a bounded, observable outcome instead of repeated costly compaction.

### Phase 3 — make Auto efficient at equal task quality

Use `auto-mode.ts`, `auto-containment.ts`, `auto-metrics.ts`, `turn-budget.ts`, `subagent-budget.ts`, and the gateway's existing usage/reservation ledger. Measure before adding more model roles.

Break task cost and time into primary generation, review, planning, compaction, workers, retries, and evidence/finish follow-ups. Record reasons for every harness-generated follow-up, cache reads/writes, cumulative usage, reviewer queue wait, worker startup/integration, and time after the last useful edit. Unknown pricing remains unknown. Preserve the same shared ceiling across helpers, fallback models, workers, cancellation, and resume.

Remove repeated setup, duplicated prompting, and unnecessary verifier/supervisor round trips where deterministic evidence is enough. Keep risk checks and completion honesty intact. Audit just-in-time prompt injections and cache layout experimentally; do not assert savings from a code change alone. Dispatch workers only for bounded independent work where the expected benefit exceeds their context/setup/integration cost; simple edits should remain cheap.

Acceptance: no unbounded queue, retry, empty-response, or finalization loop; no budget overspend through concurrent reservations; visible progress while waiting. For later paid comparisons, target completed-task cost no greater than the baseline harness at equal acceptance quality. Treat that as a target until measured, and retain cases where it is missed.

### Phase 4 — finish first-run and settings UX

Primary files: `config-settings.ts`, `settings-command.ts`, `engine.ts`, and `bin/ui/`.

Walk through a clean temporary user profile using the installed CLI: choose a provider/model, configure an API key or supported sign-in, configure internet/search access, select a spend cap and sandbox policy, validate connection, perform a small coding task, change settings, and restart. Use one discoverable TUI settings path, masked secrets, useful validation errors, and an honest distinction between saved settings and settings active in the current session. No model call is needed merely to edit configuration. Test invalid values, conflicting sources, missing connectors, cancellation, resize, and restore.

Acceptance: the founder can complete setup without manually editing a config file; config precedence is explained; API keys never appear in transcript/logs; controls persist reliably; supported live changes take effect and restart-required changes say so. Keep the terminal calm and readable; avoid a new dashboard or subsystem for each feature.

### Phase 5 — frontend quality and planning depth

Build on `step-evidence.ts`, worker verification, the tool registry's browser integration, and `tests/eval/comparison/frontend-task.ts`. Separate functional acceptance from visual quality: responsive interactions passing is not proof of good design.

For frontend work, support the complete loop: inspect requirements/reference assets, identify the project's actual stack, implement a coherent visual direction, launch a usable local preview, inspect desktop/mobile screenshots, exercise keyboard/accessibility and state persistence, correct defects, and hand back a working result. Prefer the existing project's components and conventions. Bind browser evidence to the current preview/revision. Close the trusted external Playwright/MCP receipt gap without accepting arbitrary text as screenshot proof. Validate browser runtime dependencies and containment before an expensive model run.

For architecture work, use dependency-ordered steps with interfaces, invariants, migration strategy, and acceptance checks. Replan when evidence or user steering changes an assumption. Do not force ten planning calls for every task. Add a genuinely dependent long task whose acceptance tests can detect a late architectural inconsistency, rather than judging only the plan's prose.

Acceptance: independent functional checks plus blind visual review against a predefined rubric, with supplied references where available; preserved screenshots and defects; no fabricated preview/evidence; no arbitrary numeric design score from the generating model. Use multiple varied tasks before claiming a broad capability improvement.

### Phase 6 — prove safe, worthwhile self-evolution

Primary files: `packages/orchestrator/src/evolve/`, notebook/lesson storage, and `tests/unit/evolve/`.

Retain bounded candidate generation, frozen revision/config provenance, control cohorts, rollback, and cost accounting. Existing promotion rules require scored outcomes in each arm and confidence/cost checks; verify the exact current code rather than loosening those rules to get promotions. Failed, unpriced, mixed-revision, or interrupted outcomes cannot become positive evidence. Lessons must not weaken permissions, expand budgets, or silently alter sandbox policy.

Acceptance: promoted lessons improve held-out verified outcomes under a predefined comparison, with all learning overhead included; harmful lessons can be disabled and rolled back; non-improvement results in no promotion. Until sufficient evidence exists, describe this as controlled experimentation, not demonstrated self-improvement. Keep default learning overhead bounded and configurable.

### Phase 7 — demonstrate readiness without moving the goalposts

Only after correctness gates pass and the user has established a live-evaluation budget, use `tests/eval/comparison/README.md` and `runner.ts`. Freeze the installed Rune binary/native tools and comparator versions. Start with one diagnostic CSV pair, then a predetermined multi-run set covering CSV, dirty-worktree integration, migration, frontend, and the added long-horizon case. Set the same primary model/reasoning, task fixtures, acceptance, wall-clock limit, and estimated spend ceiling; alternate arm order and use fresh output directories. Do not keep rerunning until Rune wins.

Report completed acceptance rate, invalid-success rate, cost per completed accepted task, latency distribution, tool/worker failures, recovery, and per-role overhead. Preserve timeouts as failures even when artifacts pass; infrastructure/quota interruptions remain unscored with consumed usage retained. Record all model/helper choices and unknown prices. Separate API usage estimates from subscriptions and invoices. Do not pool free-route and frontier-route series into one score.

Run official external evaluators on pinned datasets when budget/environment permits; preserve provenance and held-out task selection. Then verify fresh installation, native containment, cleanup, and representative coding/browser tasks on each advertised OS. Existing CI push filters cover `main` and `lane/**`, not this branch; an arbitrary push does not guarantee the required jobs run. Recheck actual workflow results and billing/environment constraints before claiming green hosted CI. Never weaken a failing Windows/Linux claim into an undocumented host fallback.

Acceptance: another developer can reproduce the reported result from the documented revision and artifacts; release notes distinguish verified behavior, experiments, platform limits, and unresolved defects. Keep the existing license unless the user changes that decision. No “world's best,” universal cost parity, or production-ready assertion without evidence supporting its scope.

## Completion and continuation protocol

At the end of each working session update the table above and a short dated entry in `docs/harness-status.md` containing:

1. The concrete behavior changed and the files/commit that implement it.
2. Exact checks run, source and artifact hashes, results, skips, and evidence locations.
3. Remaining defects or uncertainty, including failed live attempts.
4. The next executable step and any actual external dependency.

Distinguish **planned**, **implemented**, **tested on this source**, **installed and smoke-tested**, and **published**. Never say “all fixed” because the unit suite passed. If provider quota ends, preserve state and continue useful offline work; do not burn retries or wait indefinitely for it to reset. The immediate deliverable is Phase 0 plus Phase 1: one reconciled, honestly verified build that the founder can trust as the basis for the remaining product work.
