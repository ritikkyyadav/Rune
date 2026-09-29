# The serious corpus (F7) — real fixes, graded by their own tests

Written 2026-09-29 (parity program, lane L0-D). F7 is the "serious (mined)" family of the
Parity Index (`docs/program/parity-index.md`, contract in `tests/eval/parity/types.ts`): tasks
mined from this repository's own history, SWE-bench style. The arm starts from the PARENT tree
of a fix commit, gets a prompt written like an issue a user would file, and is graded by the
fix commit's own tests, which it never sees. The method was first proven by hand on 2026-09-28
on three commits (`653698d`, `88758b3`, `a36ca74`), which are the corpus's seeds.

Code: `tests/eval/serious/` (`mine.ts` CLI, `f2p.ts` validation, `grade.ts` runner and outcome,
`source.ts` ParityTask adapter, `leak.ts` leak check, `tasks/<sha>.json` the corpus; usage in
its `README.md`). Tests: `tests/unit/eval/serious-{mine,f2p,grade,leak,source}.test.ts` and the
fixture `tests/fixtures/serious/junit-nested.xml`. Every change to a rule below goes in
**Changes** at the foot, dated, with the reason.

## Method

1. **Candidates.** Non-merge commits reachable from HEAD since 2026-06-01 that change at least
   one `packages/<pkg>/src/**` file AND add or change at least one
   `tests/(unit|integration)/**/*.test.ts` file.
2. **Screened out without a run:** a commit whose `bun.lock` differs from its parent's (an arm
   could not install the fix's dependencies), a commit touching more than six src files, and
   `release:` / `docs:` commits.
3. **The base tree** is built the way an arm gets it: `git archive <parent>` extracted into a
   fresh directory under `$TMPDIR` (no history, so the fix cannot be found in it),
   `.rune/config.toml` (and its `.gear` / `.alan` predecessors) removed because it configures
   only one arm, `git init` and one commit named "base", then `bun install --frozen-lockfile`.
4. **Hidden files** are what the fix commit added or changed under
   `tests/{unit,integration,helpers,fixtures}/`. At grading time they are copied over the tree
   byte for byte, replacing whatever the arm wrote at those paths. The `.test.ts` files among
   them are the ones run.
5. **Validation** runs the hidden tests twice at the parent, then applies the fix commit's
   `packages/**` changes and runs them twice more (a second fixed run is skipped only when the
   first shows nothing turning green). Every test is sorted into exactly one class:
   - **fail-to-pass (F2P):** not passing at the parent in both runs, passing with the fix in
     both. These are the hidden checks an arm is scored on.
   - **pass-to-pass (P2P):** passing in all four runs. An arm that breaks one has introduced a
     regression.
   - **impossible:** not passing with the fix in both runs — the environment forbids it (for
     example a background shell needs OS isolation the sandbox refuses), or it needs a change
     outside `packages/`. Excluded for every arm.
   - **flaky:** two runs of the same tree disagree. Excluded everywhere, listed for the record.
   - **skipped:** skipped with the fix. No check at all.
6. **Kept** when the candidate has at least one F2P check and each fixed-tree run finishes in
   under 120 s (a killed run rejects). For a kept candidate, each workspace package whose src
   the fix touched is typechecked (`bunx tsc --noEmit -p packages/<pkg>`) at the parent and
   with the fix.
7. **Prompts** are written by hand, one per selected task (below), and joined with the mining
   result into `tasks/<sha>.json`.

## Validation rules

What makes a task valid, each rule pinned by a unit test and each test proven by a mutant
(Changes, 2026-09-29):

- A test's identity is `<file> :: <describe> > … > <name>`, read from bun's JUnit report
  (bun prints per-test lines only for failures when it is not on a terminal). An `<error>`
  fails a test like a `<failure>`; `<skipped>` skips it; two tests with one path keep both
  results (`… #2`); XML entities are decoded exactly once. A test missing from the report —
  its file failed to load, bun crashed, the run was killed — did not pass.
- Hidden tests run under the scratch-home preload when the tree has it, with a scratch HOME
  carrying its own git identity, no credential-shaped environment variable and no
  `RUNE_EVAL_REAL`, in a process group of their own that is killed when the run ends.
- **Outcome.** `hiddenTotal` counts F2P checks minus any pinned impossible; `hiddenPassed` the
  ones that pass. A P2P check that fails, is skipped or did not run is a regression. The build
  is broken only for a package whose typecheck was clean at the parent AND with the reference
  fix; a typecheck the reference fix itself fails holds no one. `quality()` is the contract's.
- The grade reads only the tree. It never trusts what the arm said about its work, and the
  hidden tests are always the fix commit's own, whatever the arm wrote in their place.
- **Task files.** Full commit ids; family F7; `timeLimit: "serious"`; a written prompt; at
  least one F2P check; each check in exactly one list and inside the task's test files; every
  test file among the hidden files; a base typecheck recorded for every typechecked package;
  an "Interface the fix must provide" section in the prompt if and only if `interface` is set.
- **The leak check** (`leak.ts`, run by `mine.ts check` and by the committed-corpus unit
  test). It collects what the fix's `packages/**` diff ADDED in code files: every name its
  added lines declare (function, method, variable, class, interface, type, enum), every
  member that opens an added line (an interface or class field, an object key, a parameter on
  its own line), and every string literal of 12 or more characters (a template's fixed text is
  split at its expressions). Comment lines and regular-expression literals open no string. A
  collected name that also exists at the parent (anywhere in the tree, as a whole word) is
  not new. A new name the hidden tests reference is the interface and may be named. Any other
  new name in the prompt — as a whole word, or a literal in any case — is a leak, and the task
  fails. The scan is lexical and generous on purpose: a false alarm costs a rewording.
- **Interface entries** must each be used by the hidden tests (a symbol they reference, or a
  module path they import) and named in the prompt. An interface names what the tests call
  and the parent lacks: a symbol, a parameter or field of an existing one, or a new module.

## The mining run, 2026-09-28

Over the history reachable from `d241a80` (the branch point then): 674 commits since
2026-06-01, **343 candidates**. Skipped without a run: 89 for more than six src files, 11 for
a lockfile change, 0 release/docs. **243 validated, 198 kept.** Rejected 45:

| Reason          | Count | What it means                                                                                                                                                                                                                      |
| --------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no-f2p          |    25 | Nothing the fix turned from red to green (mostly TUI layout commits whose tests pass at the parent or fail everywhere).                                                                                                            |
| already-passing |    13 | Every hidden test already passes at the parent.                                                                                                                                                                                    |
| install-failed  |     7 | All seven are `bun is unable to write files to tempdir: PermissionDenied` — the mining machine's temp directory, not the commits (`e427bd5`, `681ddd0`, `4ab1550`, `e29d235`, `e276122`, `b5e0cc6`, `e079e55`). Unjudged, not bad. |

Kept by package (a task can touch several): orchestrator 178, shared 32, tool-registry 24,
llm-gateway 17, protocol 7. No kept candidate was flaky or slow. The six commits after
`d241a80` (`4355a95` … `f29a771`) were not mined.

## Selection

The kept pool is 90% orchestrator, so the corpus is drawn deliberately rather than at random:
every package the miner found fixes in, tasks that touch only shared, tool-registry or
llm-gateway, all three shapes, the three seeds, and deterministic, fast checks (the slowest
fixed run is 4.7 s). Excluded on purpose: the Claude subscription sign-in fixes (`802e077`,
`d3c35e4`, `0c79de4`), because that route has since been retired for Anthropic's terms and a
task should not ask an arm to repair it; tasks whose checks pin a heuristic classifier's exact
answers or data values a prompt would have to state outright (`64028d6`, `a63c353`); and very
large features whose prompts would have to transcribe the implementation (`855e48f`,
`613696f`, `4db3421`).

**30 tasks**: 22 fix, 5 feature, 3 refactor; 174 F2P checks, 353 P2P, 2 impossible; 15 name
an interface. By package: orchestrator 20 (12 alone), tool-registry 7 (5 alone), shared 5
(3 alone), llm-gateway 5 (2 alone), protocol 2.

| Commit    | Task (`f7-<sha>-…`)             | Packages                          | Shape    | F2P | P2P | Imp. | Interface | Fixed run |
| --------- | ------------------------------- | --------------------------------- | -------- | --: | --: | ---: | --------- | --------: |
| `031927a` | plugin-host-enforcement         | tool-registry                     | fix      |   4 |   7 |    0 | —         |     0.4 s |
| `0810fff` | stranded-legacy-db              | shared                            | fix      |   1 |   2 |    0 | —         |     0.1 s |
| `08d9beb` | windows-path-candidates         | orchestrator                      | fix      |   5 |   2 |    0 | —         |     0.0 s |
| `18dda21` | background-shell-recycled-group | tool-registry                     | fix      |   1 |   6 |    1 | yes       |     4.7 s |
| `28013c6` | misencoded-tool-call            | orchestrator                      | fix      |  12 |   0 |    0 | yes       |     0.2 s |
| `4298d2c` | meter-never-fails-request       | orchestrator                      | fix      |   1 |   8 |    0 | —         |     0.2 s |
| `44d4c1a` | header-version-session          | orchestrator                      | feature  |   4 |   0 |    0 | yes       |     0.1 s |
| `53ebc1a` | evicted-result-excerpt          | orchestrator                      | fix      |   2 |  16 |    0 | —         |     0.1 s |
| `5553813` | tilde-user-home                 | orchestrator                      | fix      |   3 |  57 |    0 | —         |     0.0 s |
| `57c0b9c` | spine-writes-one-predicate      | orchestrator                      | refactor |   1 |   8 |    0 | —         |     0.2 s |
| `585230a` | recursive-delete-breakers       | orchestrator                      | fix      |   6 |   3 |    0 | —         |     0.1 s |
| `5ab7fa0` | check-exit-code-verdict         | orchestrator                      | fix      |  26 |   5 |    0 | yes       |     0.1 s |
| `5eb44ba` | host-frame-writer               | orchestrator, protocol            | fix      |   8 |   0 |    0 | yes       |     0.0 s |
| `653698d` | toml-config (seed)              | shared                            | fix      |   6 |   1 |    0 | —         |     0.0 s |
| `6af7bb5` | startup-selection               | orchestrator                      | refactor |  15 |   0 |    0 | yes       |     0.0 s |
| `72605e6` | folded-tail-prefix              | llm-gateway, orchestrator         | fix      |   5 |   7 |    0 | —         |     0.2 s |
| `7d1d42a` | todo-write-cleanup              | tool-registry                     | refactor |   1 |  27 |    0 | —         |     0.0 s |
| `865950a` | fixed-overhead-first-last       | llm-gateway, orchestrator         | feature  |   2 |  18 |    0 | yes       |     0.1 s |
| `88758b3` | missions-resume-race (seed)     | orchestrator                      | fix      |   6 |  10 |    0 | yes       |     0.1 s |
| `8ac55c5` | openrouter-identity             | llm-gateway                       | fix      |   2 |   4 |    0 | —         |     0.1 s |
| `8b2033f` | incident-cost-join              | llm-gateway                       | fix      |   5 |   9 |    0 | yes       |     0.1 s |
| `93eca44` | model-catalog-cache             | orchestrator, shared              | feature  |  17 |   0 |    0 | yes       |     0.0 s |
| `97ef897` | compaction-worth-round-trip     | orchestrator, protocol            | fix      |   5 |  19 |    0 | yes       |     0.1 s |
| `a218abc` | checkpoint-report-matches-prune | shared                            | fix      |   1 |  34 |    0 | yes       |     3.3 s |
| `a36ca74` | background-shell-stop (seed)    | orchestrator, tool-registry       | fix      |   3 |   0 |    1 | yes       |     2.7 s |
| `c33f46d` | retro-lesson-containment        | orchestrator, tool-registry       | fix      |   1 |  63 |    0 | —         |     0.6 s |
| `d5c1536` | silent-finish-after-writes      | orchestrator                      | fix      |   1 |   9 |    0 | —         |     0.2 s |
| `e14e5fb` | tool-child-ledger               | tool-registry                     | feature  |   7 |   0 |    0 | yes       |     0.0 s |
| `f2bb82e` | codex-reasoning-effort          | llm-gateway, orchestrator, shared | fix      |   8 |  28 |    0 | yes       |     0.1 s |
| `f9a4372` | todo-write-flexible-inputs      | tool-registry                     | feature  |  15 |  10 |    0 | —         |     0.0 s |

"Packages" are the workspace packages whose src the fix commit touched; the grader
typechecks those. "Fixed run" is the slower of the two validation runs of the hidden tests
with the fix applied.

Why each was chosen:

- `031927a` — tool-registry; a security gap where a surface claimed more than the sandbox
  enforced (a named host silently widened to the whole port).
- `0810fff` — shared; a small, deterministic fix with a clear user-facing symptom: history
  silently orphaned.
- `08d9beb` — orchestrator; a containment matcher blind to Windows paths (the parent carries an
  unfinished stub there).
- `18dda21` — tool-registry; a process-safety bug (signalling a recycled process group),
  testable only through an injected signal function; its three "never signalled" checks are
  P2P and become real the moment that seam exists.
- `28013c6` — orchestrator; a free-route model printed a tool call as text and the run ended
  having done nothing.
- `4298d2c` — orchestrator; telemetry that assumed its input and killed the turn it measured.
- `44d4c1a` — orchestrator; a small UI feature with an exact contract (version display,
  session tail, id resolution).
- `53ebc1a` — orchestrator; the cheapest compaction tier destroyed facts it could not replace.
- `5553813` — orchestrator; a containment bypass through `~<username>`, which ignores `$HOME`.
- `57c0b9c` — orchestrator; four private answers to "what did this call write" consolidated
  onto the shared predicate.
- `585230a` — orchestrator; five classes of destructive commands Auto mode allowed unscreened,
  with negatives (build output) that must stay ordinary.
- `5ab7fa0` — orchestrator; every model-run check was recorded as a pass, so a documented rule
  could never fire.
- `5eb44ba` — orchestrator (+ protocol in the commit); the engine host truncated every large
  response, fixed behind a testable writer.
- `653698d` — seed; shared; a real config-parser bug with five visible symptoms and a writer
  bug.
- `6af7bb5` — orchestrator; extract the startup provider ladder into a pure module and fix the
  hand-written list that broke it.
- `72605e6` — llm-gateway + orchestrator; a prompt-cache defect measured on the wire, with a
  meter that could not see it.
- `7d1d42a` — tool-registry; a cleanup of model-written code with one behavioural pin (plain
  hyphens).
- `865950a` — llm-gateway (+ the orchestrator's report); a small metering feature with a
  precise rule about what counts.
- `88758b3` — seed; orchestrator; a cross-process race with four reproduced symptoms.
- `8ac55c5` — llm-gateway; a one-line root cause behind three visible symptoms.
- `8b2033f` — llm-gateway; a join key broken by retries, and a lost row in the cost tracker.
- `93eca44` — shared; a self-contained feature with a precise contract (a new module).
- `97ef897` — orchestrator + protocol; measured compaction defects in one seam; the result's
  new fields are the interface.
- `a218abc` — shared; a report and the action it names disagreed on a real database.
- `a36ca74` — seed; orchestrator + tool-registry; two lifecycle leaks; the engine-close check
  is impossible in a sandbox.
- `c33f46d` — orchestrator + tool-registry; a learned-lesson safety fix, with an architectural
  constraint (learners never import deciders) pinned by a P2P check.
- `d5c1536` — orchestrator; a passed task reported as a failure because the model never wrote
  a closing line.
- `e14e5fb` — tool-registry; a new safety mechanism whose tests pin three refusals before any
  kill.
- `f2bb82e` — llm-gateway (+ orchestrator, shared in the commit); an untested assumption that
  pinned a whole route to the server's default depth.
- `f9a4372` — tool-registry; widen a validator to the input shapes models really send.

**Re-validated 2026-09-29 through the adapter.** Every committed task was run through
`seriousTask(spec).prepare` and `.grade` twice: untouched, then with the reference fix's
`packages/**` files written over the tree. All 30: untouched quality 0 (0 of its F2P checks
pass), reference quality 1 (all pass), 0 regressions, no broken build.

## Known limits

- **Load failures inflate F2P.** A test file that imports a symbol the parent lacks cannot
  load there, so every test in it is F2P, including tests of old behaviour: 10 of the 12 F2P
  checks of `28013c6` and most of `5ab7fa0`'s are such tests. An arm that provides the
  interface earns them. Both arms face the same inflation, so it compresses the difference
  between them rather than favouring one.
- **P2P checks are hidden checks too.** `18dda21`'s recycled-number checks and `c33f46d`'s
  mutual-isolation check pass at the parent and fail for an arm that does the work carelessly;
  a regression halves quality.
- **Protocol is type-level only.** The protocol package holds types. `97ef897` may extend the
  compaction event there; `5eb44ba`'s commit changed protocol types its tests never exercise.
  An arm that touches protocol is held by its typecheck, not by a protocol test.
- **Two impossible checks** (`a36ca74`, `18dda21`: closing an engine stops its background
  shells) need OS isolation the sandbox refuses for a background shell. Unscored for every
  arm, here; they may pass on another machine.
- **Prompts carry what the tests pin.** Where a check asserts an exact string (an error
  phrase, a breaker id, a U+2011 hyphen in `f9a4372`), the prompt states it, and the leak
  check allows it only because the hidden tests reference it.
- **The leak check is lexical.** It cannot see a paraphrase of the fix. Every prompt is also
  read by a second reviewer before the corpus is used.

## Changes

- **2026-09-28**: The method proven by hand on `653698d`, `88758b3` and `a36ca74`. Miner,
  grader, adapter and leak check written (lane L0-D); 343 candidates mined, 198 kept.
- **2026-09-29**: First corpus: 30 tasks, prompts written and leak-checked (two prompts
  reworded after the check flagged a fix literal each: `653698d`'s "is not valid TOML (" and
  `031927a`'s space-bounded "cannot enforce its declared network endpoints"). The leak scan
  now also collects new members, and interface entries must be used by the tests and named in
  the prompt (the old check broke on a signature). `write-tasks` records the mining date and
  formats for the prettier gate. All 30 re-validated through the adapter. 47 mutants, one per
  rule, each turning a unit test red; the one that first survived (comment lines added inside
  an existing doc comment) got its own test.
