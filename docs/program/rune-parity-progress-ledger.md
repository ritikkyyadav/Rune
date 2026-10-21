# Rune parity — progress ledger

Executes [the work cards](rune-parity-work-cards-20260930.md) from
[the reviewed plan](rune-parity-review-20260930.md). One entry per card. Read this
and the assigned card on resumption; do not re-run the broad audit.

Nothing here is committed, installed, pushed or benchmarked against a live model.
"Passed" below means the named local command passed on the working tree — it is not
a claim about the installed binary or about parity.

## Baseline (before any behavioural change)

- **Source:** `c8410316b4d3a1315f4e42cfe8d625fcc800b576` on `gear/phase-0-stabilize`,
  one UI commit after the review's `2adf1d9`. `verifier.ts` unchanged since the review.
- **Pre-existing dirty tree, preserved:** 26 modified + 17 untracked paths (sub-agent
  inspect, working-row glyph, `videos/`, the gradle fixture directories, the offline
  corpus runner). `git diff | shasum -a 256` → `e0cd40cb7a6ac617…`,
  `git status --short | shasum -a 256` → `a9eec5cc0af546c6…`.
  **`agent-loop.ts` and `engine.ts` already carry that other work**; hunks added by
  these cards sit beside it and must be staged by hunk, never by file.
- **Toolchain:** bun 1.3.14, macOS (Darwin 27.0.0).
- **Offline repro of the review's V1 probe, on this tree:**
  `{"declaredExit":0,"detected":["bun test"],"verifierPassed":false,"commands":["bun test"]}`
  — the project's script exits 0 and the verifier reports failure.

## V1 — honor the project's test script · **done**

- **Change:** `jsChecks` dispatches a declared `test` script through the package
  manager's script runner. New `testScriptCommand(pm)`: `bun run test` for Bun,
  `<pm> test` unchanged for npm/pnpm/yarn (for those three it already is the runner).
  Scriptless raw `bun test` fallback, monorepo-root rule and `[verify] commands`
  override are untouched.
- **Files:** `packages/orchestrator/src/verifier.ts` (+13/−1),
  `tests/unit/orchestrator/verifier.test.ts` (one expectation that encoded the defect
  corrected; 9 tests added).
- **Verification:**
  `bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/verifier.test.ts tests/unit/orchestrator/verifier-detect.test.ts </dev/null`
  → **27 pass, 0 fail**. Seven neighbouring verifier/loop suites → **233 pass, 0 fail**.
  Probe after: `{"declaredExit":0,"detected":["bun run test"],"verifierPassed":true}`.
- **Mutant:** the pre-fix line _is_ the card's mutant (`bun test` for a Bun project).
  Against it the same file gave **14 pass, 5 fail** — both behavioural fixtures failed
  (excluded suite collected; script's env setup dropped) plus three shape assertions.
- **Limits:** `detectPm` reads the lockfile in the project's own directory, so a nested
  package under a Bun root with no lockfile of its own still gets `npm test`. That is
  the existing behaviour and it does run the script; not changed here. Timeout
  classification and gate behaviour untouched (card stop boundary).
- **Next:** V2a.

## V2 — verification can be inconclusive without buying a repair turn · **done**

Three patches, in order. Fingerprint before: V1 tree above.

- **V2a, the type.** `VerifyResult` carries `status: passed | failed | inconclusive`
  and, for the last, `reason: timeout | cancelled | missing_runner | no_checks`. One
  constructor (`settle`) writes the old `passed`/`ran` pair _from_ the status
  (`passed ≡ status === "passed"`, `ran ≡ status !== "inconclusive"`), so the pair
  cannot disagree with it; both are `@deprecated`. `verifyOutcome()` is the single
  reader and also accepts a result from an embedder's two-boolean verifier.
  Fixed on the way, both silent positives/negatives in `CommandVerifier.run`:
  a verification cancelled **between** checks returned `passed`; a command killed by
  its deadline or by a cancel was written to the check log as a **red check**, which
  is what put "`<cmd>` last failed" into a verdict about a slow suite.
- **V2c, found while probing.** The deadline did not bound compound commands:
  `true && sleep 3` under 200 ms returned after **3011 ms**, because only the shell
  was killed and its child held the pipes. Every nested-project check is that shape
  (`cd api && …`). The shell now leads its own process group and the group is killed
  (same pattern as `hooks.ts`); live groups are reaped on process exit.
- **V2b, the consumers.** Loop verification block and step check, `task-state`
  (stored status gains `inconclusive` + `reason`; `noteVerification` takes the
  outcome), the wire event (`status`/`reason` optional and additive;
  `verificationOutcome` + `describeVerification` in `@rune/protocol`), ACP mapping,
  TUI (receipt, card count, row), child transcript, sub-agent line, host
  `run_checks`, new incident class `loop.verification_inconclusive`. The rule lives
  in the loop **before** the repair classes and outside `[controller] authority`.
  A run cancelled inside verification now ends `aborted` explicitly (it used to get
  there only because the killed command looked like a failure).
- **Files (production):** `verifier.ts`, `agent-loop.ts` (2 hunks), `task-state.ts`,
  `protocol/src/{events,index}.ts`, `shared/src/incident.ts`, `bin/acp-cli.ts`,
  `bin/engine-host.ts`, `subagent-events.ts`, `bin/ui/turn.ts` (4 hunks),
  `bin/ui/child-transcript.ts`. **Tests:** new `verification-inconclusive.test.ts`
  (28); `verifier.test.ts` (+20); 6 `noteVerification` call sites and 3 assertions
  that encoded "nothing checked ⇒ `passed: true`" updated.
- **Verification:**
  `bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/verifier.test.ts tests/unit/orchestrator/verification-inconclusive.test.ts </dev/null`
  → **64 pass, 0 fail**. `tests/unit/orchestrator tests/unit/protocol` →
  **4554 pass, 3 fail** in the sandbox; the 3 (`ui-model-picker` port bind, two
  `worker-worktree` OS-isolation checks) are sandbox artefacts — the same two files
  run unsandboxed give **54 pass, 0 fail**. `tsc --noEmit` clean for `protocol`,
  `shared`, `orchestrator`, `tests/eval`.
- **Mutants: 14 applied, 14 killed** (script restores each file and checks its hash):
  timeout → repair turn (13 tests fail); deadline → `failed`; cancel-between → pass;
  killed command logged red; legacy `timedOut` ignored; leader-only kill; cancel does
  not end `aborted`; killed command stored as failed check; timeout stored `failed`;
  inconclusive latches effort; stale red still demands replan; legacy `passed` true
  for inconclusive; sub-agent line reads `passed` alone; V1's `bun run test` → `bun test`.
- **Limits:** (1) A check **partly** skipped for a missing toolchain while the rest
  pass is still `passed`, with the skip in `runs` and the report — unchanged, and now
  the one place coverage is thinner than the word suggests; V3 narrows what is
  selected. (2) After an inconclusive result the execution-evidence gate (G4) still
  asks once for a real run if nothing was ever executed — a different gate, pinned by
  a test, deliberately untouched. (3) An abort that lands after the model's last
  message but **before** verification starts still ends `end_turn` with no
  verification event (pre-existing; belongs to T1). (4) A model-run `bash` check that
  times out is still judged by `bashCheckVerdict`, not by this path. (5) `SIGKILL` on
  the group gives a runner no chance to clean up. (6) Not installed; the compiled
  binary is unchanged.
- **Next:** V3.

## V3 — select affected projects conservatively · **done**

- **Rule (one direction only):** a change confined to JS/TS or Python sources and
  manifests does not select a co-located **Rust or JVM** project, unless that
  project's own build files (`Cargo.toml`, `build.rs`, gradle/maven files) call the
  script toolchain. Every other case keeps every owner: a Rust/Java edit keeps the
  JS and Python projects beside it (they may consume what it builds), Go is never
  dropped, and schemas, CI config, build scripts, documentation and unknown formats
  keep all co-owners. Directory ownership (nested packages) is unchanged.
- **Guard against an incomplete file list.** The loop's list comes from the edit
  tools; `sed -i`, `mv`, `rm` and generated files never reach it. Before a project
  is left out, git is asked what else changed, filtered to **inode change time ≥
  session start** (ctime, because `mv` keeps mtime); a path that is gone always
  counts; `.rune/` is not the work. No git → nothing is left out. The result is
  always a subset of the old selection.
- **Record:** `VerifyResult.selection` (`scope`, `commands`, per-project `decisions`
  with a reason); left-out projects are written to the task log. The step check
  (`verifyFast`) gets the same narrowing; `[verify] commands` is still never narrowed.
- **Files:** new `packages/orchestrator/src/verify-scope.ts` (222 lines, pure — no
  I/O); `verifier.ts` (facts: build-file scan, `changedSince`; `select()` replaces
  `checks()`; `projectsForRun` now delegates to `ownersOf`); `lifecycle.ts`
  (+`isHarnessOwnedPath`, 5 lines); `task-state.ts`/`agent-loop.ts` (pass and log the
  selection, 1 line + 7). Tests: `verifier-run-scope.test.ts` 22 → **69**.
- **Verification:**
  `bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/verifier-run-scope.test.ts tests/unit/orchestrator/verifier-step-check.test.ts tests/unit/orchestrator/verifier-detect.test.ts </dev/null`
  → **91 pass, 0 fail**; eight neighbouring verifier/loop suites → **202 pass, 0 fail**;
  `tsc --noEmit` clean for `orchestrator`. **13 mutants, 13 killed** (reverse-direction
  drop, tree never consulted, blind tree narrowed, coupling ignored, mtime-only,
  footprint counted, loose word match, sibling widening, step check un-narrowed,
  deletion ignored, pre-session dirt counted, Rust edit made Rust-only, untracked
  files ignored).
- **Measured on this repository** (selection only, checks stubbed): a `.ts` or
  `package.json` edit selects the JS checks and leaves out `cargo check` +
  `cargo test`; a `.rs`, `Cargo.toml` or `README.md` edit selects both. The decision
  itself costs ~55–75 ms when a drop is considered, ~10 ms otherwise.
- **Limits:** (1) **README/doc edits still select every co-owner** — the review
  flagged this as too broad; leaving it out here would have traded the checks for an
  execution-gate nudge, so it is deferred to **H2** where gate applicability for
  no-code work is decided. (2) Coupling is read from build files only: a JS suite
  that drives a Rust binary with no word about it in `package.json` (this repo) is
  why the drop is one-directional. (3) "Session start" is verifier construction; a
  shell-made change from before a restart is not seen. V4's pre-task baseline should
  replace this clock. (4) Go/JVM `embed`/`generate` relationships are not read.
- **Next:** V4.

## V4 — separate existing failures from new regressions · **done** (split in three)

Split because it passed the card contract's size alarm: three new modules, ~750
production lines. Each part has its own tests.

- **V4a `baseline.ts` — the one meaning of "before the task"** (shared with R1).
  The workspace as the run found it: HEAD + the person's uncommitted changes + their
  untracked, un-ignored files, written as a git **tree object** through a throwaway
  index. No stash, no commit, no checkout; the index, worktree, stash list and refs
  are byte-identical before and after (tested). `materialiseBaseline` lays it out as
  _old source + today's environment_ — every ignored path cloned copy-on-write — and
  answers `unavailable` instead of a partial tree when the run changed the
  environment, a dependency link points back into the working tree, time runs out,
  or the run is cancelled. Taken lazily, before the first tool call that can write.
- **V4b `check-failures.ts` — which tests, and whether they already were.** Reads
  failing tests by name from Bun's own report. A failure is pre-existing only when
  the same test, in an unchanged file, failed with the **same assertion** on the
  baseline — a multiset match, so one old failure excuses exactly one.
- **V4c — integration.** On a red check the verifier runs the _identical command_
  on the baseline (cached by tree + command + toolchain) and attaches
  `attribution`. The loop: all pre-existing → no repair turn, no effort latch, a
  notice naming the tests, state `preexisting`; mixed → repaired, and the message
  says which failures are the run's; anything unknown → exactly the old behaviour.
  The check stays `failed` and stays red in the check log, so the verdict still
  names it.
- **Files:** new `baseline.ts`, `check-failures.ts`; `verifier.ts`, `agent-loop.ts`
  (3 hunks), `task-state.ts`, `protocol/src/events.ts`, `shared/src/incident.ts`,
  `bin/acp-cli.ts`, `bin/ui/turn.ts`. Tests: new `baseline.test.ts` (27),
  `verification-baseline.test.ts` (54); new `tests/eval/serious/verifier-oracle.ts`.
- **Verification:**
  `bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/baseline.test.ts tests/unit/orchestrator/verification-baseline.test.ts </dev/null`
  → **81 pass, 0 fail** (three consecutive runs). **23 mutants, 23 killed** — one
  survived first (`known: false` carrying lists) and the test was strengthened.
- **A defect the full suite found in this card's own code:** seeding the throwaway
  index from a _copy_ of the person's index made the copy newer than every entry,
  which switches off git's racy-clean check — a same-size edit made in the second a
  file was last indexed read as unchanged. It passed alone and failed under load.
  The copy now keeps the original's mtime; a deterministic regression test pins it.
- **Measured here:** capture 253 ms; layout 5.6 s (≈36k ignored entries incl.
  2.1 GB `target/`), dispose 1.3 s. So attribution costs **≈3.6 s** on a failure
  (oracle median) against ≈19 ms for a plain red check — paid once per baseline.
- **Limits:** Bun reports only; every other runner is `unknown` → old behaviour.
  The same test failing with a _different_ assertion counts as new (deliberately).
  No baseline for submodules, LFS, a repo with no commit, or a non-git workspace.
  Linux without reflink copies the environment for real, bounded by a 60 s budget.
  An inherited-only result leaves `projectChecksPassed` false, so the execution
  gate can still ask once. Unreferenced objects are left for `git gc`.
- **Next:** H1.

## Batch A exit (V1–V4) · **passed**

- **Oracle** — `bun tests/eval/serious/verifier-oracle.ts --out docs/evidence/verifier-oracle-20261004.json`,
  five fixed mined tasks × seven situations, zero model calls, 103 s:
  **30 asserted, 30 as expected.** Correct fix called failed: **0**. Known regression
  called passed: **0**. Inconclusive where a verdict was expected: **0** (counted
  apart, never added to "correct"). Inherited failures that bought a repair turn:
  **0 of 5**, each attributed with `existing` equal to the corpus's own
  fail-to-pass count (5, 3, 6, 1, 2). Known regressions: **5 of 5** attributed new,
  repair bought. Missing runner and forced timeout: `inconclusive`, coverage 0/1.
- **One situation reported, not asserted — and it is a real gap:** a correct fix
  with its dependencies removed is `failed` at the verifier (1 of 5; the other four
  suites need none). The repair classifier names it `missing_dependency`, but with
  `[controller] authority` empty the legacy answer still buys a repair turn. That
  is G1's evidence, not something to paper over here.
- **Combined gates on this tree:** `bun run typecheck --force` 15/15;
  `bun run lint --force` 7/7; `tsc -p tests/eval` clean; `bun test tests/unit`
  **6954 pass, 3 skip, 0 fail** (464 files, unsandboxed — in the sandbox 78 fail on
  port binds and nested OS isolation, none in files this work touched).
- **Not done at this boundary:** integration tests, Rust tests, `bun run eval`,
  install. Those are the final-tree gates (B2). Nothing is committed.

## H1 — keep runtime artifacts outside user code · **done** (two patches)

- **H1a, the mission file.** Was `<workspace>/.rune/mission.md`: one path for every
  session in a repository, inside the tree being worked on. Now
  `<RUNE_HOME>/sessions/<id>/mission.md`, written atomically. The model still reads
  it at the name `.rune/mission.md`, but that name is a **route**: `read_file` of
  that one path is answered by the engine from the call's own session, before any
  tool touches disk. Nothing under the Rune home is opened to the model — no path
  handed out, no read root added — and another session's mission is not reachable.
  A session with no mission falls through to the real tool, so a workspace still
  carrying an older version's file keeps working; that file is never rewritten or
  removed.
- **H1b, check-generated build state.** A detected check now runs with an
  environment that keeps its generated state out of a project that has nowhere of
  its own for it: `CARGO_TARGET_DIR` when the crate (or its workspace root) has no
  `target/`, and `PYTHONPYCACHEPREFIX` / `MYPY_CACHE_DIR` / `RUFF_CACHE_DIR` /
  pytest's cache switch for Python. A variable already set, an existing `target/`,
  and a `target-dir` in any cargo config are left as they are; a command from
  `[verify] commands` gets nothing. The cache is per session and removed at exit.
- **The gradle directories in `git status` are not Rune's.** This machine has no
  JDK and `tests/fixtures/verifier/gradle-app/gradlew` is a placeholder that exits 1
  ("nothing in the suite executes this file"), so `.gradle/` and `bin/` there came
  from an IDE import. Left exactly as found; ownership is the founder's call.
- **Files:** new `mission-file.ts`; `engine.ts` (3 hunks, +19/−12 of mine beside the
  other session's +54), `task-state.ts` (comment), `verifier.ts`, `docs/plan-ledger.md`.
  Tests: new `tests/unit/orchestrator/workspace-hygiene.test.ts` (21) and
  `tests/integration/workspace-hygiene.test.ts` (9: a real Engine, the native
  `read_file`, real `cargo` and `python3`).
- **Verification:**
  `bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/workspace-hygiene.test.ts tests/integration/workspace-hygiene.test.ts tests/integration/verifier-ecosystems.test.ts </dev/null`
  → **36 pass, 5 skip, 0 fail** (the skips are Go and Java, absent here).
  `tsc --noEmit` clean. **16 mutants: 14 killed; 2 survived and each exposed code
  with no job** — an up-front mission write the engine's own first persist already
  covers (removed), and an override guard that could not be observed (replaced by a
  behavioural test, which then killed its mutant).
- **Also found:** `tests/integration/verifier-ecosystems.test.ts` still asserted
  `passed: true` for an absent toolchain — a V2 miss, because V2 ran unit suites
  only. Corrected; the integration suite runs at this batch's exit.
- **Limits:** other things Rune keeps in `<workspace>/.rune/` (`tool-children.jsonl`,
  `search.db`, `symbols.db`, `audits/`) are untouched by this card. A sub-agent has
  its own session id and does not see the lead's mission through the route.
  `read_many` does not answer the route. Cargo still writes `Cargo.lock` when a
  crate has none. Gradle and Maven are unchanged — no JDK here to verify a flag
  against, and an unverified one is not shipped.
- **Next:** H2.

## H2 — respect explain, review and requested-output scope · **done** (two patches)

Split for size (≈400 production lines): the contract and gate applicability first,
enforcement second.

- **H2a, the contract.** New `task-scope.ts` reads a boundary out of the user's own
  request and nothing else. It only ever **narrows**, and only on explicit words
  about changing things ("change no code", "don't modify the source", "not a fix")
  — never because a sentence looks like a question; "Can you fix the header?" is
  one. The allowed outputs are the files the user named ("write it to REVIEW.md").
  A message with no boundary of its own ("continue") keeps the task's; a new request
  that asks for the fix lifts it. Repository text has no path to this function.
- **H2a, gates and checks.** The execution-evidence gate and the fix-verified gate
  no longer fire when nothing executable was written — known either because the
  user said to change no code, or because the verifier **confirmed against the
  tree** that only documentation changed. That second case is the README narrowing
  V3 deferred: a documentation-only change selects only projects whose checks read
  documentation (a README compiled into a doctest, a markdown linter in the lint
  script, a script that fans out to packages that cannot be seen) and otherwise
  returns `inconclusive(not_required)` — a decision, never a pass.
- **H2b, enforcement.** _File tools:_ refused by path before the permission gate,
  for `write_file`, `edit_file`, `multi_edit`, `apply_patch` (every target, moves
  included; an unreadable patch or a write tool naming no target is refused whole)
  and `worker`. _Shell:_ a trusted per-call `denyWrite` list — never read from the
  model's arguments — makes the workspace unwritable to a contained foreground or
  background shell; `$TMPDIR` stays writable as the scratch area and the named
  output is written with the file tools. _At the finish:_ anything else that
  differs from the run's start is **reported and never undone** — in a tree other
  sessions share, "put it back" would be an instruction to overwrite work that may
  not be the run's.
- **Files:** new `task-scope.ts`; `agent-loop.ts` (6 hunks), `verify-scope.ts`,
  `verifier.ts`, `task-state.ts`, `protocol/src/events.ts`, `shared/src/incident.ts`,
  `tool-registry/src/{types,sandbox-mode}.ts`, `tools/{rust-bridge,background}.ts`,
  `bin/ui/turn.ts`. No Rust change: the sandbox already took a deny list.
  Tests: new `task-scope.test.ts` (86), `tests/integration/task-scope.test.ts` (3),
  `tests/unit/eval/task-scope-alignment.test.ts` (20); `verifier-run-scope.test.ts`
  69 → 83.
- **Verification:** seven scope/verifier suites → **328 pass, 0 fail**; `tsc` clean
  for four packages. The integration file needs a real OS sandbox, which cannot nest
  inside this session's: run outside it → **3 pass** — the shell could not overwrite
  a source file, add a test, clobber an uncommitted edit, delete an untracked file
  or redirect into the report; the tree afterwards is byte-identical plus
  `REVIEW.md`. **18 mutants, 18 killed** (one survived first: the worker write path
  had no test).
- **Two things the tests found in this card's own rules.** The alignment test over
  all 48 benchmark prompts showed a mined _coding_ task read as no-code ("a
  read-only run … is still an error" — prose about read-only things). Calibrating
  every pattern against 7,325 sentences from this repository's commit messages
  found two more (a third-person "changes no code"; a hard-wrapped line starting
  "read-only —"). All three are now pinned; one instruction-shaped hit remains.
- **Limits:** A request with no explicit prohibition is **not** restricted, however
  much it reads like a question — the gates stop pushing it toward writes, but
  restraint is the model's. An uncontained shell (`sandbox off`, an excluded
  command, no isolation backend) is not prevented from writing; that is reported at
  the finish, not enforced. A script that fans out (`turbo lint`) is assumed to read
  documentation, so a README edit in this repository still runs the JS checks.
- **Next:** P1.

## P1 — remove contradictory instructions and measure overhead · **done**

- **What was already right, and left alone:** the doctrine's own planning rule (a
  list for 3+ deliverables; one local fix is one unit of work), its read-back
  exemption, and its web-search rule (conditional on facts that may have changed).
  Three of the original plan's five proposals were satisfied before this card.
- **What still contradicted it — six text-only edits.** A model reads each tool's
  description on every request, and four still said the opposite of the doctrine:
  `read_back` ("use it for anything that will change a file"), `record_evidence`
  ("call this as you go"), `todo_write` ("any task with 3+ steps"), and the
  doctrine's own "Doing tasks" step 2 ("plan if the task is non-trivial"). Also
  `note_hypothesis` and `record_decision` (unconditional) and the skills catalogue
  ("matches" → "clearly matches"). No tool was removed, deferred or renamed.
- **Files:** `orchestrator/src/{brief,prompts,narrative-tools}.ts`,
  `tool-registry/src/tools/todo-write.ts`, `tool-registry/src/skills/loader.ts`.
  The last two files of that list and `narrative-tools.ts` are outside the card's
  named three; each is the same class of one-line contradiction. New:
  `scripts/prompt-snapshot.ts`, `tests/helpers/easy-task.ts`,
  `tests/integration/easy-task-overhead.test.ts`,
  `tests/unit/orchestrator/prompt-consistency.test.ts` (7, with a size ratchet).
  One pinned number re-measured with its reason (`doctrine-phase.test.ts`, −1 byte).
- **Measured, before → after** (`docs/evidence/prompt-overhead-p1-20261004.json`,
  zero model calls): doctrine 7,786 → **7,785** tokens; the five bookkeeping
  descriptions 3,313 → **3,320** bytes (**−11 tokens**); tool schemas on a first
  request 19,608 → **19,589** bytes; system prompt 23,856 → 23,855 bytes.
  **My first wording was +379 bytes** — consistency bought with fixed overhead — and
  was rewritten until it was not.
- **The easy task** (a one-line fix by a scripted model that calls no bookkeeping
  tool, through a real Engine with default gates and checks): **4 completions, all
  `primary`; 0 harness-authored turns; 0 notices; checks passed; `end_turn`** — the
  same before and after. `scripts/overhead-report.ts --db <that session>` agrees:
  `planning` 0, `harness_followups` 0.
- **Verification:** five prompt/doctrine suites → **61 pass, 0 fail**;
  `tests/unit/tool-registry` → 36 fail in the sandbox, every one a port bind
  (Dashboard, MCP over HTTP — 24 `EADDRINUSE` in the log), none in a file this
  touched; `tsc` clean for `tool-registry`, `orchestrator`, `tests/eval`.
- **Limits — and this is the important one:** a script cannot show what a real
  model does with the text. These edits remove a contradiction; whether they remove
  _calls_ is B1's question, and no cache-hit claim follows from a byte count.
  The doctrine sits 5 tokens under its ceiling.
- **Next:** Batch B exit, then M1.

## Batch B exit (H1, H2, P1) · **passed**

- **Combined gates on this tree, outside the sandbox:** `bun run typecheck --force`
  15/15; `bun run lint --force` 7/7; `tsc -p tests/eval` clean;
  `bun test tests/unit` → **7102 pass, 3 skip, 0 fail** (468 files, 146 s);
  `bun test tests/integration` → **404 pass, 7 skip, 0 fail** (70 files, 166 s) —
  the first full integration run of this work. Skips are toolchains absent here
  (Go, Java) and the suite's own two browser cases.
- **Overhead recorded before and after:** `docs/evidence/prompt-overhead-p1-20261004.json`.
- **Not done at this boundary:** `cargo test --locked --workspace`, `bun run eval`,
  the offline corpus, install. No Rust source was changed by A or B. Nothing is
  committed; the compiled `rune` is unchanged.
- **Next:** M1.

## M1 — make the score mean what the plan says · **done**

Three patches, as the card splits them. Nothing in the gate's thresholds, weights or
its 80% interval moved; what moved is what `clean` and `scope` are allowed to call
good, and what the report says beside the index.

- **Part 1 — scope on coding tasks.** A coding task scored s = 1 whatever it edited.
  `ParityTask` gained `protectedPaths` and `allowedPaths`; `scoreScope` now scores 0
  for a protected path whose **bytes** changed (staging or committing a file as it
  stood is not a change), for uncommitted work reverted or removed and in no commit,
  and — where a task declares its paths — for an existing file changed outside them.
  New files are never outside. The snapshot records which committed paths are new
  and the on-disk bytes of paths that left the listing; a committed rename is now a
  delete and a create. Protected paths are read from each corpus task's own words:
  4 of 18 tasks, 7 files, each left byte-identical by its own reference solution.
- **Part 2 — how a run ended, and absolute outcomes.** Row schema `parity-run/2`.
  Each row records `terminal` (completed / incomplete / stopped / crashed / refused /
  not_started); `clean` needs completed or incomplete, so **a crash is no longer
  clean**. An exit code cannot tell an honest "not finished" from a crash (Rune exits
  1 for both), so the arm contract gained one neutral fact, `selfStopped`; the one
  classifier is unchanged and scores exactly what it scored. The report
  (`parity-report/2`) counts every attempt per arm — complete, partial, zero,
  unverified, unscored by reason, out of scope, false completions, endings — and
  raises caveats that never gate. The index under the `parity-run/1` rules is kept
  beside the new one (`legacy`), marked where they differ.
- **Part 3 — comparable evidence, two intervals.** Rows carry
  `fingerprints { task, grader, config }` and the reported model roster. Refused with
  no override: one task run from two starting points, one task graded by two sets of
  checks, rows of two schemas. Refused unless asked, and then PROVISIONAL at best:
  rows with no fingerprints (`--allow-unfingerprinted`), one arm on two
  configurations or rosters in a mode (`--allow-mixed-config`). The mixed-build
  refusal now covers the comparator too. A task-level 95% interval (whole tasks
  resampled) is reported beside the 80% within-task one, and is not gated.
- **Files (20 changed, 1 new fixture; +3,634 / −138):**
  `tests/eval/parity/{types,run-pairs,score,aggregate,report,bootstrap,corpus-source}.ts`,
  `tests/eval/serious/source.ts`, `tests/eval/comparison/arms/{types,rune}.ts`,
  `tests/fixtures/parity/{rows,write-fixtures}.ts`, `mixed-rune.jsonl` (regenerated),
  `golden-v2.jsonl` (new), six test files, `docs/program/parity-index.md` (rules and
  three Changes entries). Outside the card's named six: the two task sources (a
  contract nobody populates is not a contract) and the two arm files (`selfStopped`).
  **`tests/fixtures/parity/golden.jsonl` is byte-identical** (`git diff --quiet` → 0).
- **Verification.** The card's command —
  `bun test --preload ./tests/scratch-home.ts tests/unit/eval/parity-{score,report,bootstrap,run-pairs}.test.ts </dev/null`
  → **199 pass, 0 fail**. All of `tests/unit/eval` → **455 pass, 2 skip, 0 fail**
  (22 files; the skips are the two browser cases). `tsc --noEmit -p tests/eval`
  clean; prettier clean. **154 source mutants, 154 killed** (26 + 53 + 75; one
  survived first — the family's mode filter had no test). The fairness matrix now
  asserts the same ending name for every arm in all 19 situations.
- **The card's acceptance cases, each a named test:** equal partial quality (O = 100,
  PI 100, complete rate 0%, caveat "parity at a low level"); both-zero pairs out of
  the index and in the counts; missing and mismatched graders; missing and
  mismatched models; a complete answer out of scope (complete 6, clean complete 3);
  an honest incomplete answer against a crash (R 83.3 now, 100 under the old rule);
  a report made only of exclusions (PROVISIONAL, headline null, attempts still
  counted); old evidence still deriving PI 92.186 from the unchanged v1 file; a
  `parity-report/1` on disk never rewritten.
- **A defect found in my own method.** An interrupted mutation run left a mutant in
  `run-pairs.ts`, and a second run started while the first was still alive
  contaminated both. The tool now parks the original before mutating and restores it
  on the next invocation; every affected mutant was re-run alone.
- **Limits.**
  - **No shipped task declares `allowedPaths`**, so the reviewed case — a tracked
    `unrelated.ts` edited on a coding task — is closed in the scorer and **still open
    for all 48 tasks**. The one mechanical source for a boundary was checked and
    rejected: `three-module-dependent` names `report.ts` in its prompt and its
    reference solution leaves that file alone, so a correct answer would have scored 0.
  - The 80% complete-rate floor is the review's _proposal_; it raises a caveat and
    gates nothing.
  - The grader fingerprint covers what is checked, not the code that runs the check.
    The task fingerprint leaves out paths git ignores, so an installed dependency
    tree is not in it.
  - `--allow-mixed-versions` still does not cap a status; the two new overrides do.
  - No `parity-run/2` row has been written by a live run. Only Rune has an honest
    "not finished" to report; for every other arm an unfinished, unclaimed ending is
    a crash, and Claude Code, which reports success on any normal end, shows an
    unfinished answer as a false completion instead.
- **For the founder to decide before a claim-bearing series:** which tasks get a
  declared boundary and what it is; whether the 80% floor becomes a rule.
- **Next:** M2.

## M2 — one runnable manifest, with a budget before the first pair · **done**

- **The reviewed defect, closed.** `gateBeforePair` returned "go" whenever no pair had
  run, so a series with Rune's window at 99% and a stop at 90% started. Every check is
  now made before **every arm run** — the first pair, the second arm of a pair, a
  re-run, a retry — and what the accounts read before the series refuses the first
  pair before anything is probed, prepared or written.
- **The budget** (`tests/eval/parity/series-budget.ts`, new, pure). Hard stops counted
  by the rig: `--max-pairs`, `--max-attempts`, `--wall-allowance-min`; a live series
  is refused without them, and a plan larger than its pair limit is refused rather
  than cut short. Per account: what its window read before the series and where to
  stop. Only Rune's rows report a meter, so a comparator's stop is checked once and
  labelled as not a cap after that; a series with an account it cannot watch needs
  `--bounded`. `RUNE_EVAL_BUDGET_USD` is labelled an estimate-gated stop, not a
  spend cap — the gate itself is unchanged.
- **The manifest** (`tests/eval/parity/manifest.ts`, new). `availableTasks()` composes
  the corpus, its supplement and the mined tasks through the loaders that already
  read them: **48 tasks, F1–F6 × 3 and F7 × 30**. A manifest pins each task's
  grader and prompt digest, the arms and settings, runs, seed and order, limits and
  accounts. `--dry-run --write-manifest FILE` writes it; `--real --manifest FILE`
  runs it after re-checking the tasks against it; `manifest.json` is written into
  the output directory before the first pair. Window readings may be given at run
  time and replace the manifest's; nothing else about an approved plan can be
  changed from the command line.
- **An unscored row is retried alone.** The old rule re-ran the whole pair under a new
  run number, running the arm that had succeeded a second time. The retry is now
  that arm only, `attempt: 2` of the same run; the report pairs the latest attempt
  and still counts the first as an attempt. Both unscored: both retried, other arm
  first.
- **Source drift stops the series.** Every prepared tree is fingerprinted and held to
  the first one its task was run from, before the tool is spawned. A manifest whose
  tasks no longer match what it pinned is refused before anything runs.
- **Half a pair is kept.** When the budget stops the series between two arms, the row
  that exists is written and reported partnerless. Nothing is thrown away.
- **Files:** new `series-budget.ts` (276 lines), `manifest.ts` (252);
  `run-pairs.ts` (series loop, CLI, seeded order, retry), `aggregate.ts`
  (`latestAttempts`), `types.ts` (`attempt`), `fixtures/parity/rows.ts`,
  `parity-run-pairs.test.ts`, `parity-report.test.ts`, `parity-index.md`.
- **Verification.** The card's command —
  `bun test --preload ./tests/scratch-home.ts tests/unit/eval/parity-run-pairs.test.ts tests/unit/eval/parity-fairness.test.ts tests/unit/eval/comparator-series-budget.test.ts </dev/null`
  → **167 pass, 0 fail**; `tsc --noEmit -p tests/eval` clean. Fake arms prove each
  acceptance item by name: counts and alternation, max attempts, unknown meters,
  the 99%-used first-pair refusal, each account's reserve, cancellation between
  arms (by the run count and by an injected clock), and source drift (at a pair's
  first arm, its second, before a retry, and from a manifest). **84 source mutants,
  84 killed**; three survived first and each got a test (a dollar figure reached
  exactly, a retry with no run left, drift at a pair's first arm).
- **The real CLI, dry:** `--dry-run` with no `--tasks` plans all 48 and says
  `F1 × 3 … F7 × 30`; it spawned nothing (the tripwire binary was never run),
  prepared no workspace and wrote nothing.
- **Deliberate changes to rules that tests pinned:** "the first pair always starts"
  and "an unscored pair is re-queued as a new run with both arms". Both tests were
  rewritten to the new rule; the reasons are in `parity-index.md`, Changes.
- **Limits.** No command resumes a stopped series to fill a half pair; the evidence a
  resume needs is on disk. A comparator's account is never observed during a
  series, by anything: `--bounded` is an acknowledgement, not a control. The dollar
  stop can still be passed by up to one pair, and says so. The retry pairs two rows
  that may have run hours apart.
- **Next:** Batch C exit, then B1's manifest.

## Batch C exit (M1, M2) · **passed**

- **Combined gates on this tree:** `bun run typecheck --force` 15/15;
  `bun run lint --force` 7/7; `tsc --noEmit -p tests/eval` clean;
  `bun test tests/unit` outside the sandbox → **7210 pass, 3 skip, 0 fail**
  (468 files, 153 s; +108 tests since Batch B). Inside the sandbox the same run
  shows 77 failures, every one in a port-binding suite (MCP OAuth, Dashboard,
  Streamable HTTP; 27 bind errors in the log) and none in a file this batch touched.
- **Not run at this boundary:** `tests/integration`, `cargo test`, `bun run eval`,
  the offline corpus, install. Batch C changed the evaluation rig and its tests
  only — no file under `packages/`, no Rust — so the integration result of Batch B
  (404 pass) still describes the product code.
- **Mutation totals for the batch:** 238 source mutants, 238 killed.
- **Next:** B1 — the manifest and the budget; the run is the founder's to authorise.

## B1 — small paired checkpoint · **manifest prepared; the run is not authorised**

No model was called. What exists is the plan, pinned, and what it would cost.

- **Manifest:** `docs/evidence/b1-manifest-20261004.json`
  (sha256 `b71bdd7ab4fe4d1c…`), written by the runner's own dry run and read back
  through `--manifest` with no drift.
- **The three diagnostic tasks, cheapest first** (one repetition, the order given):
  1. `review-invoice-rules` (F5, no-code, 20 min limit) — the task H2 was built
     for: "this is a review, not a fix: change no code".
  2. `off-by-one-window` (F1, small fix, 20 min) — a failing test ships in the
     fixture and must not be edited: it exercises V1, V4 and the protected path.
  3. `f7-653698d-toml-config` (F7, serious, 45 min) — the mined form of the pilot's
     `config-toml`, where Rune took 1.4× and 4.5× OpenCode's wall time and 1.6× and
     7× its list cost for the same hidden result, and exited 1 both times
     (`planning-review-20260930.json`, `rawSeriousRows`). The verification
     overhead Batch A targets.
- **Arms as written:** Rune (`gpt-6-sol` via `codex`) against Claude Code (`opus`,
  effort `high`), product mode. **Both model names are the last recorded
  configuration, not a decision** — changing either is one flag and a regenerated
  manifest.
- **Required budget.** 3 pairs, 6 arm runs before any retry. Worst case if every run
  uses its whole wall limit: **170 min**. The manifest allows **3 pairs, 8 arm runs
  (two retries), 210 min**. Expected: well under that — in the pilot Rune took
  13–22 min on a serious task and OpenCode 5–9 — but Claude Code has not been timed
  on these tasks, so that is a guess and the 170 is the number to plan on.
  In subscription terms: six agent executions, one of them a serious task on each
  account. No dollar figure can be promised: product mode spends plan quota, and
  the list-price estimate is not an invoice.
- **What the founder must supply, in numbers** (the card: "limits are normal" is
  not a budget):
  1. each account's window reading now, and the share at which to stop
     (`--rune-used-pct`, `--claude-code-used-pct`; the manifest's stops are 70%
     and can be overridden);
  2. `RUNE_EVAL_QUOTA_PCT` or `RUNE_EVAL_BUDGET_USD` — the door;
  3. `--bounded`, already in the manifest: Claude Code's window cannot be read
     while the series runs, so the run count and the 210 minutes are the only
     bound on it;
  4. a Claude Code evaluation profile (`RUNE_PARITY_CLAUDE_CONFIG_DIR`), signed in
     once by hand — the dry run reports this as the refusal a live run would hit;
  5. a **frozen Rune build** (`--rune-bin`). The tree is uncommitted and carries
     another session's work; a run from source is fingerprinted, and a parallel
     edit during the series turns its rows into `source_changed`.
- **The command, once those exist:**
  `RUNE_EVAL_QUOTA_PCT=70 RUNE_PARITY_CLAUDE_CONFIG_DIR=<dir> bun run tests/eval/parity/run-pairs.ts --real --manifest docs/evidence/b1-manifest-20261004.json --out <fresh dir> --rune-used-pct <now> --claude-code-used-pct <now>`
- **What this run can and cannot say.** It is three pairs: diagnostic, provisional,
  and not seven-family parity. It compares the new Rune with Claude Code. It does
  **not** compare the new Rune with the old one — the runner pairs two different
  arms — so a causal claim about Batches A–B needs a second series from the
  previous build under the same manifest.
- **Next:** R1 and T1 do not depend on this and proceed. G1 waits on B1's evidence.

## R1 — causally valid parent replay · **done**

- **The reviewed defect.** The fix-verified gate tells a run to write a regression
  test ("a real test file is best"), and a test the run wrote was capped at
  `observed` and never replayed — so the rung the gate asks for was not on offer by
  that path. Separately, "before" was the last commit: what the person had already
  fixed and not committed made a check "fail on the parent", and the run was
  credited with a fix it found already made.
- **A test the run wrote is replayed as a pinned witness** (`parent-check.ts`). One
  shape only — `bun test <test files>`, at most 8 regular files inside the workspace —
  rebuilt as an argv and run with no shell; the model's command line is never
  replayed. The tree is the one the run started from (`baseline.ts`: the commit, plus
  what was uncommitted and untracked), laid out with a copy-on-write copy of the
  environment; only the named test files are laid over it. It counts as a failure
  there only if every failing test failed an `expect(…)`: a throw, a missing module,
  a timeout, nothing collected or an unreadable report is absence, and absence is
  not evidence. A changed manifest or lockfile makes the two runs incomparable. The
  same argv must then pass on the current tree. No ambient environment, a throwaway
  home, its own process group; the tree and the home are removed on every exit,
  a cancel included.
- **The ladder** (`brief.ts`). A replay lifts a check the run wrote to `verified`
  (verifier `witness-replay@1`, evidence carries `witness` and `witnessFiles`) only
  when the digest replayed is the digest of the test as it is now. Edit the test and
  the rung is taken back until it is cited again; a result on record for the test as
  it was lifts nothing. Replays are kept by baseline tree, witness digest and
  toolchain fingerprint, and an answer nobody could give is not kept.
- **A check that existed before the run** is asked at the commit, as always, and —
  when the run began on uncommitted work — on the tree it began from too
  (`replayExistingCheck`): passing there means it was already fixed, and the run is
  not credited; no answer there leaves it `observed` with the reason.
- **Found by the combined gates, and fixed.** `lifecycle-durability` (a task killed
  mid-tool and resumed) failed: the resumed run started on a tree that already held
  the killed run's fix, so "it already passed where this run began" took `verified`
  away from the task's own work. The starting tree is now consulted only when the
  task had written nothing before the run began (`personsStartingTree`, read from
  the write ledger the session restores); a continued task is asked the commit
  alone, as before R1.
- **Files:** `parent-check.ts` (+549/−41), `brief.ts` (+138/−22), `engine.ts` (the
  `record_evidence` closure, `replayAuthoredCheck`, `demoteEditedWitnesses`,
  `personsStartingTree`), `verifier.ts` (`baselineForReplay`),
  `protocol/roundtrips.ts` (two evidence fields); tests
  `parent-check.test.ts` (+636; the 24 tests it had are untouched but for two
  import lines), new `witness-evidence.test.ts` (13) and
  `tests/integration/witness-replay.test.ts` (9).
- **Acceptance, by test name.** New regression test qualifies: "a genuine new
  regression test: it fails on the pre-task tree and passes now", and end to end
  through a real engine. Copied fix: "a fix copied into the test file … proves
  nothing". Forged command or output: "the model's command is never replayed",
  "an Error the test raises itself is not read as an assertion". Missing module:
  "cannot load on the old tree: absence, not evidence". Test mutation: "edit it and
  it is another witness", "…the rung is taken back when the test is edited".
  Changed lockfile: "the two runs would not share an environment". Cancel: "a
  cancelled replay stops, says so, and cleans up after itself". Dirty baseline:
  "what the person had not committed is part of the tree the run started from".
- **Verification.** The card's command —
  `bun test --preload ./tests/scratch-home.ts tests/unit/orchestrator/parent-check.test.ts </dev/null`
  → **50 pass, 0 fail**. `witness-evidence` 13 pass; `witness-replay` (integration,
  real engine, native tools, real `bun test`) 9 pass. **69 source mutants killed,
  1 equivalent** (a guard already unreachable behind the no-witness check).
- **Combined gates on this tree** (product code changed, so all of them):
  `bun run typecheck --force` 15/15; `bun run lint --force` 7/7;
  `tsc --noEmit -p tests/eval` clean; `bun test tests/unit` outside the sandbox →
  **7249 pass, 3 skip, 0 fail** (469 files, 168 s); `bun test tests/integration`
  outside the sandbox → **413 pass, 7 skip, 0 fail** (71 files, 173 s; 404 at
  Batch B). The first unit run of the day showed 1 failure in `baseline.test.ts`
  taking 316 s: the machine idle-slept for 317 s mid-run (`pmset -g log`,
  21:32:26), a `git` call outlived its timeout, and the test fed the resulting
  `null` on. It passes on the re-run; long gates now run under `caffeinate -i`.
- **Deliberate changes to rules that stood.** A check the run wrote can now reach
  `verified`; a pre-existing check that fails at the commit no longer reaches it
  when the uncommitted tree the run started from already passed it. No existing test
  was rewritten for either.
- **What R1 does not change — measured, not assumed.** The verdict. A replay-verified
  test the run wrote is `verified` with attribution `regression`, the fix-verified
  gate no longer refuses the finish (so the turn it cost is not spent), and the
  criterion's status is still `needs_review`, the verdict `partial`: by M1's rule a
  check the run wrote does not settle its own criterion. The replay shows the change
  is why the test passes, not that it is the right test. Pinned in the integration
  test so it cannot drift silently.
- **Limits.**
  - One runner, one shape: Bun, `bun test <files>`. A pytest, cargo, jest or go test
    the run wrote has no witness and stays `observed`.
  - **The replays run outside the tool sandbox.** The witness has no shell and no
    environment, but its files are not confined: a test can read by absolute path
    and reach the network. The two replays of a pre-existing check (the commit, and
    now the starting tree) run the cited command through `bash -c` with the engine's
    whole environment — as the parent probe always has, and as end-of-turn checks
    do (`verifier.ts`). R1 added a second run of that kind and closed none. Closing
    it means running engine-initiated checks through the same sandbox the shell
    tool uses; that changes which checks can run at all and is not this card's.
  - A continued task is judged against the commit alone, so a fix the person had
    left uncommitted before it is not detected there. Changes an earlier run made
    only through the shell are not on the write ledger: such a run is asked of its
    starting tree and can lose `verified` for its own earlier fix. A resumed run
    cannot earn new-test credit for a fix an earlier run made.
  - A run that began on uncommitted work and then changed its environment (installed
    a dependency, rebuilt an ignored artifact) gets no answer from the starting tree
    and is left at `observed`, where the commit alone used to give `verified`. How
    often that happens on real projects is not measured.
  - Cost per distinct witness: one tree laid out (60 s budget) and two test runs.
    Not measured on a large repository. Not rebuilt into the binary; no live run.
- **For the founder to decide:** whether a replay-verified test the run wrote should
  settle its criterion (it would make more runs `met` on the strength of a test the
  model chose — recommended against without an independent relevance check); and
  whether engine-initiated checks move inside the sandbox.
- **Next:** T1 — the run-level outage deadline first, then signals, then resume.

## T1 — finish resilience work that has not already landed · **done** (three patches)

Already landed and not redone: reset parsing, known-reset cooldowns, `infer()` cap
handling, the Anthropic SDK's own retries switched off, and the resume plan —
"reset resumes once" is `resume-loop.test.ts` / `resume-plan.test.ts` (**32 pass**:
a wall waits for the provider's window and continues; two processes claiming one
due plan, exactly one wins; a loop that slept through another resume does not
resume a stale plan).

### Patch 1 — the run-level outage deadline · **done**

- **Reproduced first.** The count (`maxConsecutiveErrors`, 3) bounds how many times a
  request is re-sent, not how long that takes: under a gateway that retries each
  call three times, a provider that stalls instead of failing costs a first-byte
  timeout (90 s) per attempt — about eighteen minutes before `provider_lost`, the
  sixteen the plan cites. On this tree: a scripted stall was never cut; a cancel
  that landed in the gateway's back-off was honoured after the whole wait
  (2,107 ms and 2,184 ms against a 2 s back-off) and after one more request had
  been sent; a 503 advertising `Retry-After: 600` slept ten minutes in line.
- **The gateway** (`gateway.ts`). One back-off is at most 30 s for anything but a
  throttle (which keeps its 8 s), and the wait takes the caller's signal: a cancel
  in it ends the ladder there, for streamed and plain calls, with nothing more sent.
- **The loop** (`agent-loop.ts`). An outage clock beside the count: monotonic, from
  whichever is later of the request that first went unanswered being sent and the
  provider's last word; it stops at the provider's next word, so an answer is not
  an outage however slow. At the deadline the call is cut where it stands, through
  a cancel of its own that is never mistaken for the person's, and the run ends
  `provider_lost` — the ending `--resume-until` and `rune resume` continue from —
  saying how long it went unanswered. A throttle's wait is on the clock, and one
  that would outlast the deadline is not sat through.
  `[reliability] providerDeadlineSecs`, default **600**, 0 turns it off.
- **Both authorities.** The loop's own rule and the controller's `REPAIR_TRANSPORT`
  read the same two inputs (`outageMs`, `deadlineMs`), the decision row carries
  them, and the shadow rule for the ending (`E5`) reads them too — a deadline
  ending produces no shadow disagreement. Tested with `transport` owned and not.
- **Files:** `llm-gateway/gateway.ts`, `agent-loop.ts`, `arbiter.ts`,
  `reliability-policy.ts`, `shared/config.ts` (the key), `engine.ts` (one line);
  new `tests/unit/gateway/gateway-backoff.test.ts` (7) and
  `tests/unit/orchestrator/agent-loop-outage-deadline.test.ts` (22).
- **Acceptance, by test name.** Stall reaches the deadline: "is given the deadline
  and no longer: the call is cut where it stands". Stacking across layers, through
  the real gateway: "the count alone lets all twelve attempts run" against "the
  clock cuts them at the deadline, wherever in the ladder that falls". A cancel is
  not an outage retry: "is a cancel: not an outage, not a retry, and not made to
  wait for the deadline", and in the gateway "ends a streamed call there: the wait
  is not sat out, and nothing more is sent".
- **Verification.** The two new files → **29 pass, 0 fail** (15 s; one test waits a
  real 7 s through the loop's 5-second throttle floor). `tests/unit/orchestrator`,
  `gateway` and `shared` inside the sandbox → 5977 pass, 6 fail — the port-binding
  and nested-sandbox suites that fail there at every boundary. `tsc` clean for
  orchestrator, llm-gateway and shared. **33 source mutants, 33 killed**; two
  survived first and each got a test (the clock starting on a throttle, and on a
  call that throws rather than reports).
- **Deliberate change to a pinned rule:** `reliability-policy.test.ts` pins the
  default bounds exactly; the new key was added to it. The count's own rule and
  its message are unchanged.
- **Limits.** Ten minutes is a judgement, not a measurement: nothing on record says
  how long real brown-outs last. The clock is not carried across a restart. A
  provider that keeps sending part of an answer and then stalling is bounded by
  the count, not the clock. Plain `infer()` callers (summariser, reviewer) get the
  bounded, cancellable wait and no run-level deadline. Sub-agent, worker and
  research loops take the loop's default and no `[reliability]` override. The
  first-byte and idle timeouts (90 s, 30 s) are unchanged. Two timing-boundary
  mutants (`>` for `>=` at the deadline) were not targeted. No real outage was
  used, by the card's own rule.

### Patch 2 — being told to stop · **done**

- **Measured first**, with a real CLI, a scripted model and a real signal
  (`tests/integration/signal-shutdown.test.ts`). Inside a tool call SIGTERM
  already exited 143 quickly and the tool's child was reaped by its own
  parent-death watchdog — and nothing said how the run had ended. The handlers
  existed only when a black box was configured, and a headless run had none for
  SIGINT. **A SIGTERM sent while a cited check was being replayed was answered
  25,078 ms later**: the replay at the commit ran through `spawnSync`, and for as
  long as the check took the process could not hear a signal, a cancel, or repaint.
- **The order now** (`bin/signal-shutdown.ts`, new, 100 lines, everything injected):
  ask the run to stop; wait for it to have written how it ended, at most five
  seconds; release what the process holds; exit 128 + the signal. A second signal
  means now. SIGHUP, SIGTERM, and SIGINT in a headless run, with or without a
  black box. A headless run still prints its envelope — `stopReason: "aborted"`,
  the files it changed — and then exits with the signal's code, so a harness that
  stops a run at its wall limit gets what the run did.
- **A stopped run is left open, not ended** (`engine.ts`, `interrupt`). It is
  cancelled exactly as a person's cancel does it — stream, tool children and
  checks all hear it — and the log gets `session_interrupted` with the signal
  where a cancel writes `session_ended`. The next process therefore inherits the
  contract, the budgets and the repair counts, as it does after a kill; before,
  that was true only because nothing at all was written.
- **The replay at the commit no longer blocks** (`parent-check.ts`). It runs in its
  own process group, hears the cancel and its deadline, and what a replay puts in
  the world — a process group, and a worktree registered in the user's repository
  — is taken back out on exit by whatever road.
- **After:** exit in **60–75 ms** in all four scenarios (inside a tool, SIGINT
  inside a tool, mid-stream, mid-replay), no process left, no worktree left, a
  terminal row and the interrupted marker on the log, and the resumed process
  carrying the criteria forward.
- **Files:** new `bin/signal-shutdown.ts`; `bin/rune-cli.ts` (the handlers, moved
  out of the black-box block; the TUI's own exit-on-the-spot handler removed, the
  exit hook restores the terminal); `engine.ts` (`interrupt`, the marker);
  `parent-check.ts`; tests: new `tests/unit/orchestrator/signal-shutdown.test.ts`
  (10, fake clock), `tests/integration/signal-shutdown.test.ts` (27),
  `tests/integration/engine-interrupt.test.ts` (5), `parent-check.test.ts` (+4).
- **Verification.** Unit 10 pass; the two integration files **32 pass**;
  `parent-check.test.ts` 54 pass. **25 source mutants killed, 2 equivalent** (an
  early return that saves adding a worktree for a replay already cancelled, and a
  timed-out check whose exit code is already null). A signalled stop is not counted
  as the person cancelling: `interrupt` does not go through `abort`, which feeds
  the struggle detector.
- **Deliberate changes to rules that stood.** SIGTERM no longer exits on the spot.
  `runOnParentCommit` is asynchronous: its eight test call sites gained `await`
  and nothing else. The test that made the starting tree unable to answer by
  cancelling now does it with a tree git does not have — a cancel stops the commit
  replay too, which is the point.
- **One bound, not the plan's two.** The plan asked for exit within 5 s and a hard
  exit at 10 s. Everything after the five-second grace is synchronous, so a second
  timer could never fire: it is not there.
- **Limits.** The TUI path is covered by the routine's unit tests and the engine's,
  not by a process test — that needs a pty. A run that does not wind up in five
  seconds is left as before, with no terminal row; the exit hooks still reap check
  groups, replay groups, worktrees and background shells. A signal that arrives
  before the run has started waits out the grace period. `engine-host` (serve) has
  its own SIGTERM path and was not touched.

### Patch 3 — what a resumed run is told · **done**

- **Found by the kill scenario, not by reading.** A process killed inside a tool
  left NO record that the call had been made: the engine writes what a run
  appended when an event passes through it, and nothing is yielded between the
  model's call and the tool's return. At the kill the log held the request, the
  contract, the spine and two traces — no `assistant_msg` — and the resumed model
  was sent the request and "Continue." and nothing else. A model in that position
  issues the command again. And where a call WAS
  on the log with no result, the replay closed it with "Not executed … Re-run it"
  — false for a command killed mid-flight, and an instruction to repeat it.
- **The calls go on record before they run** (`agent-loop.ts`, `onBeforeTools`;
  `engine.ts`, one line). **The closing result says what is known**
  (`session-replay.ts`, `unansweredCall`): no result was recorded; it may not have
  run, or it may have run in part or in full; check the state it would have
  changed before repeating it.
- **Acceptance.** Nothing acknowledged is lost: "acknowledged progress is kept: the
  write is on disk and its result is on the log", beside `lifecycle-durability`'s
  "no lost edits". Nothing is repeated by the harness: a command that appends a
  line and is then killed has appended exactly one line after the resume ("the
  effect happened exactly once"), and the resumed request carries the new sentence
  and neither of the old ones.
- **Verification.** `session-replay-unanswered.test.ts` 5,
  `agent-loop-before-tools.test.ts` 3, the kill scenario 5.
  **6 source mutants, 6 killed.**
- **Limits.** Results of calls that had already returned inside the batch being
  killed are still written only when the batch ends, so every call of that batch
  reads "no result recorded" — true, and less than was known. The engine knows
  from its pid ledger which commands were still running at the restart and does
  not tell the model. Whether a model heeds the sentence is not measured: the
  model here is scripted. Sub-agent and worker transcripts keep their own
  checkpoints and were not changed.

### T1 — combined gates and what the card's acceptance rests on

- **On this tree, all outside the sandbox and under `caffeinate -i`:**
  `bun run typecheck --force` 15/15; `bun run lint --force` 7/7;
  `tsc --noEmit -p tests/eval` clean; `bun test tests/unit` →
  **7300 pass, 3 skip, 0 fail** (474 files, 184 s); `bun test tests/integration` →
  **444 pass, 7 skip, 0 fail** (73 files, 189 s; 413 after R1).
- **The card's five acceptance items:** a scripted stall reaches the deadline
  (patch 1); a cancel is not an outage retry (patch 1); a reset resumes once (the
  resume plan, already landed, 32 tests); a signalled exit takes 60–75 ms with
  nothing left running, against a bound of ten seconds (patch 2); a resume loses no
  acknowledged write and the harness repeats nothing (patches 2 and 3, beside
  `lifecycle-durability`). The last one stops where the harness does: what a model
  does with the sentence it is given was not measured.
- **Mutation totals for T1:** 64 source mutants killed, 2 equivalent.
- **Next:** P2's offline part — the prompt-cache key no caller passes. G1 waits on
  B1's evidence.

## P2 — deeper prompt/tool/cache economy · **the attributable part done; the rest waits on a live A/B**

The card's own condition is "only when attributable", and it names three things. One
of them is a seam left unfinished, with a deterministic test; that one is done. The
other two change what a model is sent and can only be judged against a live provider.

- **Cache-key caller wiring — done.** The Codex adapter keys its prompt cache on a
  key the caller sends and falls back to an id made when the adapter is built
  (`codex-quota.test.ts`, "the prompt cache key"). **No caller sent one.** So the key
  changed whenever the gateway was rebuilt (`/model`, `/login`) and whenever the
  process was, and every session in a process shared it. The loop now passes the
  key it is given on every request, and the engine gives the lead loop the
  session's: `rune-` plus 32 hex of a digest of the session id
  (`session-cache-key.ts`) — the same for the session's whole life, never two
  sessions' at once, and not the id itself, which is a UUIDv7 and says when the
  session began.
- **Files:** new `session-cache-key.ts` (22 lines); `agent-loop.ts` (`cacheKey`),
  `engine.ts` (one line); tests: new `tests/unit/orchestrator/session-cache-key.test.ts`
  (6) and `tests/integration/prompt-cache-key.test.ts` (4: every request of every
  message; not another session's; unmoved when the provider is rebuilt; the same in
  the process that resumes).
- **Verification.** 10 pass. **7 source mutants, 7 killed** — with the engine line
  removed all four integration tests fail, which is the "before".
- **Stable prompt ordering — measured, not changed**
  (`docs/evidence/prompt-prefix-p2-20261004.json`, `scripts/prompt-prefix-probe.ts`,
  zero model calls). The system prompt is 33,174 bytes: 23,395 of stable doctrine,
  then a 476-byte `# Environment` block (today's date, a `git status` snapshot,
  recent commits), then **9,303 bytes of stable text behind it**, starting with the
  skill catalogue. Inside one process the block is computed once and costs nothing.
  A new process computes it again, so on the first request after a resume
  everything from that block on is past the reusable prefix. Moving the block last
  would recover at most those 9,303 bytes, once per resume, and only inside the
  provider's retention window. That is not a measured saving, and the last time a
  prefix block was moved it cost an eval a gate (`engine.ts`, the narrative
  profile). Left where it is.
- **Tool-schema deferral — not touched.** 19.6 KB of schemas ride on every request
  (P1's snapshot). Deferring any of them trades bytes for discovery calls, and "a
  smaller system prompt that needs more recovery calls is not an efficiency
  improvement" is the card's own acceptance line. It needs the live comparison.
- **Limits.** What the stable key is worth in tokens is not measured: nothing here
  called a model. Only the lead loop carries the key; sub-agent, worker and research
  loops still use the adapter's own. Only the Codex adapter reads it — the OpenAI
  adapter derives its routing key from the prompt head, and the others have no
  such concept. A resume after the provider's retention window finds a cold cache
  whatever the key.
- **What a live A/B has to hold fixed** (the card): the same model, effort, inputs
  and provider conditions on both sides, with cache warm-up disclosed.
- **Next:** the Batch D exit. G1 waits on B1's evidence; so does the rest of P2.

## Batch D exit (R1, T1, P2's offline part) · **passed; G1 not started**

- **Combined gates on this tree,** outside the sandbox and under `caffeinate -i`:
  `bun run typecheck --force` 15/15; `bun run lint --force` 7/7;
  `tsc --noEmit -p tests/eval` clean; `bun test tests/unit` →
  **7306 pass, 3 skip, 0 fail** (475 files, 186 s; +96 tests since Batch C);
  `bun test tests/integration` → **449 pass, 7 skip, 0 fail** (74 files, 195 s;
  +45 since Batch B, the last boundary it was run at).
- **Run here ahead of B2, for information only:** `cargo test --locked --workspace`
  → **115 passed, 0 failed** across 9 test binaries (no card changed a Rust file);
  `bun run eval` (the mock suite, zero model calls) → **63/63**, baseline unchanged,
  0.27 completions per task.
- **Not run:** the offline corpus — its runner carries another session's
  uncommitted changes, and reconciling it is B2's own first step; the install; any
  live run.
- **Mutation totals for the batch:** 140 source mutants killed, 3 equivalent
  (R1 69 + 1, T1 64 + 2, P2 7).
- **G1 was not started, deliberately.** Its card reads "After: … B1 showing residual
  gate waste" and "choose the largest observed source of wasted retries". There is
  no observation to choose from until B1 has run, and picking a gate to migrate
  without one would be the unattributed change the review warned against.
- **What is waiting, and on what.**
  - **B1** — the founder's allowance, in numbers (the B1 entry lists the five).
  - **G1, and the rest of P2** (prompt order, tool-schema deferral) — B1's evidence.
  - **B2** — demonstrated improvement first; then the offline corpus, the install
    and the held-out breadth.
  - **Decisions parked for the founder:** which tasks get a declared boundary
    (`allowedPaths`), and whether the 80% complete-rate floor becomes a rule (M1);
    whether a replay-verified test the run wrote should settle its criterion —
    recommended against (R1); whether checks and replays the engine starts move
    inside the tool sandbox — today they run outside it (R1); ten minutes as the
    outage deadline (T1); how to commit, since hunks in `agent-loop.ts`,
    `engine.ts` and `rune-cli.ts` sit beside another session's uncommitted work.
- **Still true of everything above:** nothing is committed, staged, installed,
  pushed, published, or run against a live model. The installed binary is the one
  the founder had; a source edit changes nothing there until it is rebuilt.

## B1 pre-flight, 2026-10-05 · **the founder asked for the run; one step only the founder can do**

The founder asked for B1 to be run from this session, approving each command by hand.
What was checked before anything is spent, with zero model calls:

- **The plan is ready but for one thing.** A dry run of the pinned manifest plans
  the three pairs and refuses only the Claude Code arm: it needs an evaluation
  profile signed in by hand (`RUNE_PARITY_CLAUDE_CONFIG_DIR`). With a profile
  directory set, no line is refused. Signing in is the founder's own step; nothing
  here touches a credential.
- **The comparator's flags exist.** The arm was written against Claude Code 2.1.284
  and has never been run live; the installed CLI is 2.1.289, and every flag the arm
  passes is in its `--help`.
- **The Rune route has been used on this account:** 256 `codex/gpt-6-sol` calls on
  record, the last on 2026-09-29. The last meter reading on record (2026-10-03) is
  five-hour 38%, weekly 6%, plan `plus`; the five-hour window has since reset.
- **The native tools binary is current:** no Rust source is newer than
  `target/release/rune-tools`, and nothing under `crates/` or `skills/` is modified.
- **The offline corpus, run fresh** (`docs/evidence/corpus-offline-20261005.json`,
  zero model calls): 64 rows, 54 attempted — **false completions 0/44**, and every
  one of the 64 rows has the same classification, verdict and stop reason as the
  2026-09-27 run. Batches A–D moved no verdict in it. The ten "false negatives" are
  the same ten as before: a correct run that proves its fix with a test it wrote
  ends `partial`, and the rule for grading that (`TODO(human)`, D2, in
  `run-offline.ts`) is the founder's and was left as found.
- **What the run will not have:** a reading of Claude's window unless the founder
  gives one — the series is then bounded by its run count and wall allowance only,
  which the manifest already accepts (`bounded`).

## B1 re-planned on the Codex subscription, 2026-10-05 · **the founder's decision**

The founder will not spend the Claude subscription on tests: the comparator runs on
the Codex subscription that is already configured. The card allows it ("for
competition, compare the new build with Claude Code or OpenCode").

- **Manifest:** `docs/evidence/b1-manifest-20261005.json` (sha256 `acc5083726ac016d…`),
  written by the runner's dry run. Rune (`gpt-6-sol` via `codex`) against OpenCode
  (`openai/gpt-6-sol`, `--variant high`), product mode, one repetition, the same
  three tasks in the same order, the same limits: 3 pairs, at most 8 arm runs,
  210 minutes, stop at 70% of the window, `bounded`. The 2026-10-04 manifest
  (Claude Code) is kept and was never run.
- **Checked, with zero model calls:** the dry run refuses nothing; OpenCode 1.18.30
  accepts every flag the arm passes; it is signed in to OpenAI by OAuth and lists
  `openai/gpt-6-sol`. Its sign-in file is linked into each run's own data
  directory by the rig, never copied and never read here.
- **What this run can say.** It is the one comparison where both sides run the same
  model, so a difference is the harness's. It says nothing about Claude Code: that
  baseline is still open, and nothing here should be read as one.
- **One account, two arms.** Both draw on the same Codex window. Only Rune's rows
  carry the meter, and the meter is the account's, so the 70% stop that is checked
  before each Rune run sees what OpenCode spent too.

## B1 — run, 2026-10-05 · **done: diagnostic, provisional**

Three pairs, six agent runs, 17 minutes, on the Codex subscription only. Summary in
`docs/evidence/b1-result-20261005.json`; raw rows, envelopes, workspaces and the
report are machine-local under `~/rune-evidence/b1-20261005/`.

| Task               | Arm      | Hidden               | Scope |  Wall | Calls | List cost |
| ------------------ | -------- | -------------------- | ----: | ----: | ----: | --------: |
| review, no-code F5 | Rune     | 3/3                  |     1 |  71 s |     7 |     $0.11 |
|                    | OpenCode | 3/3                  |     1 |  99 s |    10 |     $0.12 |
| small fix F1       | Rune     | 3/3                  |     1 |  43 s |     7 |     $0.08 |
|                    | OpenCode | 3/3                  |     1 |  51 s |     9 |     $0.06 |
| serious F7         | Rune     | 6/6, **1 regressed** |   0.5 | 440 s |    32 |     $0.59 |
|                    | OpenCode | 6/6                  |     1 | 319 s |    32 |     $0.46 |

- **The card's acceptance.** Real envelopes parse, for both tools, through the whole
  path to a report. The model roster is recorded — and caught something: one Rune run
  made a supervisor call on `gpt-6-astra`, so the rows carry two rosters and the
  report refuses them unless told (`--allow-mixed-config`), exactly as M1 built it.
  No grade was overridden. The sample is what it is: one repetition of three tasks.
- **Rune over OpenCode, same model, median of three:** wall **0.84×**, list cost
  **1.29×**, model calls **0.78×**. The pilot's medians were 1.5×, 1.9× and 1.7×.
  That is not a controlled before-and-after — another day, another OpenCode build —
  but on the one task both series share, Rune went from 787 s and 1,320 s, $0.92 and
  $2.61, 41 and 78 calls, exit 1 both times, to 440 s, $0.59, 32 calls, exit 0.
- **The report says FAIL, and should.** Headline PI 36.7 on F7 from one pair: O 50,
  R 0, S 50. F1 and F5 are PROVISIONAL at 100 on one pair each. Nothing here is a
  parity claim in either direction.
- **The serious task, taken apart.**
  - _The regression is real, and is the model's reading._ Rune passed all six target
    tests and broke one that used to pass: given a list that never closes, its writer
    dropped the dangling element line and kept the next section, where the test wants
    every following line kept. Rune had read the requirement back as "unterminated
    values do not erase following sections". The pilot graded this task "6 pass,
    1 fail" for both tools in both of its runs; this time OpenCode passed all seven.
  - _"False completion" is the rig's reading of an exit code._ Rune's own verdict was
    `partial — 0 of 4 accepted`, printed in its answer; the process still exited 0
    with `ok: true`, and a caller that reads only that sees a claim of success.
  - _The scope penalty is the verifier's doing._ Its root `bun run typecheck` is
    `turbo typecheck`, which builds every package: 129 new git-ignored paths
    (`.turbo/`, `packages/*/dist/`) left in the tree. H1b sends cargo's and Python's
    generated state elsewhere; nothing does that for a JavaScript build.
  - _The wall-time gap is one check._ The model's work took 316 s against OpenCode's
    319 s. The other 123 s was end-of-turn verification: typecheck in 3 s, then the
    whole unit suite cut at its 120 s limit — inconclusive, nothing measured. V2 is
    why that cost no repair turn; it still cost two minutes, and it will on every
    task mined from this repository, whose suite takes about three.
- **No gate re-prompted the model in any of the three runs.**

## G1 — one controller-owned refusal budget · **not started: B1 shows nothing for it to do**

The card's precondition is "B1 showing residual gate waste", and its instruction is
to "choose the largest observed source of wasted retries". Across the three Rune runs
there were none: no execution-evidence, fix-verified, open-steps or acceptance
re-prompt fired, and the only harness messages were the opening notes and one
replanning nudge. Migrating a gate to a shared budget now would be a change with no
observation behind it, which is what the review warned against. It stays unstarted
until a run shows the waste it is for.

## What B1 points at instead · **two measured costs, both in end-of-turn verification**

Neither is a gate, and neither is fixed here: each trades something the founder
should choose.

1. **Build state a harness-run check leaves behind** (scope 0.5 on every task whose
   check builds). The ways out: run the harness's own checks in a throwaway
   copy-on-write copy of the tree, as V4 already does for the pre-run baseline —
   complete, and it changes where every check runs; or remove, after a check, the
   ignored paths it created — small, and it deletes files in the user's repository
   that something else could have made in the same seconds; or leave it.
2. **A check that cannot finish inside its limit** (two minutes per run here). The
   ways out: a longer limit for the end-of-turn check — more time, and a real answer
   instead of none; remembering per workspace that a check does not fit and saying
   so instead of running it — no help in a fresh profile, which is every benchmark
   run; or leave it. Narrowing the suite by an import graph is unproven for this
   task: the file it changed belongs to a package that 96 of the 353 source files
   import directly, so the affected set may be most of the suite.

Also on the table from this run: whether a headless run whose verdict is not `met`
should exit 0. Today it does, and a harness reads that as a claim.

## B2 — final gates and the installed artifact, 2026-10-05 · **local part done; breadth sized, not run**

- **Source and the gates that describe it.** `c841031` plus the uncommitted tree; no
  file under `packages/`, `crates/`, `skills/`, `tests/` or `scripts/` has changed
  since the Batch D exit, so those results stand for it: typecheck 15/15, lint 7/7,
  unit 7306 pass / 0 fail, integration 449 pass / 0 fail,
  `cargo test --locked --workspace` 115 pass, `bun run eval` 63/63.
- **The offline corpus, fresh output:** `docs/evidence/corpus-offline-20261005.json` —
  false completions 0/44, every row identical to 2026-09-27. Its runner still
  carries the founder's open `TODO(human)` (D2); it was run as found.
- **The installed artifact.** `bash scripts/install.sh` → exit 0: the staged binary
  hosted a session (1.3 s, zero leaked hosts) before it was promoted, and the
  previous binaries were kept as backups. In a fresh login shell:
  `rune --version` → `Rune v1.3.1-dev+c841031`; `rune doctor` → exit 0, build
  "current — gear/phase-0-stabilize@c8410316+dirty"; `rune tools-smoke` → exit 0,
  native round-trip of write, read, edit and bash.
  CLI sha256 `03c7610e68742b86…`, tools sha256 `50270c10ec4e08b1…`;
  macOS 27.0.1 (26A434), arm64.
- **Skipped, and why:** the two browser checks in the supplement (no browser
  configured for them); Go and Java verifier fixtures (no toolchain here).
- **Noticed, not acted on:** `~/.rune/bin` holds 224 backup files in 59 generations,
  4.8 GB; `install.sh --prune-backups` would keep five and free 4.4 GB. Pruning
  deletes, so it is the founder's to run.
- **The held-out breadth run, sized from B1 instead of guessed.** B1 moved the Codex
  five-hour window from 23% to about 34% and the weekly one from 25% to about 27%:
  roughly one point of the five-hour window per small pair and ten per serious pair.
  The screening minimum is 42 pairs — two repetitions of the 18 small tasks and six
  serious pairs — so about 100 points of five-hour window and 17 of the weekly one,
  some three hours of running, in at least three sittings under the 70% stop. Each
  sitting has to be a series of its own tasks: nothing resumes a stopped series, and
  two files that both hold a task's "run 1" cannot be merged.
- **The serious family should wait.** Until the two verification costs B1 found are
  decided, every serious pair would record the same scope 0.5 and the same two lost
  minutes; six more of them would measure a known defect six times.

## B2 — breadth, first sitting (F1–F3), 2026-10-05 · **done: parity on all three, provisional**

The founder approved it by name: 18 pairs, 36 agent runs, the Codex subscription, stop
at 70%. It ran 74 minutes — not the 45 estimated from B1's two small pairs.
Summary in `docs/evidence/b2-s1-result-20261005.json`; manifest
`docs/evidence/b2-s1-manifest-20261005.json`; raw evidence machine-local under
`~/rune-evidence/b2-s1-20261005/`.

| Family                    | Pairs | Tasks |   O |     E |   R |   S |    PI | 80% interval |
| ------------------------- | ----: | ----: | --: | ----: | --: | --: | ----: | ------------ |
| F1 fix                    |     6 |     3 | 100 | 100.0 | 100 | 100 | 100.0 | 98.4–100.0   |
| F2 omission-prone feature |     6 |     3 | 100 | 100.0 | 100 | 100 | 100.0 | 100.0–100.0  |
| F3 multi-file / migration |     6 |     3 | 100 |  96.3 | 100 | 100 |  99.1 | 96.2–100.0   |

- **Outcome: a tie.** 18 of 18 complete and clean for each tool; every hidden check
  passed, nothing regressed, scope 1 throughout.
- **Every numeric threshold is met** — n ≥ 6 over ≥ 3 tasks, PI ≥ 90, lower bound ≥ 85
  — and the status is still PROVISIONAL, for one reason: ten of Rune's eighteen runs
  made supervisor calls on `gpt-6-astra` and eight did not, so its rows carry two
  model rosters and M1's rule will not PASS across them. That rule cannot be met by
  running more: which runs call the supervisor depends on what the model does. Either
  the roster is compared as configured rather than as observed, or the supervisor is
  pinned to the session model for these runs. The founder's to choose.
- **Rune over OpenCode, same model:** wall 36.3 min against 37.5 (median pair
  0.94×; Rune faster in 11 of 18); model calls 197 against 181 (1.2×); **list cost
  $2.58 against $1.70** (median 1.56×; Rune cheaper in 3 of 18). Product mode's E
  reads wall and calls, not cost, so the index does not see that last line.
- **Where the extra cost is.** $0.35 of the $0.88 is the supervisor: 14 calls on
  `gpt-6-astra`. The rest is the prompt: 15,755 tokens a call on average, 78% of it
  read from cache. That is the per-role attribution P2 was waiting for.
- **No gate re-prompted the model in any of the 18 runs**, and all 18 end-of-turn
  verifications passed. With B1 that is 21 runs with nothing for G1 to do.
- **Quota:** the fuller Codex window went from 28% to 35% — seven points for 36 runs,
  about a fifth of a point per small run.

## What a check Rune ran leaves in the tree, 2026-10-05 · **done; scope not yet re-measured live**

The first of B1's two verification costs, and the founder's decision on it: "remove
what it created". Not a card of the 09-30 plan — it comes from B1's evidence.

**The problem, dated.** Creation times in the tree B1's serious Rune run left behind
put all 129 new git-ignored paths inside passes of checks the harness itself ran: 127
from two `bun run typecheck` passes (the step check, then the end of the turn —
`.turbo/`, a `.turbo/` and a `dist/` in each package) and 2 `__pycache__` files from
the test check. None was the model's. H1b keeps cargo's and Python's generated state
out of the tree through the environment; a JavaScript build has no such switch.

**The rule.** When a pass of checks Rune detected ends — passed, failed, cut at its
deadline or cancelled — the git-ignored paths it created are removed. A path goes only
if all of these hold:

- git ignores it now, and listed it neither as ignored nor as untracked before the
  pass. A folder an ignore rule names is one path to git, so a `dist/` that was
  already there keeps whatever the check put in it;
- the file system says it was created during the pass. This is what stops two real
  cases found while testing: an ignore rule written mid-pass makes a folder that was
  always there read as newly ignored, and an empty folder that fills with only
  ignored files reads as an ignored folder;
- its name is not one that is never build output: `node_modules`, `.venv`, `venv`,
  `vendor`, `Pods`, `*.egg-info`, `.env*`, `.idea`, `.vscode`, `.claude`, `.DS_Store`,
  and Rune's own `.rune/`. Inside a brand-new folder that holds only ignored things,
  each entry is judged on its own, so such a name survives there too.

A link is unlinked, never followed. A new file git does **not** ignore is left: that
is a visible change. Outside a git repository nothing is removed.

**Two narrowings, both mine, both within what was approved.**

- A command the person wrote in `[verify] commands` keeps what it builds. H1b draws
  the same line for the same reason, and deleting it would make every pass a cold
  build of the person's own command.
- `run_checks` on the engine host — a person asking for the checks — keeps it too.

**Where it is said.** `VerifyResult.removed`; `removed` on `verification_completed`
and `step_check`; one line on the run's audit trail. Never in the report: the TUI
shows a failed check's last report line as the failure's own words, and the task
spine reads the first. `[verify] keepGenerated = true` turns the rule off.
`docs/verification.md` has the section.

**Changed.** `packages/orchestrator/src/verifier.ts` (the rule, `run` split from
`runChecks`), `agent-loop.ts` (four small hunks), `engine.ts` and
`bin/rune-cli.ts` (the setting), `bin/engine-host.ts`, `packages/protocol/src/events.ts`
(two optional fields), `packages/shared/src/config.ts`, `docs/verification.md`. New
tests: `tests/unit/orchestrator/verifier-generated-state.test.ts` (33),
`tests/unit/orchestrator/agent-loop-generated-removed.test.ts` (5),
`tests/integration/verifier-generated-state.test.ts` (2).

**Verified.**

- Gates on the final source: `bun run typecheck --force` 15/15; `bun run lint --force`
  7/7; `tsc --noEmit -p tests/eval` clean; unit **7344 pass, 3 skip, 0 fail**;
  integration **451 pass, 7 skip, 0 fail**; `bun run eval` 63/63. Rust untouched, so
  `cargo test` was not re-run.
- Mutation: 57 changes to the new code, **53 caught**. The four that are not: reading
  an unknown creation time as old, removing a link with the recursive call, and not
  sorting git's listing are each the same behaviour on this machine (APFS, Bun
  1.3.14, git 2.54); not stripping a trailing slash matters only if a folder becomes
  a link between git's listing and the removal.
- **Replay on B1's own tree, zero model calls**
  (`docs/evidence/verifier-generated-replay-20261005.json`), on copies of that tree
  returned to their state before the first check.
  - The step check. With the rule: 15 entries removed each pass, **0 new ignored paths
    left**. With `keepGenerated`: 15 entries, 93 files left — B1's finding, reproduced.
  - The end-of-turn pass, as B1 ran it: typecheck, then the unit suite, cut at its
    120 s deadline. 17 entries removed — the build output and the test check's
    `__pycache__/` — and by the listing the benchmark's scope rule reads, **nothing new
    in the tree**, then or twenty seconds later. The 129 become 0.
- The two git listings cost 28 ms and 23 ms on this repository.

**What it costs.** Turbo's cache is in the `.turbo/` that is removed, so each later
pass builds again: on that tree `bun run typecheck` took 4.2 s on the second pass
against 0.09 s with the build kept. B1's serious run had two passes, so at most
about four seconds on a 440-second run. A tree whose build takes minutes is where
`keepGenerated` belongs. A tree that already has its `dist/` — a person's working
checkout — pays nothing and has nothing removed.

**Limits.**

- It cannot tell its checks' output from something else that first wrote an ignored
  path in the same seconds: a watcher the run started in the background, a second
  agent in the same tree. The founder accepted this risk in choosing the rule; the
  name list and `keepGenerated` are what bound it.
- One other harness-started command runs in the workspace and is not covered: the
  replay of a cited test on the current tree (`parent-check.ts`).
- The setting's path from `config.toml` through `rune-cli.ts` is one line beside its
  neighbours and has no test; the engine-level test starts at the engine's config.
- Tests that run a check are POSIX-only, as the other verifier tests are; the rule
  itself has not run on Windows. The handling of a new all-ignored folder relies on
  git listing that folder's contents, seen on git 2.54 only.
- On a file system with no creation times the second condition decides nothing and
  the first stands alone.
- Two runs of the new unit file each had the deadline test overrun Bun's five-second
  default. Every run since has passed: six of the whole file, four of the deadline
  tests alone, the mutation runs, and the full unit suite. The power log shows no
  sleep. The timings fit a stall in the test's own synchronous git setup, not the
  code under test, but that is a reading, not a finding. The file now sets a
  60-second allowance, and the product's listings were made asynchronous so a slow
  git cannot hold the terminal still.

**Installed.** `bash scripts/install.sh` exit 0. `rune --version` gives
`Rune v1.3.1-dev+c841031`; `rune doctor` and `rune tools-smoke` exit 0. CLI sha256
`8a23a8646c612ef3…`, tools `50270c10ec4e08b1…` (unchanged), macOS 27.0.1 arm64. The
compiled binary contains the new setting's name and the audit line's words.

**The repo-wide format check.** `bun run format:check` is CI's own step and is not
part of `bun run lint`; it had not been run at the earlier batch boundaries. It
flagged the four manifests the runner wrote. They are now in `.prettierignore` beside
the other captured receipts, because the ledger records each one's sha256. What it
still flags is `Claude outputs/resume/resume.html`, which git excludes locally and CI
never sees.

**The live check, prepared and not run.** One pair on `f7-653698d-toml-config`, Rune
first and then OpenCode, both on `gpt-6-sol`:
`docs/evidence/b2-s2-serious-rerun-manifest-20261005.json` (sha256
`27b967800ffa0e54…`). Hard stops: 1 pair, 3 arm runs, 100 minutes. The same pair took
about 13 minutes in B1. It waits for the founder's approval of this run:

`RUNE_EVAL_QUOTA_PCT=70 bun run tests/eval/parity/run-pairs.ts --real --manifest docs/evidence/b2-s2-serious-rerun-manifest-20261005.json --out ~/rune-evidence/b2-s2-serious-rerun-20261005`

**Next.** That pair, to see scope come back to 1. B1's second cost (the whole unit
suite as the end-of-turn check, cut at 120 s) is untouched and still the founder's to
decide.

## One build per arm, and today's change · **a decision for the founder**

M1's rule is one build per arm per mode: two builds measured as one would be averaged
without saying so. The report holds it by a binary's sha256 or by the `--version`
string. Rune's arm runs from source, so its rows carry no binary hash, and every
build of this working tree answers `Rune v1.3.1-dev`. **The report cannot see that
the source changed.**

Each series does record it, in its own `series.json`: B1 and the first breadth sitting
both ran on source fingerprint `fc61e3e6a3d6…`. Anything run from here on is a
different build — the one with the cleanup rule.

So a single report over the first sitting and any later one would pass the mixed-build
check while breaking the rule it exists for. Three honest ways through; none is mine
to choose:

- **Report each family from its own sitting**, with that sitting's source fingerprint
  beside it. The floor is per family, so nothing is averaged across builds. F1–F3
  would stand as measured on the earlier build.
- **Measure F1–F3 again at the end**, on whatever the final build is: 18 pairs, about
  74 minutes and seven points of the window. One build for the whole series.
- **Put the source fingerprint on Rune's rows** and let the mixed-build check read it.
  That closes the hole in the rig, and it makes the first option or the second
  unavoidable rather than optional.

What the change could have moved in F1–F3 is small: all 36 of those runs ended with
scope 1, so the rule had nothing to remove there, and it adds two git listings to a
pass. That is an argument, not a measurement.

## The rig: a build on each row, and the roster an arm is configured with, 2026-10-05 · **done**

The founder's answers to the two open questions on the first sitting: report each
family from its own sitting and put the source fingerprint on the rows; compare
rosters as configured. Both are rule changes to M1's rig, written before any further
row, because a row that lacks a field cannot be given it afterwards.

- **`sourceBuild`.** The runner already fingerprinted Rune's source and stopped a
  series if it moved. That fingerprint is now on every row and in the report's
  **Versions** line, and the mixed-build refusal reads it: two source builds in one
  mode are refused, and so is a set in which some rows name a build and some name
  none. A widening — it refuses more than before.
- **`roster`.** Where every row of an arm states the models its configuration names,
  what a run called is held to that roster instead of to being the same on every row.
  A configured helper that some runs needed is one configuration; a model outside the
  roster is refused as before; two rosters are two configurations. A narrowing, in
  that one case. What was called is printed under **Models called**.
- **Where Rune's roster comes from.** `runeRoster` asks the product's own
  `resolveTier` for each tier with no override, which is the parity profile. For
  `codex` and `gpt-6-sol` it answers astra, luna and sol. The rig keeps no list.

**A correction to what I told the founder.** `gpt-6-astra` is the provider's heavy
tier — the flagship, at five times sol's list price — not a cheaper helper. The
reviewer runs on it by Rune's shipped default. That is where 40% of the first
sitting's extra cost went.

**Changed.** `tests/eval/parity/{types,aggregate,run-pairs,report}.ts`,
`tests/eval/comparison/arms/{types,rune}.ts`, `docs/program/parity-index.md`
(the rules and a dated note). Tests added to `parity-report.test.ts` (11),
`parity-run-pairs.test.ts` (2) and `comparator-arms.test.ts` (4). Nothing under
`packages/`, so Rune's own build is the one gated above.

**Verified.** `tsc --noEmit -p tests/eval` clean; `bun test tests/unit/eval/`
**506 pass, 2 skip, 0 fail** (489 before). Mutation: 36 changes, **36 caught** after
two tests were added for the two that first survived.

**What it does not do.**

- Rows written before today carry neither field. The first sitting's F1–F3 rows are
  read by the older roster rule and stay PROVISIONAL by label; they cannot be put in
  one report with a later sitting's rows. Lifting the label means running those 18
  pairs again. The numbers themselves meet every threshold.
- The roster is what the configuration names. A review that should not have happened
  is inside it; so is every tier, whether or not this task had any use for it.
- A `[tiers]` override is not read by `runeRoster`. No parity run is given one.

**The next sitting, drawn and not chosen.** Five serious tasks from the 29 not yet
run, by the rig's own seeded shuffle (seed 20261005) over their sorted ids:
`f7-44d4c1a-header-version-session`, `f7-5553813-tilde-user-home`,
`f7-93eca44-model-catalog-cache`, `f7-a218abc-checkpoint-report-matches-prune`,
`f7-6af7bb5-startup-selection`. Manifest
`docs/evidence/b2-s3-serious-manifest-20261005.json` (sha256 `0c6de1b5c0b4fa74…`):
hard stops 5 pairs, 12 arm runs, 150 minutes. The founder approved it to follow the
one-pair check if that comes back clean.

## The live check on the serious task, 2026-10-05 · **scope fixed; the pair lost again**

One pair, approved by the founder by name: `f7-653698d-toml-config`, Rune then
OpenCode, `gpt-6-sol` on the Codex subscription. Ran 20:59–21:20. Summary in
`docs/evidence/b2-s2-serious-rerun-result-20261005.json`; raw evidence machine-local
under `~/rune-evidence/b2-s2-serious-rerun-20261005/`.

|          | Hidden checks        | Scope | Clean | Wall  | Calls | List cost |
| -------- | -------------------- | ----: | ----- | ----- | ----: | --------: |
| Rune     | 6/6, **1 regressed** | **1** | no    | 799 s |    38 |     $0.73 |
| OpenCode | 6/6, 0 regressed     |     1 | yes   | 464 s |    19 |     $0.34 |

- **What it was run to find out: scope is 1** (B1: 0.5). The run's own record has
  three lines "removed 16 git-ignored paths the checks generated" — two step checks
  and the end-of-turn pass — and the tree it left holds its two edited files and the
  seven ignored files that were there before. The report's S went from 50 to 100 and
  the pair's index from 36.7 to 46.7.
- **The cleanup did not get in the model's way.** Every test, typecheck and format
  command the model ran itself exited 0; none failed for want of build output.
- **The rig's two new fields worked on real rows.** This is the first report built
  with no `--allow-mixed-config`: Rune's rows state the roster and the source build
  (`93adbb536fc6…`), and the report names both.
- **The pair is still a loss, and for the same reason as B1.** Rune broke the same
  existing behaviour: with a list that never closes, it kept the next section and
  deleted the list's orphaned line; the hidden check wants both kept. OpenCode has
  now kept both twice, Rune neither time, on one model.
  - The task says the writer "must not delete the lines that follow it". In both runs
    Rune's read-back restated that as not swallowing a following **section**, and the
    run then built and tested the narrower sentence. A hypothesis, from two runs: the
    restatement is where the requirement narrowed. It is worth a look before it is
    worth a fix.
- **"False completion" is the exit code again.** Rune's own verdict was `unmet` — four
  criteria unassessed, the end-of-turn check cut at 120 s — and the process exited 0,
  which the rig reads as a success claim. The founder's parked decision on what a run
  exits with when its verdict is not `met` is what this row turns on.
- **Slower and dearer than B1's run, and most of that is not the harness.** About 140
  of the 799 seconds were Rune's own checks (124 at the end of the turn, the unit
  suite cut at 120 again). The rest was 38 model calls at 17 seconds each; in the
  afternoon they took 10. OpenCode's calls slowed the same way, 24 seconds against 10,
  but it needed only 19 of them.
- **Harness friction seen in this run, none of it from today's changes:**
  - the reviewer timed out at about two seconds twice, both commands were denied by
    containment, and two turns were refused;
  - `bun add` failed twice inside the tool sandbox: it could not write to its temp
    directory;
  - the step checks ran `cargo check` (7.0 s, then 0.25 s) on a change the end-of-turn
    selection judged not to concern Rust.

**Not started.** The five further serious pairs were approved to follow a clean pair.
This one was not clean. Their manifest stays ready
(`docs/evidence/b2-s3-serious-manifest-20261005.json`); whether to run them is the
founder's call again, now knowing this.

**What this does and does not show.** One task, twice. It shows the scope defect is
gone and that this task is lost for a reason that repeated. It says nothing yet about
the other 29 serious tasks.

## Three frictions from the live check, traced, 2026-10-05 · **diagnosed; nothing changed**

The founder's choice after the live pair: look into the frictions before measuring the
serious family. Zero model calls. Nothing under `packages/` or `crates/` was edited.

**They are one chain, not three.** The model wanted a TOML library, and what followed
cost about six of the run's 38 calls and some 115 of its 799 seconds:

1. `bun add smol-toml` failed (twice, the second time with `TMPDIR` moved);
2. the model wrote a diagnostic one-liner; the reviewer could not answer in time, and
   the command was denied (twice — it re-sent the same command);
3. the `.tmp` folder its second try left behind made both step checks also check the
   Rust project (`cargo check`: 7.0 s, then 0.25 s). An unknown file in the tree
   cannot be ruled out of it, which is the scope rule working as written;
4. cleaning that folder up, a chained `rm` was blocked by the sandbox.

**1 — a package cannot be installed inside the tool sandbox, and the error says
something else.** Reproduced offline through `rune-tools --sandbox bash`:

| Command inside the sandbox                         | Result                                  |
| -------------------------------------------------- | --------------------------------------- |
| `bun add smol-toml`                                | "unable to write files to tempdir"      |
| the same, `TMPDIR` in the workspace                | the same error                          |
| the same, `BUN_INSTALL_CACHE_DIR` in the workspace | no network: gets as far as the registry |
| that again, with `network: true`                   | **installs, in 254 ms**                 |

Bun's install cache (`~/.bun/install/cache`) is outside the sandbox's writable
folders, and Bun reports that as a temp-directory failure. The same is true of
`~/.npm`, pip's cache and `~/.cargo/registry` on this machine; only Bun's failure was
run. `~/.rune/cache` is writable. So granting `network: true` grants a network that
no package manager can use.

- _Small fix:_ give a sandboxed shell the package managers' cache variables, pointed
  under `~/.rune/cache` — the H1b idea, applied to the tool sandbox. No writable
  folder is added. Rust (`crates/rune-sandbox`), with tests on both platforms.
- _Smaller:_ fail at once with the real reason, as the network preflight already does
  for a command that needs a network it has not got.
- _Whose call:_ the founder's. Letting a run add a dependency is a permission, and the
  comparators allow it.

**2 — the reviewer's budget sits on top of its usual latency.** One deadline of 12 s
covers the reviewer's call and its retry: the first attempt gets 10 s, the retry gets
what is left. The reasoned review runs on the heavy tier with medium reasoning and 700
output tokens, and the code's own comment puts it at about 9 s. On a slow evening it
ran past 10; the retry — on the same model, since no other reviewer is configured —
had 2 s and no chance.

- Of 22 recorded Rune runs, the in-path reviewer was needed twice. Both were tonight,
  both timed out, both ended in a denial. The 15 out-of-band supervisor screens (64
  tokens, no reasoning) took 1.7–5.0 s and all answered.
- _Options, all the founder's — this is the permission path:_ a longer default
  (`[autoMode] timeoutMs`, 12 s today, up to 60 allowed); a faster reviewer for the
  retry; or a reviewer on the session model, which is also where 40% of the first
  sitting's extra cost went. Each trades independence or waiting for answers.
- _Not a defect:_ denying when nobody can review is the design, and the denial told the
  model what to do instead.

**3 — the read-back is where the requirement narrowed, twice.** The task states about
eight requirements; `read_back` takes at most six criteria, and both runs wrote four. In
both, "must not make the writer delete **the lines** that follow it" became "does not
swallow a following **section**", and the run built, tested and reported that.

- The tool and the doctrine ask the model to _restate_ — "the SYMPTOM they described,
  not the command they typed". Nothing asks it to keep a stated rule in the person's
  own words.
- _Candidate fix:_ one doctrine line and one in the tool's description — a rule the
  request states (must, must not, never, keep) goes into `done_when` in their words.
  Possibly a higher cap than six.
- _What it cannot be given without spending:_ evidence. Two runs of one task is the
  whole case, and 18 small tasks passed every hidden check with the read-back as it
  is. Proving a wording change needs this task run several times.

**What was already known and showed again.** The end-of-turn check — the whole unit
suite, cut at 120 s — measured nothing for the third time and cost 124 seconds. The
run's verdict was `unmet` and its exit code 0. Both are decisions parked with the
founder.

**What a clean run of this task would have scored**, by the index's own formula and
my arithmetic rather than a report's. With the regression avoided and tonight's time
and calls: about 88. With the afternoon's: about 96. The requirement is
worth more than the frictions; the frictions decide which side of 90 it lands.

## The three fixes, 2026-10-06 · **built and gated; not yet measured live**

The founder approved all three after the diagnosis above. One bounded change each.

- **The reviewer's deadline: 12 s → 30 s** (`auto-mode.ts`, `DEFAULT_TIMEOUT_MS`).
  The first attempt now has 28 seconds. Who reviews, what is asked, and what a
  missing answer means are unchanged. `docs/auto-mode.md` updated; one test pins the
  default and its bounds. `reviewer-cost.test.ts` had the old default written into
  it; that scenario now sets its 12 seconds itself, since what it shows is the bound
  on a hung reviewer and not the default.
- **The read-back keeps a stated rule in the person's words** (`prompts.ts`,
  `brief.ts`). One sentence on the doctrine's `done_when` line and one in the
  tool's own description of that field. Cut from 58 tokens to 22; the doctrine's
  ceiling goes from 7,790 to 7,810 with the argument written beside it, and the
  byte-pinned opening prompt gains 86 bytes. The working-phase prompt is unchanged.
- **`bun add` inside the tool sandbox** (`crates/rune-sandbox`). A contained shell is
  given `BUN_INSTALL_CACHE_DIR` inside the workspace, at `node_modules/.cache/bun`.
  **This differs from what the founder was told when approving it** — "`~/.rune/cache`"
  — and they have been told so: a cache shared by every project and writable by
  every contained command would be a way from one project into the next, and
  `docs/sandbox.md` already promises that `network: true` never permits a write
  outside the workspace. The executor that contains nothing is left alone.
  - Proved through the rebuilt tool with no workaround: `bun add smol-toml` with a
    network installs in 300 ms; the package runs offline; a second install reuses
    the cache; the home cache is still closed.
  - npm's, pip's and cargo's caches are not moved. Only Bun's failure was run.

**Verified, on the final tree.** `cargo fmt --check` clean; clippy clean with all
targets, all features and warnings denied; `cargo test --locked --workspace`
**118 pass**; `bun run typecheck --force` 15/15; `bun run lint --force` 7/7;
`tsc --noEmit -p tests/eval` clean; unit **7364 pass, 3 skip, 0 fail**; integration
**453 pass, 7 skip, 0 fail** (one failure on the first run was the old default in
`reviewer-cost.test.ts`, above); `bun run eval` 63/63; `bun run format:check` clean
but for a file git excludes locally. Mutation: 5 of 5 in TypeScript, 6 of 6 in Rust.
The Linux executor's line has no test that ran here; the two new integration tests
are its test, and they run in CI.

**Not shown.** None of the three has been in a live run. The read-back sentence in
particular is a guess at a cause seen twice on one task.

## A second session's three changes, and the release, 2026-10-07 · **amended, gated, shipped as v1.3.2**

The founder asked for everything in the tree to be released as v1.3.2. Re-running the
gates on the exact tree to be committed found it was no longer the tree gated the
evening before: a Codex session had been working in the same checkout since about
18:28 on 10-06, and went on until 09:54 on 10-07.

**What it added.**

- **A prompt economy pass** — the rest of P2. Repeated instructions consolidated: the
  full doctrine from 7,807 tokens to 5,402, the opening prompt from 24,220 bytes to
  15,267. Its record: `docs/evidence/parity-efficiency-20261007.json`, which says
  plainly that a live token-cost reduction is not established. The read-back sentence
  added the day before survived the pass.
- **The exit code follows the verdict** — the decision parked since B1. A `partial` or
  `unmet` verdict made `rune -P` exit 1 with `ok: false`.
- **Attempt economics in the parity report** — cost per clean completion and paired
  cost and wall ratios, descriptive only. The index still does not read cost.
- An opt-in for the Claude Code arm to use the ordinary sign-in under `--safe-mode`.
  Nothing uses it unless a variable is set.

**What the gates found: 8 failures**, 1 unit and 7 integration. Two were numbers
pinned to the old prompt's size. Six were the exit rule, and they were not stale
tests: a plain "hello", a fresh install's first prompt and the pull-request review
action all exited 1. Each ends `unmet` with "no criteria stated", which is what the
verdict says of any run that states none. By morning the session had made four of
the six pass by changing what the tests expect — "hello" expected to fail, the review
action expected to print "The run did not complete" in place of a review.

**What was done, on the founder's word ("I fix them, ship everything").**

- **The rule is narrowed** (`headless.ts`, `unfinishedVerdict`). A `partial` or
  `unmet` verdict fails a finished run only where a promise was made about a change:
  the run stated criteria **and** changed files, or it was held to a criterion from
  outside itself (the person's, or an `--acceptance` check), whether or not anything
  changed. No criteria, or only the run's own read-back with nothing changed, is
  judged by execution alone — neither can reach `met`.
- **The two inverted tests were put back** to what the last commit expects, and pass.
- **The two size pins were re-measured**, with the reason beside each.
- **Its own tests for the rule were rewritten** for the narrowed one (seven cases in
  `headless.test.ts`). Mutation: 11 changes to the rule, **11 caught**.
- `docs/ci.md` states the rule as it now is, and the session's evidence file carries
  an `amendedAfter` note rather than being rewritten.

**What the narrowed rule still does, and it is strict.** A run that reads back its
terms, changes files and proves only some of them exits 1. `partial` is, by the
protocol's own definition, "the normal honest outcome of a successful run" outside a
git repository. A script that treated every finished run as success will see failures
it did not see before. This is the founder's decision as that session implemented it;
only the cases that made ordinary runs fail were taken out.

**The benchmark does not depend on it.** The Rune arm now reads the verdict from the
envelope itself, so a run whose verdict is `partial` or `unmet` is an honest "not
finished" to the rig whatever the process exited with.

**Left out of the release.** `videos/` (a 7.9 MB reel the founder has not reviewed)
and two Gradle build-cache folders under a test fixture. Everything else in the tree
is in it.

## CI after the release, 2026-10-07 · **done: `main` is green at `3b688d4`**

**The release itself is out and checked.** Four commits (`6d9c6e4`, `74e4ef6`,
`e561fa9`, `c15baeb`), `main` and the branch at `c15baeb`, tag `v1.3.2` there. Release
run `37583047747`: 13 jobs green, 11 assets, marked Latest. The published macOS binary
matches its checksum and reports `Rune v1.3.2`.

**CI on `main` was red (run `37583044264`), and had been for longer than this
release.** Every scheduled run since 27 September failed; the last, on 6 October, on
two tests. The release added 34 failing tests of its own: 8 on Linux, all 34 on
Windows. All 34 are in test files that had only ever been run on this Mac.

**One of them was a fault in Rune** (`check-failures.ts`, the reader of Bun's test
report). Inside GitHub Actions Bun opens each test file with a `::group::` prefix; on
Windows it writes the path with backslashes. The reader kept both in the file's name.
The rule "a failing test in a file the run changed is the run's" compares that name
with git's list of changed files, so it never matched. A failing test the run had
edited was called existing; when it was the only failure the loop asked for no repair.
The check was reported red throughout. The name is now read without the prefix and
with forward slashes. This is in the shipped 1.3.2 binaries and is not yet released.

**The rest were assumptions in tests, not faults in Rune.**

| Where                                                          | What the test assumed                               | What was done                                           |
| -------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `baseline.test.ts` (9), `verification-baseline.test.ts` (1)    | the ignored environment can be cloned               | gated on macOS and Linux; the refusal elsewhere tested  |
| `workspace-hygiene.test.ts` (4), `parity-fairness.test.ts` (2) | `/` between path parts                              | expectations built with `node:path`                     |
| `parity-run-pairs.test.ts` (1)                                 | a path the CLI resolves stays as typed              | expectation resolved the same way                       |
| `parity-fairness.test.ts` (1)                                  | a `#!` script can be executed                       | skipped on Windows, by name                             |
| `parity-run-pairs.test.ts` (1)                                 | rename may replace a read-only file                 | skipped on Windows; the corpus check is left alone      |
| `serious-source.test.ts` (1)                                   | `git archive` writes LF                             | the rig now asks for the commit's own bytes             |
| `delegation-replay.test.ts` (3)                                | an open database can be deleted                     | the store is closed first                               |
| `ui-agent-inspect.test.ts` (2)                                 | a file URL's path is a file path                    | imports by URL                                          |
| `ui-turn.test.ts` (1), `ui-working.test.ts` (1)                | no earlier test file left a sub-agent in the ledger | the ledger is reset around each test, and by its source |

The last row is not about Windows. The sub-agent ledger is one per process and test
files share the process. `ui-fleet.test.ts` reset it before each of its tests and
never after the last, so a finished agent stayed. Windows runs files in name order,
which puts that file ahead of the two that failed; Linux and macOS happened not to.

**The two older failures.** `t20-background-lifecycle.test.ts` asked the engine for
`rune-tools` by bare name, so it passed only where Rune is installed; it now uses the
binary the checkout built and is skipped, with a printed note, where there is none.
`list_dir.rs` expected `/` in a path the tool writes with the platform's separator.

**Each cause was reproduced on this Mac before it was fixed**, which is the only
evidence there is for Windows until CI runs:

- annotations: `GITHUB_ACTIONS=true AGENT=0` makes Bun write them even under an agent
  (Bun leaves them out when it believes an agent is reading, which is why a plain
  `GITHUB_ACTIONS=true` reproduced nothing here). The 8 Linux failures appeared, exactly.
- no way to clone: the clone command disabled in a throwaway edit. The same 9 failed.
- CRLF: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=true`.
  The same test failed.
- the leaked sub-agent: a preload that leaves one finished agent in the ledger. Both
  failures appeared with the runner's exact text.
- no `rune-tools`: the installed folder taken off the path. The same test failed.

Not reproduced, reasoned from the code only: the path-shape cases, the file-URL
import, the open database handle, and the read-only rename.

**Mutation.** Removing the prefix handling fails 3 tests, removing the separator
handling fails 1, and removing the new cleanup from `ui-fleet.test.ts` leaves an agent
behind for the next file. 3 of 3 caught.

**Seen and not changed.** With a finished sub-agent in the ledger, the working row at
the checking stage shortens "running checks" to make room it does not then use. It is
what made the leak visible. It is cosmetic and it is in 1.3.2. Three more test files set
the terminal width and never put it back (`ui-grammar`, `mcp-panel`, `ui-band`).
Nothing fails on that today; a different file order could change it.

**Gates on this tree, 2026-10-07 13:42.** `cargo fmt` and clippy clean, `cargo test`
118 pass; typecheck 15 of 15, lint 7 of 7, `tsc -p tests/eval` clean, `bun audit` clean;
unit 7,392 pass, 4 skip, 0 fail; integration 453 pass, 7 skip, 0 fail; offline eval 63
of 63. Unit and integration were each run a second time the way the runner runs them —
annotations on, no agent variable, no installed `rune-tools` on the path — with the
same totals. The unit suite also ran in a fresh clone with nothing built: 7,377 pass,
19 skip, 0 fail, the extra skips being the tests that need the native binary. The
repo-wide format check flags one file, a résumé kept out of the repository by a local
exclude. The tree's fingerprint was the same before and after.

**What a green unit job will uncover.** In CI the format check and the audit run after
the unit tests, and the build, integration and eval jobs wait on them. None of those
has run since late September. Integration has therefore never run on Linux with this
release's tests in it. CI installs the newest Bun (1.4.2 that day); this Mac has 1.3.14.

**The founder's word, 2026-10-07: the lane branch first.** Commit, push to
`lane/ci-green`, fix there until CI is green, then fast-forward `main` and the working
branch to it. Commits `75dc589` (the reader) and `4b09d54` (the tests).

**The lane, first run (`37608603220`).** Every job that had been red passed: unit on
Linux, macOS and Windows, and the Rust tests on Windows. The real-model eval job
skipped itself, as it does with no key configured; nothing was spent. Then the jobs
behind the unit tests ran for the first time since late September, and integration on
Linux failed 5 tests. None is a fault in Rune:

- 3 in `engine-lifecycle-restart` and `engine-lifecycle-projection` named `rune-tools`
  by bare name, as T20 did. CI builds the binary and names it in a variable; these
  never looked there. They now use the checkout's own binary.
- 2 in `frontend-loop` mounted a browser and expected no warning. That holds only on a
  machine with a Chromium in Playwright's cache, which this Mac has and the runner does
  not. Each now says which machine it means, and the runner's case — mounted, nothing
  to launch — is a test of its own.

**Why the first simulation missed them.** It took `~/.rune/bin` off the path. This Mac
also has `~/.alan/bin`, with a `rune-tools` from before the rename, and a Playwright
cache in the home folder. A bare-machine run — fresh clone, empty home, neither folder
on the path, the runner's variables — reproduced the same 5. After the fix it passes:
454 pass, 7 skip, 0 fail. Integration on macOS was cancelled in CI when Linux failed,
so that run is the only evidence for it so far.

**The lane, second run (`37611760494`, `fd92b9c`): all 22 jobs passed**, and `main` and
the working branch were fast-forwarded to it.

**`main`'s own run of the same commit (`37613435082`) then failed one test on macOS**
that had passed in both lane runs and passes here. `verifier-generated-state.test.ts`
deletes its fixture's `.git` and expects git to answer "not a repository"; git listed
an empty set instead. File order was identical in all three runs, so it was not
ordering. A repository above the temp folder would have failed seven other tests
(measured by running the suite that way), and none of them failed.

What was measured: Bun's `rmSync` with `force` returns normally and leaves the folder
where it was when anything inside it vanishes during the walk. Under a deliberate race
that happened 50 times in 300 on Bun 1.4.2 and 41 in 300 on 1.3.14, each time leaving a
complete git directory; on Node, never. The test's delete had `force`. What was not
observed is what raced with it on the runner: the only thing still running in a
fixture's `.git` after a commit is git's detached maintenance, and on this Mac that
could not be caught holding anything. The fixture's commits no longer start it, the
delete has no `force` so a failure is an error, and the premise is asserted. Twelve
runs of the file on Bun 1.4.2 pass; removing the delete fails the test at the premise.

The product's own cleanup deletes without `force`. Under the same race that call throws
(37 times in 200 on Bun 1.4.2), and a path whose delete threw is not reported as
removed. It did not once return normally with the folder still there. A delete with
`force`, in product or test, can leave what it was asked to remove and say nothing.

**The lane, third run (`37616314179`, `6203c44`): all 22 jobs passed**, and `main` was
fast-forwarded again. **`main`'s run of it (`37617563689`) failed a different test**, on
Linux, in integration: `reviewer-cost.test.ts` pins the Auto reviewer's calls on a
six-action script at six, and counted five.

The pin was the fault. The background supervisor batches: observations waiting
together go to the reviewer in one call. With the reviewer scripted to take 400 ms,
six actions took three calls — and were all six shown. The test now holds what the
reviewer is shown (six actions before the widening, one after), which the requests
themselves say, and bounds the calls instead of pinning them.

**Seen in that experiment, and not changed: a headless run does not wait for its
supervisor.** `rune -P` ends with `process.exit`, and the queue is drained in the
background of a process that is leaving. With the same 400 ms reviewer, a script of
five supervised commands that finish at once had one of the five shown to the
reviewer, and no answer was recorded for it. The audit rows for all five read "allowed under
supervision"; no row says that nobody looked. A real reviewer takes seconds, so the
last seconds of any headless run are in this position. An interactive session is not:
it stays up and hears the verdict. Whether a headless run should wait a bounded time,
or write down what it left unread, is a decision about cost and exit time, and it is
the founder's.

**The lane, fourth run (`37620214639`, `c068d9e`) failed a third test, on Linux, in the
unit job.** `verifier-step-check.test.ts` lets the verifier run a real `go build` under
the verifier's own five-second deadline, and Bun's default limit for a test is the same
five seconds. On a cold toolchain the command used its whole deadline and the test was
timed out at 5,003 ms. In the same log `cargo check`, in the same file, took 4,792 ms,
and one interface test takes about four of its five seconds on every runner. All three
now have room above their own deadlines. What they assert has not changed.

Three flakes in three runs is the suite meeting a CI runner after weeks of not reaching
one, not three regressions: two of the three tests date from September. Each was
fixed at its cause — a forced delete that did not delete, a count that batching moves,
a limit equal to the deadline inside it.

To look for a fourth before CI found it, each suite was run once here under load: one
copy, default limits, the runner's environment, six processes burning CPU beside it.
Unit 7,388 pass and integration 454 pass, both about 1.4 times slower than unloaded,
and no test without a limit of its own took more than 3.9 seconds. (Several copies of
a suite at once prove nothing: they collide in the temp folder and in the checkout.)

**The lane, fifth run (`37626796403`, `6af2c02`): all 22 jobs passed**, and `main` was
fast-forwarded. **`main`'s run of it (`37628515211`) lost a fourth test to the same
clock**: the hook that packs the SDK, in integration on Linux, was stopped at 5,004 ms.

Two runs in a row lost to Bun's five-second default and to nothing else, so the
default itself was measured, on Bun 1.3.14 and 1.4.2. Every test and every hook gets
five seconds. `bun test --timeout`, which the Windows job passes for this reason,
raises it for tests and not for hooks: a six-second `beforeAll` still dies at five
under `--timeout 30000`. A default set in a preload raises it for both, and a file's
or a test's own limit still wins. The suite's preload now sets thirty seconds, the
Windows job's number, and the SDK hook has a limit of its own. A rough scan of both
suites found 53 hooks that start processes or wait on work with no limit; of the ones
read, that was the only one that builds anything. A test that hangs now fails after
thirty seconds instead of five.

**A second session resumed in this checkout at about 16:13**, after these commits. It
has uncommitted edits to `brief.ts`, `contract.ts`, `roundtrips.ts`, the parity rig and
three unit-test files. They are not in these commits and were not gated here.

**The lane, sixth run (`37632169994`, `3b688d4`): all 22 jobs passed. `main` and the
working branch were fast-forwarded to it, and `main`'s own run (`37633942430`) passed
all 22 as well.** The CI runs on record here go back to 27 September, and it is the
first green one on `main` among them.

Seven commits after the release, in order: `75dc589`, `4b09d54`, `fd92b9c`, `6203c44`,
`c068d9e`, `6af2c02`, `3b688d4`. One changes Rune — `75dc589`, the reader of the test
report. The rest change tests, one call in the benchmark rig, and the suite's preload.
Six lane runs and four runs on `main` were needed: a lane run that passes does not make
the next run pass while a test depends on the clock.

**Limits.** One green run on `main` is one run. Each of the four timing failures showed
up exactly once across that day's runs. The suite-wide limit takes the
five-second clock away as a cause; it does nothing about a count that batching moves or
a forced delete, wherever else one is relied on. The nightly run is the next evidence.

**Still open, each the founder's decision.** Whether the reader fix ships as 1.3.3.
Whether a headless run waits for its supervisor or writes down what it left unread.
Not decisions, only noted: the working row's squeezed phrase, and three test files
that set the terminal width and do not put it back.

## v1.3.3, 2026-10-07 · **shipped on the founder's word ("well then proceed")**

The reader fix was in the 1.3.2 binaries and on `main` unreleased. It is released.

- **Commit and tag.** `96bf372`, "release: Rune is 1.3.3": the same thirteen files a
  release touches, and nothing else. Tag `v1.3.3` there.
- **Gated before the tag.** The commit's exact content in a fresh clone: unit 7,377 pass,
  19 skip, 0 fail, and the repo-wide format check clean. Then the lane: run
  `37646340441`, all 22 jobs. `main` and the working branch were fast-forwarded only
  after that, and the tag pushed after them.
- **Published.** Release run `37648178456`, all 13 jobs. Eleven assets, marked Latest.
  The downloaded macOS arm64 pair matches `SHA256SUMS`, prints `Rune v1.3.3`, and
  contains the fix.
- **Installed here through `rune upgrade`**, not by compiling this checkout, which holds
  another session's unfinished edits: a build of it at the tag would have called itself
  1.3.3. The upgrade downloaded, verified and promoted; the installed binaries match
  the release's checksums; `doctor` and `tools-smoke` pass. The install it replaced was a
  dev build the other session had put there at 16:11 (`1.3.2-dev+4b09d54`), kept as
  `.backup`.

**What that first live upgrade of a source install found.** The launcher went on
warning that the build was older than its source tree, with the command to rebuild it.
`scripts/install.sh` leaves a record of the build beside the binary, the launcher reads
it on every start, and `rune upgrade` replaced the binary without touching the record.
The record is now moved aside with the build it described. Two tests; removing the call,
or deleting the record instead of keeping it, fails one. The stale record on this
machine was moved aside by hand the same way. Not released: it is on `main` for the
next version.

**Not done, and why.** The six-pair serious sitting was not started. It spends the
Codex window and needs the founder's numbers; and a second session is working in this
checkout on the same hard task, with its own rig changes uncommitted and a one-pair
manifest for a Claude Code arm on disk. Whether a headless run waits for its supervisor
is still the founder's decision. `rune doctor` on this machine gives one fact for it:
of 116 background screens, 15 raised a flag and none was confirmed.

## A run that ends before its reviewer answers, 2026-10-07 · **built and gated on this Mac; committed locally, not pushed**

**The founder's decision.** Asked what a headless run should do about a background
reviewer it does not wait for, the founder chose "Record it, don't wait": at exit, an
audit row for every action the reviewer never answered for; no added exit time and no
extra reviewer calls.

**What changed.**

- `supervisor-queue.ts`: the queue knows which batch is with the reviewer, and
  `abandon()` hands back that batch and everything still waiting, then admits nothing.
- `auto-mode.ts`: `abandonSupervisor()` turns those into one `supervisor_skipped` row
  each, joined to the action by `callId`, reason "the run ended before the reviewer
  answered for this action". An action whose screen has answered is left out. A verdict
  that lands after the abandon is not recorded and latches no halt.
- `engine.ts`: `close()` writes those rows before the store closes, for runs that ended
  with observations outstanding and for a run still in its turn (quitting mid-run).
- `auto-metrics.ts`, `bin/audit-cli.ts`: `rune doctor` and `rune audit` print "actions
  that ran with no background review: N" when N is above zero. **The count had been
  taken and never printed**: until now a skipped review could be found by SQL only.
- Docs: `docs/auto-mode.md` ("A run that ends first"), `CHANGELOG.md` (Unreleased).

**Verification, exact.**

- Orchestrator type-check: exit 0. Format check on the twelve changed files: clean.
- `supervisor-queue.test.ts` 12 pass; `auto-metrics.test.ts` 11 pass;
  `engine-auto-mode.test.ts` 14 pass; the seven Auto-mode unit files together 180 pass,
  0 fail.
- `tests/integration/reviewer-cost.test.ts` (six real `rune -P` runs against the mock):
  10 pass, 0 fail. Its new arm: five commands, a reviewer that takes thirty seconds, the
  run not held up; the reviewer asked once; five `supervisor_skipped` rows whose calls are
  exactly the five commands, and they are the last rows the run wrote.
- Mutations, nineteen, all caught in the end. Thirteen in the queue and Auto mode: four
  survived the first pass (an answered action reported again, a batch never cleared, the
  wrong reason after the abandon, the confirm stage ignoring it); two tests were added
  for them and one made stricter. Two on the printed line. Four in the engine: three caught by the
  real-process test; "close ignores the run still in its turn" survived until an
  engine-level test was added.
- **After the sitting ended, in a fresh clone at `66aa98f`** (so without the other
  session's uncommitted edits): type-check 15 of 15 packages; repo-wide format check
  clean; unit 7,387 pass, 19 skip, 0 fail; the reviewer-cost file 10 pass.
- **Not run:** the full integration suite, and anything on Linux or Windows. Nothing is
  pushed, so the lane has not run it.

**What the real-process arms showed, beyond the change.**

- It happens on an ordinary fast run, not only a slow reviewer: in the `reverted` arm
  (five commands, a mock reviewer that answers at once) the process was gone before the
  answer for the fifth command was back. That arm now ends with one unanswered row, and
  an older test that counted every `bash` row as a decision had to be taught the
  difference.
- **A background review that fails leaves no row either, and that is not changed.** In
  the `all` arm the reviewer is called six times and its answer cannot be read as a
  screen verdict; six actions keep "allowed under supervision" and nothing says the
  review came to nothing. The same holds for a reviewer that is unreachable or times
  out. Only an in-process counter moves. Recording it would be the same kind of row;
  it was not the question the founder was asked.

**Limitations.** A killed process writes nothing. v1.3.3's release note lists this gap
as open, which is true of 1.3.3: the change is unreleased.

**Next step.** The founder's word to push: lane first, then `main`, as before. Then the
full suites in a fresh clone. Whether to record a failed background review the same
way is theirs to decide.

## The serious sitting on 1.3.3, 2026-10-07 · **ended at three scored pairs: the Codex window ran out**

**Authorised by the founder** for this run: six hard tasks, Rune 1.3.3 against OpenCode,
both `gpt-6-sol` on the Codex subscription, stop at 70% of the window. Manifest
`docs/evidence/b2-s4-serious-manifest-20261006.json`; result summary
`docs/evidence/b2-s4-serious-result-20261007.json`; raw evidence in
`~/rune-evidence/b2-s4-serious-20261007`. Rune ran from a clean clone at the tag.

**Result: PROVISIONAL, PI 96.0 on three pairs.** O 100, R 100, S 80, E not scored (it
needs four pairs where both succeed). Six scored pairs are needed for a status.

| Task                   | Arm      |   Hidden | Regressions | Scope |  Wall | Calls | List cost | Ended          |
| ---------------------- | -------- | -------: | ----------: | ----: | ----: | ----: | --------: | -------------- |
| model-catalog-cache    | Rune     |    17/17 |           0 |   0.5 | 449 s |    23 |     $0.45 | incomplete     |
|                        | OpenCode |    17/17 |           0 |   0.5 | 304 s |    27 |     $0.39 | completed      |
| header-version-session | Rune     |      4/4 |           0 |   0.5 | 511 s |    39 |     $1.03 | incomplete     |
|                        | OpenCode |      4/4 |           0 |     1 | 425 s |    42 |     $0.95 | completed      |
| startup-selection      | Rune     |    15/15 |           0 |     1 | 422 s |    27 |     $0.66 | incomplete     |
|                        | OpenCode |    15/15 |           0 |     1 | 424 s |    40 |     $0.69 | completed      |
| tilde-user-home        | Rune     | unscored |             |       | 179 s |    18 |     $0.39 | refused: quota |
|                        | OpenCode |      3/3 |           0 |   0.5 | 226 s |    15 |     $0.31 | completed      |

Not started: `toml-config`, `checkpoint-report-matches-prune`.

**The window, and the approval it went past.** The founder approved about 60 points of
the five-hour window with a stop at 70%. The window went from 7% to 99% in 47 minutes
and refused Rune's fourth run; it resets at 02:11 IST on the 8th. The weekly window went
from 34% to 48%. Two causes, both measured:

- A second Rune session, in `~/Project/Alantests`, made 185 calls on the same
  subscription during the sitting. The sitting made 231.
- The rig checks the stop line between pairs, against the last reading Rune's own arm
  carried. OpenCode's runs carry none. The check before the fourth pair read 59%; the
  window stood at 78%.

**What the runs showed.**

- **Correctness: nothing between them.** Both passed every hidden check on the three
  scored tasks with no regression.
- **Rune called three finished runs unfinished.** Its verdict was "unmet: no criteria
  stated" once and "partial" twice, over criteria it had inferred and never assessed,
  with exit code 1 on those two. The index counts completion by the hidden checks, so
  this costs no points. A person or a script reading Rune's answer is told the work is
  not done.
- **The end-of-turn check timed out on two of three.** `bun run test` hit the 120 s
  limit and measured nothing. This is the parked founder decision, now with two live
  cases.
- **A failure that was there before the run was handed to the agent.** On the first
  task the suite was red on one test in a file the run had not touched, for want of a
  built web app. Rune asked for a fix, and the agent rewrote the repository's `test`
  script in the root `package.json` to build the web app first. The hidden checks do
  not look there. Why the baseline replay did not call that failure existing is **not
  established**.
- **Scope.** Rune left generated files behind twice, mostly `.turbo/cache` and package
  build output: once after the timed-out check, which removed nothing, once from
  commands run outside the check. OpenCode left a web build behind once.
- **Calls and cost.** Rune made fewer calls on all three (23/27, 39/42, 27/40), at
  about the same list cost (1.14×, 1.09×, 0.94×), and took longer on two (1.48×, 1.20×,
  1.00×). On 2026-10-05 one hard task took Rune 38 calls to OpenCode's 19.

**Limitations.** Three pairs, one run each. Every task is F7, mined from Rune's own
history. Wall time carries noise: focused tests ran on this machine during the first
two pairs, and the second session was calling the same provider throughout. The build
is 1.3.3; another session's uncommitted work on completion verdicts is not in it.

**Next step.** No live run without a new go-ahead. Zero spend, on the kept run trees:
replay the verifier on the first task to learn why the pre-existing failure was not
called existing. For the rig: read the window before each arm, from every source on the
machine, not only Rune's last row. The three pairs still owed need the founder's word
and a window nothing else is spending.

## Parity-plus plan, Stage 0, 2026-10-08 · **one cause not yet named; the reason is now recorded**

**The plan.** The founder named four weaknesses (cost, latency, design and architecture
output, interface polish) and approved a staged plan on 2026-10-08: Stage 0 land what is
built, A the end-of-turn check, B cost, C design quality, D the interface, E proof and a
release. The measured target is OpenCode = 100 on the same model; "95 against Claude
Code" cannot be measured while benchmarks stay on the Codex subscription.

**What the three kept runs say about time and cost** (read from each run's own log; no
new spend).

| Task                   | Rune working |             Rune's checks and repair | Rune total | OpenCode |
| ---------------------- | -----------: | -----------------------------------: | ---------: | -------: |
| model-catalog-cache    |        203 s | 44 s check, 161 s repair, 42 s check |      449 s |    304 s |
| header-version-session |        390 s |                     120 s, timed out |      511 s |    425 s |
| startup-selection      |        297 s |                     124 s, timed out |      422 s |    424 s |

- Rune's own loop was faster on all three. The end-of-turn check and one repair of a
  failure the run did not cause were 36% of its wall time.
- Rune's first prompt is the size of OpenCode's (about 12k tokens). What still costs
  more: the cached prefix changes on most of calls 2–8, so call 2 re-pays the whole
  prompt (cached share 87–95% against 95–97%); the safety reviewer was 12% and 29% of
  two runs' cost; the repair above re-paid 43k tokens in one call.
- **Effort routing is on in the shipped defaults.** The first run's incident log reads
  "ordinary turns run at medium under a high ceiling". A candidate for why design work
  comes out weaker than the same model elsewhere; to be tested in Stage C, not assumed.

**The replay: why was a failure that predated the run handed to the agent?** Rune's
verifier from this checkout, on a copy of the first task's tree put back as it stood at
the run's first check. No model, no network.

- Standalone, it answers correctly: two failing tests, both existing, none introduced.
  It would have asked for no repair. The comparison takes 81 s there; the live check
  took 44 s, so **in the live run the starting tree was never run**: the comparison
  gave up before that.
- Ruled out as the reason, each by its own run: the benchmark's profile variables (same
  two failures with them set); the commands the agent ran before the check (answer
  still known after them, from a plain shell); the snapshot not being asked for (the
  engine passes the verifier that takes it).
- **Not established:** which of the comparison's early exits the live run took. The
  reason was computed and dropped: no event, no log line and no state field carried it.
  Still open: something Rune's contained shell or file tools write into a git-ignored
  path (read as "the environment changed"), or a snapshot that failed under load.

**Changed, so the next run names it.** A failed check whose origin could not be told
now carries the reason: in the notice a person reads, on `verification_completed` as
`attributionUnknown`, and in the saved task state. The repair message the model gets is
word for word what it was.

- Files: `packages/protocol/src/events.ts`, `packages/orchestrator/src/agent-loop.ts`,
  `packages/orchestrator/src/task-state.ts`, two test files, `CHANGELOG.md`.
- Verification: orchestrator and protocol type-check exit 0; format check clean;
  `verification-baseline.test.ts` 61 pass, `task-state.test.ts` 46 pass, five related
  files together 234 pass. Six mutations, all caught; one survived a first pass (the
  reason kept on a result that is not a failure) and a test was added for it.
- Not run: the full suites, Linux and Windows. Committed locally, not pushed.

**The other session's uncommitted work is not the verdict fix.** It copies explicit
"must / do not / never / keep" sentences from the request into the read-back reply and
carries them as constraints, which is aimed at the regression on the config task. Its
251 tests pass; `explicit-requirements.ts` fails the format check. Left untouched: it
was approved for landing on a wrong description of it, so it waits for the founder.

**Also seen.** The repair message shows the model the head of the report only: here the
first 1.6k characters of 360k, which was the first failure in file order.

**Next step.** A zero-spend reproduction through a real `rune -P` process with the mock
model replaying the first task's tool calls, to read `attributionUnknown`. Then Stage A
in order: A4 (fix what it names), A1–A3, A5. No live run without the founder's word.

## A4: a failure that predates the run, 2026-10-08 · **cause named and fixed; committed locally**

**The cause.** The real-process reproduction (a real `rune -P`, the mock model
replaying the first task's tool calls, no provider reachable) read the reason the
previous card started recording: "something failed that the report does not name as a
test". Bun closes a run of more than about twenty tests by listing the failures a
second time, under "N tests failed:". `parseBunTestRun` counted those lines as two more
failing tests, in whichever file ran last. Four failures against a total of two is a
report the comparison refuses, so it never ran the starting tree and the agent was
asked for a repair.

**Its reach, measured with Bun 1.3.14.** The closing list appears at 22 tests and not
at 21; with one test file as with forty; in an ordinary terminal and inside GitHub
Actions; and **not** in an agent's shell, where Bun prints a shorter report. So in
1.3.2 and 1.3.3 the rule "a failure that was already there is left alone" did not work
for any real Bun suite outside an agent's shell. Every test of it passed here because
this machine's tests run inside one, on fixtures of two files.

**The fix.** `packages/orchestrator/src/check-failures.ts`: lines between a closing
list's header and the next file's header are not read as tests.

**Verification, exact.**

- `verification-baseline.test.ts` 63 pass, 0 fail. Two new tests: Bun's own closing
  list, verbatim; and thirty real test files through the real verifier with the report
  a terminal gets. Three mutations, all caught, the first by both tests.
- **End to end, zero spend:** the same real-process reproduction on the first task's
  tree. Before the fix: "Verification failed — asking the agent to fix it. Whether
  these failures were there before this run could not be told: something failed that
  the report does not name as a test", then a second forced attempt. After: `preexisting:
true`, "2 tests were already failing before it began … Nothing new failed. They were
  left as found", no repair turn, and `package.json` untouched.
- Orchestrator type-check exit 0; format check clean on the changed files.
- Not run: the full suites, Linux and Windows, and Bun 1.4.2 (what CI installs).
  Nothing is pushed.

**What this is worth on the first task.** The repair it bought was 161 s and a second
42 s check, of 449 s, and the call that re-paid 43k tokens. Not measured live.

**Limitations.** Only Bun's report is read at all; a failing suite under another
runner has always been "unknown". A test that prints a closing-list header of its own
hides later failures in that same file only, and the result is then "unknown", never a
wrong answer.

**Next step.** A1–A3 (the 120 s wait that measures nothing, and the verdict that calls
finished work unfinished), then A5.

## v1.3.4, 2026-10-08 · **shipped on the founder's word ("Push and release 1.3.4")**

**Why a release.** A4 above is a fault in the 1.3.2 and 1.3.3 binaries: the rule that
leaves an already-failing test alone did not work for a real Bun suite. The founder was
asked what to do with the six local commits and chose to push and release.

**What is in it.** `ab9ea0c` (the closing list), `68d05d6` (the reason an unknown
comparison gave up), `e630e9f` (a run that ends before its reviewer answers), `ec1bb5e`
(upgrade over a source install), and the evidence and ledger commits between them.
Release commit `75e6a53`, the usual thirteen files; notes in `docs/releases/v1.3.4.md`.

**Gated before the tag, on the release commit itself.**

- A fresh clone: type-check 15 of 15 packages; repo-wide format check clean; unit
  7,394 pass, 19 skip, 0 fail; the two verification files again with the report a
  terminal gets (`AGENT=0`), 90 pass; the reviewer-cost file 10 pass.
- The lane: run `37742101128`, all 22 jobs, macOS, Linux and Windows.
- Only then `main` and the working branch were fast-forwarded and the tag pushed.

**Published.** Release run `37743503209`, all 13 jobs. Eleven assets, marked Latest.
`main`'s own run `37743499249`: all 22 jobs. The downloaded macOS arm64 pair matches
`SHA256SUMS`, prints `Rune v1.3.4`, and contains the three changes.

**Installed here through `rune upgrade`.** The installed binaries match the release's
checksums, and no stale build record was left behind — the upgrade fix from `ec1bb5e`,
seen working on its first real use.

**Stated in the notes as not changed:** the verdict that calls finished work "unmet" or
"partial"; the 120 s end-of-turn check that measures nothing on a longer suite; a failed
background review leaving no row. None of the fixes was measured in a live run.

**Next step.** Stage A continues: A1–A3, then A5. This entry is committed locally and
goes out with the next push.

## A1 and A2: a check that cannot finish, 2026-10-08 · **built and gated on this Mac; committed locally**

**The demonstrated problem.** On two of the three live runs the end-of-turn check
started the project's whole suite, killed it at 120 s, and reported that nothing was
measured: 244 s of 1,382 s. On a project whose suite takes longer than the limit that
is every turn; Rune's own repository is one (its unit suite takes about 200 s here).

**What changed** (`verifier.ts`, `agent-loop.ts`, `engine.ts`).

- **A command that fails to finish twice in a row is not started a third time**, for
  that workspace, under that limit, for a day. The answer is the same "did not finish,
  nothing measured", without the wait; the report says `not started` and when it last
  ran. Twice, because once can be the machine. A longer `[verify] timeoutSecs`, a day
  passing, or finishing once runs it again. Kept in the Rune home
  (`verify-slow.json`), never in the workspace.
- **When it is a `bun test` suite, the test files the change wrote are run in its
  place**, with a minute to finish. Green is a recorded passing check for those files.
  Red is a failed check like any other and is handed back. The verification as a whole
  stays `inconclusive`.
- **The finish gate counts that run.** With those files run and green, the agent is no
  longer told it "never executed anything" and sent to run them again.
- The notice says which happened: hit its limit, or not started; and whether the
  touched tests ran in its place.

**What it does not do, on purpose.** It never calls an unfinished suite passed. It does
not shorten any limit. It does not guess file arguments for vitest, jest or any runner
but `bun test`, and it does not replace a check that is not the test suite.

**Verification, exact.**

- `verifier-slow-check.test.ts`, new: 9 pass. `verification-inconclusive.test.ts`:
  32 pass. Nine related verifier and loop files together: 330 pass, 0 fail, run again
  after the two-in-a-row rule was added.
- Mutations: 12 on the memory and the fallback, 3 on the notice, 2 on the gate, then 6
  after the two-in-a-row rule (3 new, 3 repeated). All caught; one on the notice
  survived a first pass and an assertion was added.
- **End to end, zero spend:** three real `rune -P` runs with the mock model on a
  project whose suite cannot finish in a four-second limit, one Rune home between
  them. 6.8 s and 4.7 s (waited, touched test run and green), then 0.6 s (not
  started, touched test run and green). The workspace held the run's edit and nothing
  else.
- Orchestrator type-check exit 0; format check clean on the changed files.
- Not run: the full suites, Linux and Windows. Not measured live.

**What it will and will not move.** A first run in a fresh workspace still waits the
limit once, and a benchmark task is always that; so the three kept tasks would not get
faster from this. What they would get is a measurement where there was none. A person
working on one project stops paying two minutes a turn after the second.

**A5 is not what it looked like.** The generated files Rune left behind on two runs
were made by commands the agent itself ran, not by the check. Rune removes what its
own checks generate and, by the founder's decision of 2026-10-05, nothing else.
Removing what the agent builds would delete output a person asked for. Left as it is;
the scope loss on those runs stands.

**A3 is still open.** The verdict that says "unmet: no criteria stated" on passing work
is what the acceptance spec makes it say; the cases seen need a rule that does not
weaken it.

**Next step.** A3, then Stage B (the cached prefix that changes on calls 2–8).

## B1: the cache that was thrown away at the second completion, 2026-10-08 · **built and gated on this Mac; not measured live**

**What the kept runs show, corrected.** The earlier entry said the cached prefix "changes
on most of calls 2–8". That read the wrong number: `prefixHash` covers the whole request
and changes on every call by construction. Read from the provider's own cached-token
counts instead, call by call:

- **Call 2 reads 0 cached tokens on all three runs** and pays 12.2k, 14.5k and 17.7k
  fresh. The system prompt is 25.6k characters on call 1 and 22.8k from call 2 on.
  OpenCode's call 2 on the same task: 368 fresh, 11,008 cached.
- Calls 5–8 pay 8–14k fresh each because the agent had just read that much; those are
  the work, not a loss.
- One call after a repair request re-paid 43k (4,480 cached). A4 removed that request.

**The cause** is a deliberate one: the doctrine phase. Turn 1 carries the opening
doctrine and turn 2 onward a working one about 700 tokens shorter, "so the prefix
changes exactly once per request". Where nothing is cached that is a saving. Where a
prefix is cached, the one change costs the whole prompt once to save 700 cached tokens
a call; it pays back after about 150 calls, and the runs made 23 to 39. On the third
run the loss was 14% of all the fresh input it paid for.

**The change.** `cachesStablePrefix(provider)` in `cache-policy.ts`: Anthropic, Codex,
and every host whose declared policy is not `none`. On those the loop keeps the opening
system prompt for the whole request, which is what every request was before the phases
existed. On the rest nothing changes.

**Verification, exact.**

- `agent-loop-fold-prefix.test.ts`: on five caching hosts every request of a run
  carries one system prompt; on three hosts that cache nothing the second request on
  carries the shorter one. `cache-policy.test.ts`: the predicate against the table.
  With `doctrine-modes-routing.test.ts`, 27 pass. Sixty-two prompt, doctrine,
  agent-loop and cost files together: 479 pass, 0 fail.
- Four mutations, all caught.
- Gateway and orchestrator type-check exit 0; format check clean.
- **Not measured:** what the provider then caches. The prediction is that call 2 reads
  about what call 1 sent. It will be read off the next approved live run. Whether the
  change of reasoning effort between call 1 and call 2 (effort routing) also costs
  anything is not isolated.
- Not run: the full suites, Linux and Windows.

**B2, the safety reviewer, is the founder's.** It was 12% and 29% of two runs' cost
because it runs on the heavy tier, about five times the session model's price, by
default: about 8.6k fresh tokens a call. Moving it to a cheaper model is a weaker
review to save money, which the standing rules do not let this work decide.

**A3, recorded and deferred.** The verdict "partial" on the two runs came from criteria
the model itself stated and never cited a check for, though passing checks were on its
own record. The rule that fits the acceptance spec is one request before the finish
— "cite what settles each, or say what could not be shown" — with the runtime still
pricing every citation. It adds a completion to every such run, and whether models
then cite cannot be shown without a live run. Not built until one is allowed.

**Next step.** B3 and B4 need a live allowance (small tasks re-measured). Stage C
starts with the design A/B, which also needs one. Zero-spend work left: the rig's stop
line, and the interface audit (Stage D1).

## B1 measured live, and corrected, 2026-10-08 · **the cause was reasoning effort; fixed and confirmed on the provider**

**Authorised by the founder** for this run: re-run the three hard tasks on the new
build against OpenCode, six agent runs, stop at 70%. Summary in
`docs/evidence/b2-s5-serious-rerun-result-20261008.json`.

**The plan was wrong in one number, and the series stopped after one pair.** A wall
allowance of 100 minutes was given; a serious pair may take 90; the rig will not start a
pair that might not fit. Two agent runs of six were used. The other two tasks were run
afterwards on the fixed build (next entry).

**What the one pair showed** (header-version-session; both passed 4/4, no regression).

- **A1 as designed.** Fresh workspace, so the suite was waited for once, 120 s, and
  measured nothing; then the three test files the change touched were run in its place
  and pass.
- **B1 did not do what the last entry predicted.** One system prompt on every call
  (25,617 characters), and the second request still read 0 cached tokens and paid for
  15,159. OpenCode's second request: 456 fresh, 12,032 cached.
- The reviewer: three screens on `gpt-6-astra`, about 8k tokens in and 5 to 26 out,
  $0.08 each, 22% of the run's cost.
- Rune 566 s and $1.08; OpenCode 380 s and $0.78. The day before, same task: 511 s and
  $1.03 against 425 s and $0.95. One run each.

**The cause, by a controlled probe.** One small task, four requests, `gpt-6-sol` on
Codex, runs that differed in one thing. Fresh tokens, then cached:

| Request | One effort throughout | Turn 1 high, then medium | After the fix, shipped defaults |
| ------- | --------------------- | ------------------------ | ------------------------------- |
| 1       | 10,535 · 0            | 10,534 · 0               | 10,539 · 0                      |
| 2       | 364 · 10,368          | 10,734 · 0               | 351 · 10,368                    |
| 3       | 276 · 10,624          | 278 · 10,624             | 264 · 10,624                    |
| 4       | 311 · 10,752          | 313 · 10,752             | 300 · 10,752                    |

A request sent at a different reasoning effort from the one before it reads nothing
from the Codex cache. Effort routing — shipped on, and never validated live — changed
the effort at turn 2, again at the first sign of difficulty, and again when the checks
passed.

**The fix** (`81a321e`). `effortChangeCostsCache(provider)`: Codex, the one host
measured. There every turn runs at the ceiling and `[llm] effortRouting` has no effect.
Elsewhere routing is unchanged. Confirmed on the provider: third column above.

- Verification: `agent-loop-effort-routing.test.ts` and `cache-policy.test.ts`, 22 pass;
  sixty-one loop, doctrine, effort and cost files together 483 pass, 0 fail; three
  mutations, all caught; type-check exit 0.
- **What this also changes, unmeasured:** on Codex ordinary turns now reason at the
  ceiling where they reasoned a notch below it. OpenCode's arm in this rig has always
  run at high. More reasoning tokens a turn, and possibly better work; neither is
  measured yet.

**What is kept from the earlier change.** One system prompt per request on caching
hosts: a changed system prompt cannot match a prefix written with the old one. What it
is worth on its own has not been isolated, and the docs now say so.

**CI.** The first lane run on these commits failed on two jobs. Windows: a new test
sat behind a thirty-second sleep that Windows does not stop when a check is killed at
its limit — fixed in the test (`6062e89`), and **recorded as a finding: on Windows a
check's time limit does not end the check.** macOS: one older test that takes 0.6 s
took sixty on a runner that was slow across several files; it did not repeat. The
second lane run, `37785365607`, passed all 22 jobs.

**Not done.** The full local suite: this Mac slept on battery from 14:18 and the run
only advanced in twenty-second dark wakes. CI is the gate that ran it.

**Next step.** The two tasks left, on the fixed build (running). Then `main`.

## The fixed build on the two tasks left, 2026-10-08 · **each change does what it says; the bill is not lower**

The four agent runs left of the six the founder approved. Summary in
`docs/evidence/b2-s6-serious-fixed-result-20261008.json`. Rune from a clean clone at
`81a321e`. Both tools passed every hidden check on both tasks, no regression.

| Task                                           | Tool     | 2026-10-07               | 2026-10-08               |
| ---------------------------------------------- | -------- | ------------------------ | ------------------------ |
| model-catalog-cache                            | Rune     | 449 s · 23 calls · $0.45 | 240 s · 15 calls · $0.25 |
|                                                | OpenCode | 304 s · 27 calls · $0.39 | 200 s · 23 calls · $0.34 |
| header-version-session (before the effort fix) | Rune     | 511 s · 39 calls · $1.03 | 566 s · 37 calls · $1.08 |
|                                                | OpenCode | 425 s · 42 calls · $0.95 | 380 s · 40 calls · $0.78 |
| startup-selection                              | Rune     | 422 s · 27 calls · $0.66 | 573 s · 39 calls · $0.89 |
|                                                | OpenCode | 424 s · 40 calls · $0.69 | 328 s · 28 calls · $0.63 |

**What is shown, each by its own mark.**

- **The cache.** Rune's second request was served from the cache on both tasks (11,776
  and 11,648 cached tokens; 0 the day before on all three), and no later request lost
  it.
- **A failure that predates the run (A4).** Same task, same two red tests as the day
  before. The check said `preexisting`, the notice named both, no repair was asked
  for, and `package.json` was left alone. 15 calls and $0.25, where it had been 23 and
  $0.45; cheaper than OpenCode's run.
- **A check that cannot finish (A1).** A first run in a fresh workspace still waits
  the limit once, as designed: 120 s on two of the three tasks. The touched test files
  were then run and pass.

**What is not shown.** That Rune is faster or cheaper overall. Three tasks, one run
each: Rune $2.21 and 1,379 s, OpenCode $1.76 and 908 s; the day before, $2.14 and
1,382 s against $2.03 and 1,153 s. OpenCode was faster on all three than the day
before, and Rune's own working time went from 890 s to 1,042 s. Call counts do not
repeat: Rune 27 then 39 on one task, OpenCode 40 then 28 on the same one. The swing
between two days is larger than anything these changes could do to a total.

**Where Rune's time and money still go, from these runs.**

- **The 120 s wait in a fresh workspace:** 250 s of 1,379 s. Nothing here removes it
  on a first run.
- **The reviewer on the heavy model:** $0.38 of $2.21. The founder's decision.
- **Reasoning at the ceiling on every turn**, since the effort fix: more output tokens
  a call. Whether the work is better for it is not measured.
- **The verdict:** all three finished runs were again called unfinished.

**The Codex window.** Rune's meter read 61% at the end (55% before the first pair).
Three small probes and six agent runs.

**Next step.** `main`, once the lane run on these commits is green. Then, zero spend:
the interface audit. For the founder: the reviewer's model, the 120 s limit, and a
live sitting large enough to measure a total (several runs a task).

## D1, the interface audit: the idle screens, 2026-10-08 · **first page; nothing changed**

`main` is at `ea19e90`, gated on the lane (run `37790154492`) and green on its own run
(`37792013894`), pushed on the founder's word. Not released.

**How the frames were taken.** `python3 scripts/tui-capture/capture.py OUTDIR`, the
repo's own rig: the real entry point through a real pty, no model call possible. It
wrote 17 frames and then stopped on one of its own assertions.

**Defects, measured on the frames, most visible first.**

1. **The legend under the session view names Esc twice, with two meanings:**
   `ctrl+f back · esc composer · esc back`. `panelHint` in `agents-panel.ts` writes the
   first two and `agentsLegend` in `tui.ts` adds the third.
2. **Three right edges on one screen.** The header rule is the width less 3 (77, 97 and
   117 columns at 80, 100 and 120); the composer's two rules are the width less 4; the
   rule under `SESSION` is the width less 5.
3. **Two rows begin with `›`:** the composer and the gear line under it. The second is
   a status, not a prompt.
4. **The two opening lines disagree in form:** `try  "…" · "…"` and
   `tip: … -- /memory` — a colon on one and not the other, `--` where the rest of the
   screen uses `·` and `—`.
5. **A description that does not fit:** in the command list at 80 columns `/login`
   ends `…, or web sea…`.

**The rig is older than the interface.** It asserts the overlay says `esc close`,
which it no longer does, so its last two captures (the terminal restored after
SIGTERM, and the window too small to draw in) were not taken. Its `100x30-panel` and
`99x30-collapsed` frames are of a side panel that the single-column default removed.

**Not yet looked at, and the larger half:** a run in progress — tool rows, a check
running and timing out, a held step, an error, a quota stop, the closing verdict, the
sub-agent cards. The rig types nothing into the composer by design. Capturing those
needs the same pty driven against the mock model, as the real-process tests are.

**Next step.** The founder picks from this page; items 1 and 2 are defects whatever
the taste, and are small. Then the run-in-progress frames.

## C1, the design comparison, 2026-10-08 · **Rune's pages are not worse; they cost four times as much to make**

**Authorised by the founder** ("the codex has room, you can proceed", then: up to 85%
of the weekly window). The founder's report was that Claude Code, the Codex CLI and
OpenCode all gave better designs than Rune on the same model. Claude Code is not run:
benchmarks stay on the Codex subscription.

**What was run.** Three build-from-nothing prompts (a landing page, an analytics
dashboard, a task tracker to be organised for a second developer), each to Rune at
`622b212`, OpenCode 1.18.30 and the Codex CLI 0.160.1, all `gpt-6-sol`, each in an empty
git repository, fifteen minutes allowed. Nine runs, one each. Raw results and a page
for a blind pick in `~/rune-evidence/design-ab-20261008/` (`index.html`; the letters are
shuffled per prompt and the key is `key.json` beside it).

| Prompt       | Rune                     | OpenCode                 | Codex CLI     |
| ------------ | ------------------------ | ------------------------ | ------------- |
| Landing page | 533 s · 56 calls · $1.40 | 283 s · 7 calls · $0.27  | 190 s · $0.61 |
| Dashboard    | 463 s · 47 calls · $1.02 | 230 s · 9 calls · $0.29  | 227 s · $0.68 |
| Task tracker | 412 s · 54 calls · $0.95 | 183 s · 11 calls · $0.24 | 123 s · $0.63 |
| Total        | 1,408 s · $3.37          | 696 s · $0.81            | 540 s · $1.93 |

All three Rune runs ended "partial" with exit code 1. The other six ended clean.

**What the screenshots show.** All nine render; none is broken. To this reader the
three tools' pages are of one class, and the differences between them are smaller than
the differences in what they cost. **The founder's pick, blind, is the measurement; it
has not been made yet.** This run was on a build where every turn on Codex reasons at
the ceiling (since `81a321e`); before today ordinary turns ran a notch lower, which may
be part of what the founder saw.

**Where Rune's calls went, from the landing run's own log** (43 tool calls, 8.6
minutes).

- **One minute before any work:** a design skill and its twenty-genre catalogue, two
  web searches and three fetches of other companies' sites, an art-direction question
  with nobody there to answer it, a read-back, a plan.
- **Three minutes of work:** three files written. Three calls.
- **Five minutes and 25 calls reviewing a page it could not see.** No browser is
  mounted, so the run is told to "plan the visual step as a fetch of the served page"
  and is held to it: it started a local server, fetched its own files with curl, and
  parsed its own HTML with Python scripts five times. The finish was refused once ("UI
  was written but never viewed") and closed with "UI review incomplete".
- **The safety screens:** 8 to 12 a run, on the session's model since `622b212`, $0.18
  to $0.26 a run. On the landing run three flags went to the heavy model to be
  confirmed, $0.39 more. Most of what was screened was the serving and fetching above.

**The reviewer change, seen live.** Screens ran on `gpt-6-sol`; confirmations on
`gpt-6-astra`.

**Proposed, not built: with no browser, do not demand a review that cannot see.** Say
once that the layout was not seen; do not tell the run to serve, fetch and parse in
its place; do not refuse the finish for it. And in a headless run, choose an art
direction and state it, without asking. It relaxes the product-sight gate where no
browser exists, so it is the founder's to approve.

**Limitations.** One run a prompt. Three prompts, all small and all static. Nothing
here measures a multi-page application or a project with a build.

## C2 measured: the no-browser change on the same three prompts, 2026-10-09 · **a third less time and money; still dearer than both, still exit 1**

**The change** (`19b127d`, on the founder's choice "Stop the stand-in review"): with no
usable browser the visual review is `unseen` — nothing is asked, nothing is claimed,
the finish is not refused, one notice says the layout was not looked at. A headless
design run is told nobody is there to answer. With a browser nothing changes. Before
it, the founder's other choice of the evening: the background screen on the session's
model (`622b212`).

**Measured.** Rune alone, the same three prompts, a clean clone at `19b127d`,
`gpt-6-sol`; the other two tools' runs of the evening before stand as the comparison.
Raw results in `~/rune-evidence/design-ab2-20261008/`.

| Prompt       | Rune before                 | Rune after                  | OpenCode                 | Codex CLI     |
| ------------ | --------------------------- | --------------------------- | ------------------------ | ------------- |
| Landing page | 533 s · 56 calls · $1.40    | 369 s · 27 calls · $0.65    | 283 s · 7 calls · $0.27  | 190 s · $0.61 |
| Dashboard    | 463 s · 47 calls · $1.02    | 407 s · 39 calls · $1.13    | 230 s · 9 calls · $0.29  | 227 s · $0.68 |
| Task tracker | 412 s · 54 calls · $0.95    | 242 s · 36 calls · $0.55    | 183 s · 11 calls · $0.24 | 123 s · $0.63 |
| Total        | 1,408 s · 157 calls · $3.37 | 1,018 s · 102 calls · $2.33 | 696 s · $0.81            | 540 s · $1.93 |

- In all three the serving and fetching is gone, no finish was refused, no
  art-direction question was asked, and each ended on one "UI not viewed" notice.
- Time down 28%, calls down 35%, cost down 31%. Against the Codex CLI Rune is now
  1.2 times the cost (it was 1.7); against OpenCode 2.9 times (it was 4.2).
- **All three still ended "partial", exit code 1.** The criteria the model states for
  itself — keyboard access, a responsive layout — cannot be shown without a browser,
  and stay unassessed.
- The dashboard did not get cheaper. Three in-path reviews on the heavy model, $0.32
  together, were spent on scripts the model wrote to check its own work.

**The first attempt at this measurement was void.** Started at 18:23Z as the Codex
window reset, and the Mac went to sleep: three runs of 15 to 26 minutes with their
responses cut off mid-stream and no file written. Seen in the power log, discarded,
run again with the machine awake.

**Where the rest of the gap is, from the three logs.** A design skill, a read-back,
four plan updates and one or two evidence records in every run; one web search and
one or two fetches for references nobody supplied; three to seven shell calls of
self-written checks; five to seven safety screens. OpenCode writes the files and
stops.

**The Codex window.** Five-hour 21%, weekly 72%, read off the last run.

**Limitations.** One run a prompt, before and after. The comparison runs are a day
older than the "after" runs. The pages were not looked at again side by side.

**Next step, the founder's:** whether a small build should carry less of that
ceremony, and what a run that could not show its own criteria should exit with.

## The cost-and-latency lane, 2026-10-13 → 14 · **built and gated on this Mac in a worktree; fifteen commits, local; nothing measured live**

The founder's instruction: take the plan Codex wrote with `gpt-6-astra` ("Rune: cost and
latency execution proposal", cards E0 to E5), leave its Haiku and Sonnet assignments,
and fix the problem. Done on `lane/cost-latency-20261013` in
`.claude/worktrees/cost-latency-20261013`, from `0fe45a7` — Codex's snapshot of `2dabdb2`
plus the working tree as it stood (22 modified, 13 untracked), checked byte for byte
against the live tree. The main checkout was not touched. No model was called, nothing
was pushed, nothing was installed.

**Where the time and money were**, read from the databases of fifteen recorded runs
(nine serious, six UI):

- **The end-of-turn check:** 915 s of the nine serious runs' 4,026 s. Six of the nine
  ended on a check killed at 120 s — 745 s, between 16% and 43% of each of those runs.
- **The reviewer:** $0.568 of the three UI runs' $2.33. Three reviews in the path of an
  action were all false alarms: `render` and `delete` as words in a script, and a URL
  with `/post/` in it.
- **Completions that only kept the ledger:** 80 of 445 (18%) — 63 a `todo_write` alone,
  17 a `record_evidence` alone — for 584 s of 4,753 s of model time and $1.25 of $9.19.
- **`web_fetch` loaded on demand:** the tool list changed, and the next request was
  sent uncached: 15.6k, 20.0k and 16.8k tokens, three UI runs out of three.
- **The first file written:** 60 to 158 s into the three newest UI runs, 55 to 100 s
  into eight of the nine serious ones and 232 s into the ninth.
- What is left after those is the work itself. On the six runs profiled, primary input
  is already 90 to 96% from the cache; on the landing page 363 of 368 s was the model,
  at the ceiling every turn.

**The 120 s wait was not a suite that cannot finish.** That is what it was taken for
(A1 and A2, above), and on the recorded runs it is wrong:

- In `b2-s6 … startup-selection` the agent ran `bun test tests/unit/` itself, twice, in
  its own shell: 5,002 tests in 54.2 s and 52.0 s, green. `bun run test` is that
  command. The end-of-turn check ran it on the same tree and was killed at 120 s. Same
  shape on `header-version-session`: the suite ran to its end in 73.9 s in the agent's
  shell (two tests red at that point in the work), and was killed at 120 s in the check.
- The agent's shell starts a command with a cleared environment. The check started it
  with **Rune's own** — and the comparison rig starts Rune with `RUNE_HOME`,
  `RUNE_DB_PATH` and `RUNE_CONFIG_PATH` pointing at the run's profile and
  `RUNE_CREDENTIALS_PATH`, `RUNE_CREDENTIAL_INDEX_PATH` and `RUNE_SECRETS_PATH` at the
  founder's real files. The fixture is Rune's own repository, and its tests read those
  names. The profile of that run holds two log lines from the check, 20.0 s apart, and
  then nothing.
- Reproduced with nothing real behind any variable (a copy of the recorded tree, a
  scratch home, scratch files where the rig has the real ones, file stores so the
  keychain is never reached):

  | The same tree, the same command                  | Result                                                     |
  | ------------------------------------------------ | ---------------------------------------------------------- |
  | on the host, clean environment, empty Rune home  | 52.6 s · 4,988 pass, 0 fail                                |
  | the unchanged check, state variables set (twice) | 116.6 s and 116.2 s · red: four "MCP OAuth 2.1 flow" tests |
  | this lane's check, the same session environment  | 62.3 s · typecheck, test and lint all green                |
  | the recorded live run                            | 125.3 s · killed at the limit, nothing measured            |

- In the reproduction the suite also **wrote into the file `RUNE_CREDENTIALS_PATH`
  named**: 2 bytes before, 667 after. There it was a scratch file. In the recorded runs
  that variable named the founder's real `credentials.json`, and the rig forces no
  store, so on macOS the default is the keychain. I did not open the real file or the
  keychain; whether test entries were left there is for the founder to look at.
- On **today's** tree the unit suite takes 228 s here, so in this repository as it now
  stands the limit is real. The recorded fixtures are earlier commits, at 37 to 74 s.

**What changed.**

- **E4, the reviewer** (`9a1b34a`, `0b962de`). A service's name counts only where its
  command is invoked — one predicate, `isRemoteMutationCommand`, for the risk scan and
  the containment route. A URL's path segment is not a payload. A script from a
  quoted here-document, a loop over literal words and `node --test` are ordinary.
  Replayed over the three UI runs: $0.568 → about $0.08, in-path reviews 3 → 0, screens
  17 → 10.
- **E1, the small task** (`b5293dc`). The pre-flight note no longer reads as a request
  for a read-back; the art-direction and greenfield notes stand down when nobody can
  answer; a small self-contained page, component or script is one work unit; the
  design skill's own files are read with `skill(name, file)`; `web_fetch` is a core
  tool. Doctrine 5,402 → 5,450 tokens (ceiling 5,500).
- **E1, the final state** (`dd6abf8`, `44c5c9d`). The headless envelope carries
  `shortfall`: `observed_failure`, `outside_terms` or `own_terms_unshown`. The exit
  code is unchanged; that decision is still the founder's.
- **E2, a pass the run already watched** (`7c3fae5`). `check-receipts.ts`: the check is
  not run again when the agent ran it, the line could not have hidden a failure, and
  the tree is byte-for-byte the same. On `startup-selection` that is the whole suite.
- **E2, what a check is started with** (`b82ac5e`). `check-env.ts`: the session's
  environment less the sixteen variables that locate or unlock the session's state, an
  empty Rune home, and the file stores. Nothing else moves. A test reads the source
  for every home-, path-, directory- and token-shaped variable Rune reads and fails on
  one that is unclassified.
- **E3, effort** (`f1cf163`, `8c57d60`, `4f155c1`, `c04031d`). Each cost row records the
  effort its call asked for. `[llm] effortRouting = "task"`: one effort for the
  request, raised at most once and never lowered; a gate that refuses the finish raises
  nothing. Off unless set. The default routing is as it was.
- **E0, the measurement** (`86abfc4`, `a9c4c29`). `tests/eval/parity/run-profile.ts`
  reads one run's database: first tool, first and last write, what the checks cost and
  said, the reviewer apart from the work, ledger-only completions, cached share, effort
  per call. An unpriced call leaves the cost unknown, not zero. The figures above that
  it covers agree with it.
- **Found by the gates** (`76a6337`). `prompt-cost.test.ts` pins the phase switch's
  saving; the read-back section is 12 bytes shorter since `b5293dc`, so it is 2,772
  where it was 2,784. The integration suite had not been run against that commit.
- Changelog, `docs/verification.md` and `docs/run-economics.md` (`168faee`).

**Verification, exact.** All on `168faee`, a clean tree, outside the sandbox, under
`caffeinate -i`:

- `bun run typecheck --force` → 15 of 15, none cached.
- `TERM=xterm-256color bun test --preload ./tests/scratch-home.ts tests/unit </dev/null`
  → **7,790 pass, 4 skip, 0 fail** (492 files, 228 s).
- `bun test --preload ./tests/scratch-home.ts tests/integration </dev/null` → **466 pass,
  7 skip, 0 fail** (78 files, 164 s).
- `bun run eval` → 63 of 63, baseline unchanged.
- `bun run eval:auto-safety` → the same output as on `0fe45a7`, line for line.
- `bun run format:check` → **fails on two files, neither of them this lane's**:
  `packages/orchestrator/src/explicit-requirements.ts` and
  `tests/unit/orchestrator/brief-ledger.test.ts`, both byte-identical to `0fe45a7` and
  failing there the same way. Left as they are — that work is someone else's. Every
  file this lane changed passes.
- Rust is unchanged and was not run.
- **141 deliberate breaks** across the cards; 140 failed a test. The one that did not
  cannot: the fix-verified gate fires only on a fix, and a fix already runs at the
  ceiling, so under task routing there is nothing for it to raise.
- **The candidate, built and started in a fresh shell.** Compiled in place into the
  worktree's ignored `dist/`: `dist/candidate-20261014/bin/rune-compiled` from `168faee`
  (`2e9a9fd3…f643a7`) and, for the comparison, `dist/baseline-0fe45a7/bin/rune-compiled`
  from `0fe45a7` (`97c9c0c9…6184e0`). Both with the native tools at `dbc683aa…7966f0`,
  which is what is installed; Rust did not change. For each: `--version`, `--help`,
  `tools-smoke` and `scripts/smoke-print.ts` (a prompt in and an answer out, against a
  fake model) pass with an empty home and no session environment. `build.json` beside
  each. Nothing was installed.

**What is not shown.** Anything about a live run. That a notch less reasoning costs
nothing in quality. That the model follows the reworded instructions: the doctrine now
says a plan update is never a turn of its own, and the recorded runs show an
instruction of exactly that kind (cite in the same response as the check) not followed
17 times. That the check environment was the whole of the hang in the live runs — the
reproduction went red at 116 s on scratch files, the live run was killed at 120 s on
real ones, and the keychain was deliberately not part of the reproduction.

**The live checkpoint, planned and not run.** The rig pairs every Rune run with a
comparator run, so the plan's three arms are two sittings of four arm runs, eight in
all; the two extra are OpenCode's, on the same tasks, and are the first measure of its
own run-to-run swing. One small task and one serious one
(`note-field-and-exporter`, `f7-6af7bb5-startup-selection`), `gpt-6-sol`, OpenCode at
`high`, Rune on its shipped defaults. Both planned with `--dry-run`, which starts
nothing: 2 pairs, 4 arm runs and at most 130 minutes each, stop at 70% of the window,
no retry. The manifests are in `dist/checkpoint-20261014/`. What to read afterwards is
`run-profile.ts` on each Rune run, not the totals: one run a task swings ±40%.

**For the founder.**

1. The live checkpoint above, in your words: the task count, the arm order, the
   allowance. Task routing would be a third sitting of its own, with
   `[llm] effortRouting = "task"`.
2. Bringing the lane into the working tree. It is fifteen commits on a snapshot of the
   tree as it stood on the 13th; other sessions have been writing in that tree since.
3. **A check still runs outside the sandbox, with whatever you exported.** The agent's
   shell is sandboxed and starts clean; the end-of-turn check runs a project script —
   which the agent can edit — on the host with your environment. This lane took Rune's
   own state out of that environment and nothing else.
4. Whether the real `credentials.json`, its index or the keychain hold test entries
   from the recorded runs' checks.
5. The exit code of a run whose only shortfall is `own_terms_unshown`.
6. The injection probe flags Rune's own unit-test output, and then every action in
   that run is reviewed in its path.
7. Background screens read almost nothing from the cache on Codex. The transcript they
   are sent is append-only; the cause is not known offline. About six calls would say.
8. A note at the point of use for a ledger-only completion — the same kind as the
   batching note — is the next cheap thing. Not built: the doctrine line is unmeasured,
   and so would that be.

**Next step.** The checkpoint, on the founder's word.

## The cost-and-latency lane, measured live, 2026-10-14 · **six runs on the founder's word: the same work as OpenCode in less time and for no more money on both tasks; every Rune run still ends "incomplete"**

The founder, after the entry above: "well proceed i have the available quota for gpt
subs it just reseted do the evals and report me that where does our program stands
now". Three single-pair sittings on the rig, harness mode, `gpt-6-sol` on the Codex
subscription for both tools, OpenCode 1.18.30 at `high`, Rune on its shipped defaults,
`RUNE_EVAL_QUOTA_PCT=70`, no retry. Rune ran first in each pair. Evidence in
`~/rune-evidence/cost-latency-20261014/`.

**Six runs, not the eight planned.** The old binary was not run on the serious task.
Its end-of-turn check starts the fixture's tests with `RUNE_CREDENTIALS_PATH` set, and
`tests/unit/tools/mcp-oauth.test.ts` at that commit builds its store as
`new FileCredentialStore({ ...process.env, RUNE_HOME: tmp })`: the path variable wins
over the home, so the store the test writes tokens into is the founder's real
`credentials.json`. That is what wrote 667 bytes in the reproduction. Running it again
knowingly was not mine to do; the serious baseline below is the recorded run.

| Task                    | Arm             | Hidden tests | Wall    | Calls | List cost | Exit | Ended      |
| ----------------------- | --------------- | ------------ | ------- | ----- | --------- | ---- | ---------- |
| note-field-and-exporter | Rune, this lane | 3 of 3       | 22.1 s  | 4     | $0.046    | 0    | incomplete |
|                         | OpenCode        | 3 of 3       | 33.6 s  | 7     | $0.061    | 0    | completed  |
|                         | Rune, `0fe45a7` | 3 of 3       | 41.5 s  | 11    | $0.104    | 0    | incomplete |
|                         | OpenCode, again | 3 of 3       | 45.8 s  | 11    | $0.083    | 0    | completed  |
| startup-selection       | Rune, this lane | 15 of 15     | 313.1 s | 32    | $0.649    | 1    | incomplete |
|                         | OpenCode        | 15 of 15     | 368.3 s | 36    | $0.654    | 0    | completed  |

No regression, nothing out of scope and no false completion in any of the six.

**The small task.** The lane against the build it started from, minutes apart: 41.5 s →
22.1 s, eleven calls → four, $0.104 → $0.046. What went is what the lane was aimed at:
four completions that only kept the ledger (12 s, $0.047) became none, and one
background screen became none. OpenCode's two runs of the same task, 33.6 s and 45.8 s
on seven and eleven calls, are its own swing.

**The serious task, and the check.** The end-of-turn check took **62 s and passed** —
typecheck, the whole unit suite, lint. On this task it had been cut at 120 s with
nothing measured both times before. It is the first answer that check has given here.

| Evening          | Rune                                             | OpenCode                    |
| ---------------- | ------------------------------------------------ | --------------------------- |
| 7 October        | 422.2 s · 27 calls · $0.655 · check 124 s, cut   | 424.2 s · 40 calls · $0.694 |
| 8 October        | 573.4 s · 39 calls · $0.885 · check 125 s, cut   | 328.1 s · 28 calls · $0.633 |
| 14 October, lane | 313.1 s · 32 calls · $0.649 · check 62 s, passed | 368.3 s · 36 calls · $0.654 |

Rune's own loop was 298, 448 and 251 s on the three evenings, so most of the difference
between any two of them is the run and not the build. The 62 s is the build.

**The rig's own report** (`report-candidate/`, harness mode, PROVISIONAL, one pair a
family): two of two complete for each tool; cost per clean completion $0.3475 for Rune
and $0.3575 for OpenCode; median paired ratio, Rune ÷ OpenCode, 0.87× on list cost and
0.75× on wall time. The same two ratios from the rows of 8 October, two serious tasks:
1.06× and 1.47×.

**What did not move.**

- **Every Rune run ended "incomplete".** The small one: `unmet — no criteria stated`,
  exit 0. The serious one: `partial`, `own_terms_unshown`, exit 1 — with fifteen of
  fifteen hidden tests passing and all three of its own checks green. The lane named
  the reason on the envelope and changed nothing else; this is A3, and it is now the
  whole of the difference between these rows and "completed".
- **Ledger-only completions on the serious run:** 5 of 30 — four plan updates and one
  citation, 26 s, $0.083. The instruction that a plan update is never a turn of its own
  did not change that.
- **One false flag cost $0.114**, 18% of the serious run. The background screen flagged
  `bun test … > /tmp/x.log 2>&1; result=$?; tail -n 28 /tmp/x.log; exit $result`; the
  reviewer on the heavy model overruled it. Neither request read anything from the
  cache.
- The effort was `high` on all 30 calls and never changed. Task routing was not run.

**The window.** Rune's meter: five-hour 0% before, 9% after its serious run; weekly 20%
then 21%. OpenCode's use is not metered by the rig.

**Limits.** One run in each cell, two tasks, one evening, Rune first in every pair.
Harness mode is attribution, never the gate. **The UI family was not run** — the one
with the largest recorded gap (2.9 times OpenCode's cost on 9 October), and the one the
reviewer and ceremony changes were mostly for.

**For the founder.**

1. What a run should say when its work is right and its own terms were shown only by
   its own tests (A3). It decides the exit code, and the rig's word for every run above.
2. The three UI prompts on this build: three runs, Rune alone, against the recorded
   runs of the other two tools.
3. Bringing the lane into the working tree.

**Next step.** The founder's, on the three above.

## The lane on GitHub, 2026-10-14 · **pushed on the founder's word; CI green on Linux, macOS and Windows; not installed, not merged**

The founder: "well i would suggest install it and push the changes to github !!".

**Pushed** as its own branch, `lane/cost-latency-20261013`, nothing else moved: 28
commits past `origin/main` (`ea19e90`) — the five local commits of
`gear/phase-0-stabilize` from 8 and 9 October that the lane sits on, Codex's snapshot
of the working tree (`0fe45a7`, authored "Codex"; 59 files, 0.7 MB, no `videos/`), and
the lane's own. Read before pushing: no co-author trailer, nothing shaped like a key or
token, no address but a test's `t@example.invalid`; absolute home paths only in the
snapshot's evidence files, as on `main` already.

**Found on the way, and fixed.**

- **`bun run lint` had not been run.** It is `prettier --check src/` inside each
  package, and `.prettierignore`'s `skills/` also hides `packages/tool-registry/src/skills/`
  from the root check, so a line `b5293dc` added there passed `format:check` and failed
  lint (`1e93e5a`). Two files from the snapshot failed both (`f0abf2d`, layout only);
  in CI that stops `ts-lint` before its unit tests, and `build`, `integration` and
  `eval` all wait on it.
- **The first CI run (`38475139729`) failed ten unit tests on Ubuntu and Windows that
  pass on this Mac** — every one a test that took the Mac for the world. `/bin/sh` is
  dash on Ubuntu, with neither `pipefail` nor `PIPESTATUS` (such a line errors, and is
  never a receipt; zsh and ksh are not installed there either); the product-sight gate
  reads the machine's browser, which a runner has none of — two of those tests came
  with `19b127d`; a Windows path has backslashes; a Windows check is not stopped at its
  limit; Windows holds a closed database file. Each test now states its machine
  (`5ba49b4`, `5bbe197`). The reuse integration test, which would have failed on Ubuntu
  next, picks the faithful line for the agent's shell; it passes here with
  `RUNE_SHELL=/bin/dash`.
- **CI run `38524410319` on `5bbe197`: success** — `ts-lint` on Ubuntu and macOS,
  `ts-windows`, `build`, `integration` and `eval` on both, `eval-real`, the Rust jobs on
  all three, `packaged-e2e` on all three, `shellcheck`, `cargo-audit`.

**Not installed.** `scripts/install.sh` refuses, by its own rule, to replace a dirty
build from another worktree: the installed build came from the main checkout's dirty
tree. Getting past it means `RUNE_ALLOW_NON_FF_INSTALL=1`, and an install from here
would then make every install from the main checkout refuse in turn until the lane is
merged. Merging first and installing from the main checkout needs none of that. Either
is the founder's to choose.

## The reliability plan against Claude Code, and R1 — the file tools, 2026-10-14 · **six of six edit probes failed on the installed build and pass on the lane; local, not installed, not pushed**

The founder: "i want you to( rea ) claude code and according to match that level of
reliability create an plan for rune", then, on the plan: "well proceed !!".

**How Claude Code was studied.** Not decompiled. Anthropic's terms bar reverse
engineering Claude Code to build a competing product, and Rune is one; REA stays a tool
for Rune's own binaries. The sources were its public documentation (the error reference
names every failure, its automatic handling and the recovery), `claude --help` 2.1.299,
the package layout and code signature, and same-input probes through Claude Code's own
Edit and Write from inside a working session. The plan is
[`rune-reliability-plan-20261014.md`](rune-reliability-plan-20261014.md); the evidence
and the probe script are in
[`docs/evidence/rune-reliability-probes-20261014/`](../evidence/rune-reliability-probes-20261014/README.md).

**Baseline, read-only from `rune.db`.** Of 163 recorded runs since 14 September, none
ended `met`. 44 ended `provider_lost`, and 39 of those were Codex quota walls. Of 1,448
recorded `edit_file` and `multi_edit` edits, 3 matched through the whitespace or
indentation tiers. 19 of 788 edits paid a re-read for a stale hash.
`~/.rune/bin` holds 250 backup binaries, 5.4 GB.

**R1 landed on `lane/reliability-r1-20261014`**, a worktree at
`.claude/worktrees/reliability-r1-20261014` on `fe869ae` (the installed build's commit), so
installing from it later is a fast-forward:

- `b2ca5f2` — `crates/rune-tools/src/text_file.rs`, and `edit_file`, `write_file` and
  `read_file` on it:
  - strict UTF-8 with the BOM kept;
  - line endings kept;
  - the replaced file's mode copied before the rename, and a new file at 0666 under the
    umask;
  - exact matching, with line endings as the one conversion;
  - a miss that names the lines that nearly matched;
  - a stale hash applies when `old_text` still matches exactly once;
  - `write_file` writes through a symlink (it used to replace the link) and refuses one
    that leaves the workspace.
- `895df62` — the same contract in TypeScript (`text-file.ts`) for `multi_edit` and
  `apply_patch`:
  - `multi_edit` returned a 755 script as 644;
  - `apply_patch` rolls back to the original bytes and mode, and reports how each hunk
    matched;
  - `multi_edit` needs a prior read, as `edit_file` does.
- `3a7024e` — one table, `tests/helpers/file-contract.ts`, run against the Rust binary
  (integration) and `multi_edit` (unit).

**Measured, zero model calls.**

- **Evidence probes:** installed build 6 of 6 fail; lane build 6 of 6 pass.
- **Contract table, Rust half:** 15 of 19 fail on the installed binary; 19 of 19 pass on
  the lane build. The TypeScript half passes 24 of 24.
- **Mutants:** eight, each turning at least one case red — four Rust (mode copy, strict
  decode, line-ending candidates, umask mode) and four TypeScript (mode copy, strict
  decode, replacement endings, indentation diagnosis). Every file was restored and
  checked by hash.
- **Rust gates:** `rune-tools` tests 58 → 82; `cargo clippy --all-targets -D warnings`,
  `cargo fmt --check` and `cargo test --all` clean.
- **TypeScript gates:** `bun run typecheck` 15/15, `bun run lint` 7/7, `format:check`
  clean.
- **Unit suite, unsandboxed:** 7,821 pass, 4 skip, 1 fail. The fail was the A3 test that
  relied on `multi_edit` writing U+FFFD over a non-UTF-8 file behind an empty diff; that
  write cannot happen now, so it is a refusal test. Re-run on the committed lane: 7,822
  pass, 4 skip, 0 fail.
- **Integration suite, unsandboxed, lane binary:** 485 pass, 7 skip, 0 fail.
- **Mock eval:** 63/63, no regression against the baseline.

**Departures from the plan, and why.**

- A hard-linked file keeps the rename and says so. The plan had said write it in place,
  which would edit a package manager's shared store through one project's link.
- `apply_patch`'s fallback use was never recorded (its 125 calls carry no tier), so the
  "3 of 1,448" figure covers `edit_file` and `multi_edit` only. D3 was taken as answered
  by "proceed".

**Not done.**

- Not installed: the daily binary still fails all six probes.
- Not pushed; no live run.
- `docs/errors.md` (R0.2) is not started.
- The transport and process suites of R0.1 belong with R2 and R4, which wait for D1, D2
  and D7 and for the evidence-based plan's Stage 1.

**Traps on the way.**

- `git worktree add` from inside Claude Code's sandbox fails on the repository's
  `skills/*/.mcp.json`; it needs the sandbox off.
- The unit suite inside the sandbox stalls on 30-second hook timeouts in every test that
  binds a port; run it unsandboxed with `</dev/null`, after checking that no `RUNE_*`
  variable is set.

## v1.4.2 shipped, 2026-10-14 · **the cost-and-latency lane and R1 together; CI green on three systems; installed through `rune upgrade`**

The founder: "merge both the lanes properly cost latency and this one but make sure the
neither one gets affected by each other !! also install the latest version … and ship it as
the v.1.4.2 … full till r8 will land in this v.1.4 … after each phases lands … v.1.4.3".

**The merge.** The R1 lane was built on the cost-and-latency lane's head (`fe869ae`), so
`main` fast-forwarded from `ea19e90` to `24e1503` with no merge commit. Neither lane
touched the other's code:

- 112 files changed on one side and 20 on the other; the only files in common are
  `CHANGELOG.md` and this ledger, where R1 only added lines;
- the one cost-and-latency file that names `apply_patch` (the activity view) reads `path`,
  `moved_to`, `diff` and `action`, never the `strategies` field R1 added;
- the combined tree passed unit 7,822/0, integration 485/0 and the mock eval 63/63.

**The release.**

- **`8443ce1` "release: Rune is 1.4.2":** the usual thirteen files; there was no 1.4.0 or
  1.4.1.
- **Fresh-clone gate:** typecheck 15/15, lint 7/7, format, unit 7,822/0, `cargo` fmt,
  clippy and tests, probes 6/6.
- **CI run `38567965643` failed `rust-lint (windows-latest)`:** in `text_file.rs` the
  `TempDir` import is used only by `#[cfg(unix)]` tests, so it was unused on Windows.
  Fixed in `24e1503`. A local Windows clippy could not stand in for CI, because SQLite's
  and tree-sitter's C sources need the Windows SDK headers.
- **CI run `38569978437`:** green, 22/22, including Rust tests on Windows and the
  file-contract integration tests on Linux and macOS release builds.
- **Tag:** `v1.4.2` at `24e1503`.
- **Release run `38571946929`:** success, including macOS signing and notarisation,
  Windows Authenticode and fresh-machine installs on all three systems. 11 assets, marked
  Latest.
- **Installed with `rune upgrade`:** `rune --version` reports v1.4.2. The CLI (`29d4f8bc…`)
  and the tools (`a13a1dcc…`) match the release's `SHA256SUMS`. `rune doctor` and
  `rune tools-smoke` pass, and the six edit probes pass against the installed tools.

**Not touched, and not in 1.4.2.** The main checkout's `gear/phase-0-stabilize` (`2dabdb2`
plus other sessions' uncommitted work, including the patch the 14 October Gemini audit did
not approve) is untouched and now 34 commits behind `main`.

**Seen in `rune doctor`:**

- the Codex plan cap is in force until 22:44;
- two live Rune sessions keep the previous build until they restart;
- 106 MB of checkpoints can be reclaimed with `rune doctor prune-checkpoints`.

**Numbering, the founder's rule.** The 1.4 line carries the reliability plan: each phase
that lands from here is the next patch (1.4.3, 1.4.4, …), through R8.

## The reliability plan, R4 → R7: v1.4.3 to v1.4.8, 2026-10-14 → 15 · **six releases on the founder's word, each phase its own patch; CI green on three systems for every tag; R8 waits for the founder**

The founder's word on 14 October: "proceed with the rest of the parts of engineering", and
"after each phase lands, the last digit goes up by one". Each phase below shipped as its own
release, cut from the lane `lane/reliability-r4-20261014`, CI-green on its own commit, tagged,
published by the release workflow, and installed here through `rune upgrade`.

| Release | Phase                  | What it changed                                                                                                                                       | Tag commit |
| ------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| v1.4.3  | R4 endings             | The exit code says how a run ended (0/1/3/4/5/130); a usage cap is `quota_wall` with `resumeAt`; `--strict-verdict` keeps the old rule                | `ef6f59d`  |
| v1.4.4  | R2 transport           | A sleeping laptop no longer ends a run; a cut response keeps its finished tool calls; an over-limit prompt is never re-sent unchanged                 | `26da79d`  |
| v1.4.5  | R3 safety, D1 and D7   | A safety block stops the action, not the run (a halt needs a flagged tool result); interactive sessions have no turn ceiling                          | `0aa6f95`  |
| v1.4.6  | R5 state               | `/rewind <n> code\|both` puts files back; long output saved whole; transcript-write health; compaction thrash stops; the sleep check's clock fix      | `7098a0b`  |
| v1.4.7  | R6 long commands       | Installs, test suites and builds that outlive their timeout are handed over as background shells, not killed; shells have lifetimes                   | `f2e40a7`  |
| v1.4.8  | R7 ship like a product | `rune upgrade` resumes a dropped download, `--rollback`, `--to`, `--channel stable`; `rune doctor` checks signatures, rollback, old builds, `rune.db` | `b7664cc`  |

**Every phase was mutation-tested.** R4: 6 mutants; R2: 30; R3: 23; R5: 17; R6: 12; R7: 13.
All were killed. Two first survived, and each got the test that kills it: the stream-error
path of the sleep check, and a damaged-page database for the doctor.

**What CI found that this Mac could not.**

- **1.4.6's first CI failed on Windows**, on four of its own new tests:
  - `EBUSY` removing a folder whose SQLite file was still open;
  - `/dev/null/outputs` being creatable on Windows;
  - a backslash path compared against JSON where it arrives escaped.
- **The second run failed on Windows again, and this time it was a product defect.**
  1.4.4's sleep check measured gaps on the wall clock alone, so a test that moved the system
  time made every later run in its process look asleep. Those runs re-sent three times "after
  a sleep". This was reproduced on macOS by running a time-moving test before the transport
  tests: four failures with the old clock, none with the new. The fix counts a gap only when
  the monotonic clock agrees. `setSystemTime` moved `Date.now` by an hour and
  `performance.now` by 0 ms; on macOS the monotonic clock counts sleep (12 October's
  600-second deadline fired across a 23-minute sleep). On Linux a sleep is no longer seen,
  which is where 1.4.3 was. The fix shipped in 1.4.6, after the release commit; the three
  local commits above it were replayed onto it before any were pushed.

**Decisions taken against the plan's letter, each stated in its release:**

- **R3: blocks at the limit are held, never asked about.** The plan's text had them go to the
  person after 3 in a row. The founder's standing rule (28 August) is that Auto mode never
  opens a prompt mid-run; "proceed" was not read as reversing it.
- **R3: the loop detector and the barren-turn breaker still end a run.** In an interactive
  session that hands the turn back to the person; neither has fired since 14 September.
- **R2, deferred:** the single retry ladder, cuts after text alone, and shrinking `max_tokens`.
- **R7, deferred:** a versions directory with a `current` symlink, which rollback now works
  without. The launcher already reads no source tree for a release build.

**Measured from the record, zero spend:**

- **The 12 October run that died asleep:**
  - the lid closed at 01:21;
  - every failure fell inside a dark wake (`pmset -g log`);
  - it ended `provider_lost` at the third dark wake.
- **Thirty foreground command timeouts between July and October**, most of them installs,
  test suites and builds.
- **Three Auto halts between 14 September and 14 October**, none on a run that had read
  anything injected.
- **`rune upgrade` failing twice with ECONNRESET** on 15 October, the Mac waking for seconds
  at a time with the lid shut.

**Installed here:**

- v1.4.4, v1.4.5 and v1.4.8 are installed through `rune upgrade`; CLI and tools match each
  release's `SHA256SUMS`, and doctor, tools-smoke and the six edit probes pass. 1.4.6 and 1.4.7
  were not installed on their own: the lid was shut, and 1.4.8 carries both.
- 1.4.5 needed the lid open: two attempts died mid-download, the failure 1.4.8 fixes.
- **1.4.8 replaced a source build another session had installed.** On 19 October the installed
  CLI was `1.4.7-dev+a13026a`, built on 16 October from a Codex session's
  `codex/rune-github-redesign` worktree (its sign-in redesign). `rune upgrade` kept it as
  `.backup`; `rune upgrade --rollback` puts it back.

**Not done, and why:**

- **R8, the live proof, needs the founder's approval** first: which pairs, how many runs, the
  window, the stop line, on the Codex subscription only.
- **D5, pruning the old builds, is the founder's call:** 66 installs, 5.3 GB on 19 October,
  5.0 GB of it reclaimable.
  `rune doctor prune-backups` shows them; `--apply` removes them.
- **The main checkout's `gear/phase-0-stabilize`** is still untouched, and further behind
  `main`.

## The reliability plan, R0: v1.4.9 (tag at `e7d5151`), 2026-10-19 → 21 · **the yardstick drives the real process, found three defects on its first runs, all fixed; every engineering phase has shipped; R8 waits for the founder**

R0 is the last engineering phase. Its contract part shipped with R1 in v1.4.2. What remained was
the transport and process suites, `bun run reliability` in CI, and `docs/errors.md`.

**What the suites drive.** `tests/reliability/` spawns the real `rune -P` from source against a
scripted OpenAI-compatible model on a loopback port, with a scratch home and no credentials:

| Suite     | Faults                                                                                                                                            | Tests |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| transport | a cut mid-stream, a stream that goes quiet (45 s), a malformed event, a 529 with `Retry-After`, a refused key, the wall clock set an hour forward |     6 |
| process   | SIGTERM, SIGINT and SIGKILL while answering, mid-tool, mid-compaction and mid-check, then a resume; SIGKILL with a background shell running       |    13 |

CI runs both on macOS and Linux (the integration job) and the transport half on Windows, in a
new job that builds `rune-tools` (`reliability-windows`). The process suite skips itself on
Windows, which has no SIGTERM or SIGINT to send.

**The three defects it found, each fixed with a failing test first:**

- **A stream from an OpenAI-compatible host that ended with no `finish_reason` was a finished
  answer.** The adapter gave it a synthetic `end_turn`, so a dropped connection ended a run with
  exit 0 and a truncated reply. It is a retryable 502 now.
- **The loop kept a half answer when it re-sent a request itself.** The gateway resets before
  its own three retries; the loop, re-sending after them, sent no reset, and the headless envelope
  read "An answer cut afteThe answer, sent again." Three sites now reset when the abandoned
  attempt showed anything. Found only because the clock-jump test needed four cuts to reach the
  loop's sleep check: with one, the gateway absorbed the cut and the test passed vacuously
  against 1.4.4's wall-only clock.
- **A run killed outright left its commands running.** SIGKILL during the end-of-turn check left
  `npm test` running with no one waiting. The check, hooks, background shells, a worker's check
  and the parent check's replays run in process groups of their own, and only an exit handler
  stopped them. Each now runs under a POSIX shell that polls its starter once a second and kills
  its own group when the starter is gone (`packages/shared/src/parent-watch.ts`), as
  `rune-tools` has done for tool calls since S-1.

**Mutation-tested.** The loop's reset: 5 mutants, all killed (one per site, the flag, an
always-reset). The parent watch: 6 mutants (never kills, never stops at exit, never wraps,
unquoted argv, status dropped, watches its own shell), all killed; the unquoted-argv one first
only by a timeout, because a failing assertion left the test's helper process holding the pipe,
and the test now cleans up in `finally`. Through the real process: the verifier and the
background shells each unwatched, both caught by the process suite. The clock-jump test: the
wall-only clock caught once the test reached the loop.

**A false alarm, and what it cost.** On 19 October the first run of the 24 spawn-site test files
showed two tests "hung" for 1,000 s and 225 s. `pmset -g log` shows clamshell sleep from 19:57 to
20:18 and again from 20:22, exactly those windows. Awake, under `caffeinate -is`, the same 24
files pass 699 of 699 in 67 s. Two hours of a session went to a closed lid.

**R0.3, the record since v1.4.2** (read-only, `~/.rune/rune.db`, 14 → 17 October): 11 run
endings in 6 sessions. One is `quota_wall`, the first usage cap named as one. Two are
`provider_lost`, and neither is transport: a Codex cap on 14 October, before R4, and a retired
free OpenRouter model on 16 October. No recorded run has ever ended `met`. The sample is too small
to compare with the 14 October table; R8 is the measurement.

**Gates.** A fresh clone of the release commit: unit 7,964 passed, 19 skipped and 0 failed;
Rust 142 and 0; typecheck 15 of 15; lint 7 of 7; format clean. In the worktree: integration 488
and 0, the scripted evaluation 63 of 63, the reliability suites 19 of 19. One unit failure on
the way was a race of my own making: the version was bumped while the suite ran, and the help
test read 1.4.9 from the CLI against a 1.4.8 label. CI: 23 of 23 jobs on the release commit `e7d5151` (run 39570329396), macOS, Linux and Windows, the new `reliability-windows` green on its first run; the R0 commit's own run (39569176180) the same.

**Installed here:** v1.4.9 through `rune upgrade` on 21 October. CLI and tools match the
release's `SHA256SUMS`; doctor (signatures valid, rollback to 1.4.8, database intact),
tools-smoke and the six edit probes pass. The Codex session's source build that 1.4.8 replaced is
no longer on disk; its branch `codex/rune-github-redesign` is pushed, so it can be rebuilt.

**Not done, and why:**

- **R8, the live proof, needs the founder's approval** first: pairs, runs, window and stop line,
  on the Codex subscription only.
- **A retired model ends a run `provider_lost`.** Its message names the cause and the fix; the
  label does not. Left for a later card.
- **D5, pruning the old builds,** is still the founder's call.

## The reliability plan, R8: the live proof, 2026-10-21 · **twelve runs on the founder's word; on 1.4.10, no transport failure, no re-send, no harness ending, nothing run twice, no loose edit; the sleep test waits for the founder**

The founder: "well then its an green light from my side i would suggest you to proceed with
the work !! the chat gpt has quota for now !!". The Codex subscription only, `gpt-6-sol`,
product mode, each build on its shipped defaults, `RUNE_EVAL_QUOTA_PCT=85`, the five-hour
window read at 0% (and the weekly at 0%) by one probe request before the first run. Evidence
machine-local under `~/rune-evidence/r8-20261021/`; the measures are read from each run's own
stream and incident log by `r8-metrics.py` there.

**What changed from the approved plan, and why.**

- **There is no v1.4.1.** The line went from v1.3.4 (8 October) to v1.4.2, so the build before
  the plan is v1.3.4. The proposal named v1.4.1; that was my error.
- **The hard tasks were not run on v1.3.4.** Its end-of-turn check hands the project the
  session's credential paths, and these tasks are copies of Rune's own repository, whose tests
  write to the store those paths name: on 14 October that wrote into a scratch copy of the
  founder's `credentials.json`. Their "before" is the recorded 1.3.3 runs of 7 October, the same
  tasks and model; 1.4.10 ran twice on each.
- **A credential leak was found and shipped as v1.4.10 before any live run.** A background shell
  started outside the sandbox inherited Rune's whole environment, provider keys and sign-in
  paths included. The founder's record has 266 background shells since July, five of them
  asked to run outside the sandbox.
- **The rig gained `rune-baseline`,** a second Rune arm, and counts it as metered.

**The runs.**

| Task                     | Build  | Hidden | Exit |  Wall | Calls | List cost | End-of-turn check  | Ended      |
| ------------------------ | ------ | -----: | ---: | ----: | ----: | --------: | ------------------ | ---------- |
| note-field-and-exporter  | 1.4.10 |    3/3 |    0 |  43 s |     7 |     $0.07 | passed             | incomplete |
|                          | 1.3.4  |    3/3 |    0 |  39 s |     6 |     $0.06 | passed             | incomplete |
| three-module-dependent   | 1.3.4  |    3/3 |    1 | 410 s |    16 |     $0.13 | passed             | incomplete |
|                          | 1.4.10 |    3/3 |    0 |  95 s |    16 |     $0.12 | passed             | incomplete |
| working-tree-integration | 1.4.10 |    3/3 |    0 |  40 s |     4 |     $0.05 | passed             | incomplete |
|                          | 1.3.4  |    3/3 |    0 |  47 s |     9 |     $0.11 | passed             | incomplete |
| model-catalog-cache      | 1.4.10 |  17/17 |    0 | 314 s |    13 |     $0.24 | passed             | incomplete |
|                          | 1.4.10 |  17/17 |    0 | 200 s |    10 |     $0.18 | failed, not blamed | incomplete |
| header-version-session   | 1.4.10 |    4/4 |    0 | 690 s |    58 |     $1.65 | passed             | incomplete |
|                          | 1.4.10 |    4/4 |    0 | 743 s |    76 |     $2.14 | passed             | incomplete |
| startup-selection        | 1.4.10 |  14/15 |    0 | 492 s |    29 |     $0.68 | passed             | incomplete |
|                          | 1.4.10 |  15/15 |    0 | 534 s |    40 |     $1.03 | passed             | incomplete |

Every run was clean: no regression, nothing out of scope, no false completion.

**The plan's measures.**

| Measure                                         | 1.4.10, 9 runs | 1.3.4, 3 runs |
| ----------------------------------------------- | -------------: | ------------: |
| Transport failures (each backed by an incident) |              0 |    1 (backed) |
| Re-sends per call                               |              0 | 1 in 31 calls |
| Runs the harness ended                          |              0 |             0 |
| Tool calls executed twice                       |              0 |             0 |
| Edits matched loosely                           |              0 |             0 |
| Exit code agrees with the hidden tests          |         8 of 9 |        2 of 3 |

- **The 1.3.4 transport failure:** a Codex stream silent for 300 s, then retried. Five of that
  run's seven minutes. 1.4.10 met no stall in nine runs; one run each is not a fix shown.
- **The exit codes.** 1.3.4 exited 1 on a run whose hidden tests all passed, because its
  verdict was `unmet`. The one 1.4.10 disagreement is exit 0 with 14 of 15: since R4 the exit
  code says how the run ended and the verdict, `partial` here, says whether the work is done;
  `--strict-verdict` keeps the old meaning. Neither build claimed `met`.
- **The checks finish now.** On 7 October the checks on these hard tasks were cut at 120 s with
  nothing measured. Here eleven of twelve ran to the end and passed. The twelfth failed on a test
  that needs a built web app the fresh tree does not have; it was not blamed on the work.
- **Against 7 October (1.3.3):** `model-catalog-cache` 449 s, 23 calls, $0.45 then; 314 s and
  200 s, 13 and 10 calls, $0.24 and $0.18 now. `startup-selection` 422 s, 27 calls, $0.66 then;
  492 s and 534 s, 29 and 40 calls, $0.68 and $1.03 now. `header-version-session` 511 s, 39
  calls, $1.03 then; 690 s and 743 s, 58 and 76 calls, $1.65 and $2.14 now: 33 reads and 19
  searches in one run, and the incident log's "struggle" notes. That is the model's exploring,
  not the transport or the harness.
- **The window:** five-hour 0% before, 63% after the twelve runs.
- **The founder's credential files** (`~/.rune/credentials.json`, its index, `secrets.json`,
  `.env`): size and modification time unchanged across all twelve runs. Read as metadata only.
  `credentials.json` is 667 bytes, last written 8 October 19:23, during that evening's recorded
  runs; 667 bytes is what the test wrote in the 14 October reproduction. It very likely holds
  test entries; the real sign-ins are in the keychain. Not opened; the founder's to look at.

**Not shown.** Every run, both builds, still ends "incomplete": A3. One run per task and build
on the small tasks, two on the hard ones; a ±40% swing between runs of one task has been
measured before. **The sleep test** (one long run, lid closed five minutes) needs the founder
at the lid, and has not run.
