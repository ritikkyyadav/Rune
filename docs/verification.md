# Verification

Rune runs the project's own checks after the agent claims it is done, and again
at every plan step that wrote files, and feeds any failure back so the agent
self-corrects. This page says what it detects, what it refuses to guess, and how
to override it.

Verification has three outcomes: **passed, failed, or inconclusive**. An absent
runner, timeout, cancellation or lack of executable checks is inconclusive,
with a reason. It is neither a green check nor a code failure, and does not
buy a repair turn. A real negative check still triggers bounded repair.

## What is detected

Detection reads real signals from the workspace. It never runs a package
manager, never installs anything, and never emits a command whose tool it has no
evidence the project uses.

| ecosystem           | signal                                                                              | commands                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS / TS             | `package.json`, `tsconfig.json`, raw `*.test.ts`                                    | `<pm> run typecheck` or `<pmx> tsc --noEmit`, `<pm> test` / `bun test`, `<pm> run lint`, `<pm> run build` as a last resort                                                                    |
| Go                  | `go.mod`                                                                            | `go build ./...`, `go test ./...` (when `_test.go` files exist), `go vet ./...`                                                                                                               |
| Python              | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile`, `tox.ini` | `pyright` / `mypy` **if configured**, `pytest` **if configured** else `python -m unittest discover`, `ruff` **if configured**                                                                 |
| Rust                | `Cargo.toml`                                                                        | `cargo check --quiet`, `cargo test --quiet`, `cargo clippy --quiet` when `[lints.clippy]` or a `clippy.toml` says so                                                                          |
| JVM (Java + Kotlin) | `build.gradle(.kts)`, `settings.gradle(.kts)`, `pom.xml`, or bare sources           | `./gradlew classes` + `./gradlew test`, `./mvnw compile` + `./mvnw test`, the un-wrapped `gradle`/`mvn` equivalents, or `javac` into a throwaway directory when there is no build tool at all |

Checks run cheapest-signal-first: typecheck, then build, then tests, then lint.
`go vet` is Go's lint-shaped tool and runs with the other lints, after the
functional checks.

**Python runners.** A `uv.lock` (or `[tool.uv]`) makes every command
`uv run …`; otherwise a `.venv/bin/python` is used in preference to whatever is
on `PATH`, and a tool the venv actually has (`.venv/bin/pytest`) in preference
to `python -m`. This is the difference between running the project's pytest and
running someone else's.

**What is deliberately not guessed.** `pytest` is only used when the project
configured it (`pytest.ini`, `[tool.pytest.ini_options]`, `[tool:pytest]`,
`conftest.py`, or pytest in the dependencies) — otherwise the check is
`python -m unittest`, which is always installed. Same for mypy, pyright, ruff
and clippy: configured, or absent.

## Monorepos and several projects in one tree

The scan is recursive, bounded to three levels below the workspace root, and
never enters `node_modules`, `target`, `vendor`, `.git`, `.venv`, `dist`,
`build` or `__pycache__`.

A marker claims its subtree. A `go.mod` at the root means `go build ./...`
already covers the module, so nested Go directories are not separate projects;
the same holds for a cargo workspace, a gradle root project and a JS monorepo
root (`workspaces`, `turbo.json`, `nx.json`, `pnpm-workspace.yaml`), where only
the root scripts are trusted because they fan out on their own.

Where projects genuinely are separate — `services/api` in Go, `apps/web` in
TypeScript, `libs/core` in Rust — each gets its own check set, each command
prefixed with `cd <dir> &&`. The end-of-run verification runs all of them. The
**step check runs only the project whose files the step touched**: four services
should not rebuild because one of them changed.

Before P10.4 a workspace holding two apps was called "ambiguous" and detected
nothing at all, which is how a repo with real projects in it verified as
"nothing runnable detected".

## The step check

At a `todo_write` that closes a step which wrote files no check covered, Rune
runs the **compile-class tier only** — typecheck and build, never the test suite
— on a one-minute clock. A failure refuses the completion with the output; a
pass becomes the step's receipt. `[verify] perStep = false` turns it off.

Compile-class means: `tsc --noEmit` / a `typecheck` script, `go build`,
`cargo check`, `./gradlew classes`, `./mvnw compile`, `pyright`, `mypy`.

Two ecosystems have no cheap project-wide check, and get a **file-scoped** one
built from the files the step wrote:

- Python with no typechecker configured — `python -m py_compile <files>`
- a bare Java tree with no build tool — `javac -d "$(mktemp -d)" <files>`

## A missing toolchain is not a failure

`go build` on a machine with no Go exits 127. Reporting that as a verification
failure would fail every Go task on every machine without Go, which is the
opposite of what a verifier is for. Such a command is recorded as **skipped**,
with the reason, and the run continues. If every command skips, the result is
`ran: false` — "could not check", never "checked and green".

The skip is narrow on purpose: exit 127 alone is not enough, the shell's
"command not found" has to name the command's own leading binary. A project
script that exits 127 for its own reasons still fails.

Operating-system stubs are the other half of this. macOS ships `/usr/bin/javac`
on every machine, and with no JDK installed it exits **1** — not 127 — with
"Unable to locate a Java Runtime". Reporting that as "Java checks FAILED" would
be lying about the code, so the two known macOS stub messages (that one and the
Xcode command-line-tools one) are recognised as absence too.

## What gets recorded

Every check the runtime runs — the harness's own, and the ones the model runs
through `bash` — lands on the task spine with the command, whether it passed,
its **exit code** and its **duration**. Checks the harness ran carry the code
and the clock because it read both directly; checks the model ran through `bash`
carry neither, because a tool result has a success flag and no exit code, and a
fabricated `exit 0` beside a failure would be worse than no number.

`rune audit last` prints them:

```
  Checks  3 runs · 2 passed · 1 failed
    09:14 ✓ cargo check --quiet                       exit 0     2.9s harness
    09:16 ✗ cd services/api && go build ./...         exit 2     0.8s harness
    09:18 ✓ bun test tests/unit/                      ok           —  model
```

## What a check leaves in the tree

A check Rune chose to run leaves the tree as it found it. Cargo's and Python's
generated state is sent elsewhere through the environment when the project has
none of its own yet (`CARGO_TARGET_DIR`, `PYTHONPYCACHEPREFIX` and the like — a
`target/` that already exists is used as it is). A JavaScript build has no such
switch: `turbo typecheck` writes `.turbo/` and a `dist/` in every package. So
when a pass of detected checks ends — passed, failed, cut at its deadline or
cancelled — the git-ignored paths it created are removed again.

Only these, and only in a git repository:

- a path git ignores now, that git listed neither as ignored nor as untracked
  before the pass, and that the file system says was created during it. A
  folder an ignore rule names is one path to git: if `dist/` was already
  there, it keeps whatever the check put in it;
- never installed dependencies (`node_modules`, `.venv`, `venv`, `vendor`,
  `Pods`, `*.egg-info`), environment files (`.env*`), an editor's or another
  agent's folder (`.idea`, `.vscode`, `.claude`), `.DS_Store`, or Rune's own
  `.rune/`;
- never a new file git does **not** ignore. That is a visible change, and it is
  left for you to see.

What was removed is on the `verification_completed` / `step_check` event
(`removed`) and on the run's audit trail; the check's report is not touched.

Two things it does not do. It does not follow what a command **you** wrote in
`[verify] commands` builds — that command is yours, and so is its output. And it
cannot tell its own checks' output from something else that first wrote an
ignored path in the same seconds: a watcher the run started, or a second agent
working in the same tree. If either matters, or if the next check is much
slower without the build it would have reused, set `keepGenerated = true`.

## What a check is started with

A check is the project's, not the session's. It is started with the environment Rune
itself was started with — `PATH`, the toolchain's own variables, a `DATABASE_URL` the
project's tests read — **less Rune's own state**:

- the variables that say where this session keeps its home, database, configuration,
  preferences, memory, logs and control socket, and the ones that name or unlock the
  saved sign-ins (`RUNE_HOME`, `RUNE_DB_PATH`, `RUNE_CONFIG_PATH`,
  `RUNE_CREDENTIALS_PATH`, `RUNE_CREDENTIAL_INDEX_PATH`, `RUNE_SECRETS_PATH` and ten
  more; the list is `SESSION_STATE_ENV` in `check-env.ts`) are removed;
- `RUNE_HOME` is set to an empty directory that goes when the session does;
- `RUNE_CREDENTIAL_BACKEND` and `RUNE_MEMORY_KEY_BACKEND` are `file`, so nothing a check
  starts reaches the operating system's keychain through Rune.

For almost every project this changes nothing: nothing in a Go module reads
`RUNE_DB_PATH`. It matters for a project that reads Rune's variables — Rune's own
repository, or anything that starts the CLI or the SDK in its tests. Measured
2026-10-14 on a recorded run of such a project: the agent ran the unit suite in its own
shell, which starts a command with a cleared environment — 5,002 tests, 52 s, green. The
end-of-turn check then ran the same suite on the same tree with the session's
environment and was killed at 120 s. Run again with the state variables pointed at
scratch files, the old check took 116.6 s and went red on tests that had written into
the "saved sign-ins" file; this one took 62.3 s and passed all three checks.

It applies to a command you wrote in `[verify] commands` as well. Nothing else is taken
out: a provider key you exported is still there, and a check still runs outside the
sandbox the agent's own shell is held to. Those are larger questions than this one.

## A check the run already watched pass

When the agent ran the project's check itself — `bun test`, say — and nothing in the tree
has changed since, the end-of-turn check does not run it a second time. The report says
so, and whose run it was:

```
$ bun run test  (ok — this run already ran it, as `set -o pipefail; bun test 2>&1 | tail -n 8` moments ago in 52s, and nothing has changed since; not run again)
```

It is taken only when all of this holds:

- the command is the check, or the one plain command a package script of that name runs
  (no `pre`/`post` hook beside it);
- the line could not have hidden a failure. A bare `… | tail` reports `tail`'s exit code
  and is never taken. With `set -o pipefail;` in front of it, or with
  `test ${PIPESTATUS[0]} -eq 0` after it, it is — in the shells where those mean that;
- the working tree is byte-for-byte what it was when the command passed: the same
  `HEAD`, and the same content in every changed or untracked file. One edit after the
  run, and the check is run.

A reused pass was observed in the agent's shell, which is sandboxed and starts with a
cleared environment; a check that behaves differently outside it is not measured again.
`reuse = false` turns this off.

## A check that cannot finish

Every check command has `timeoutSecs` to finish in, 120 by default. One that is killed at
that limit measured nothing: the verification is `inconclusive`, never failed and never
passed, and no repair is asked for. Two things follow from it.

**It is not waited for a third time.** A command that did not finish is remembered — for
this workspace, for a day, under the limit it failed. Once it has failed to finish twice in
a row it is not started again: the result is the same "did not finish, nothing measured",
without the wait, and the report says `not started` and when it last ran. Twice, because
once can be the machine — asleep, or busy — and a check should not be taken away for a day
on one bad run. Raising `timeoutSecs` above the limit it failed under runs it again; so does
a day passing; and a command that finishes once is forgotten. The record is kept in the Rune
home (`verify-slow.json`), never in the workspace; deleting that file forgets everything. On
a project whose suite takes longer than the limit this was two minutes at the end of every
turn. (On Rune's own repository at the commits the recorded runs used, the suite was not
longer than the limit: it took 52 s. It did not finish because of what it was started
with — see "What a check is started with".)

**The tests the change touched are run in its place.** When the command that did not finish
is the test suite, and the suite is run by `bun test`, the test files the change itself
wrote are run on their own, with a minute to finish. Green is recorded as a passing check
for those files; red is a failed check like any other, and is handed back to be repaired.
The verification as a whole stays `inconclusive`: a part passing is not the whole passing.
Nothing is run in its place when the change touched no test file, for a check that is not
the test suite, or for a suite under another runner — vitest, jest and the rest take file
arguments differently, and a guess there would be a red of Rune's own making.

## Configuration

```toml
[verify]
enabled = true                                   # false skips verification entirely
commands = ["bun run lint", "bun test tests/unit/"]  # replaces detection wholesale
timeoutSecs = 120
perStep = true
keepGenerated = false                            # true leaves what detected checks build
reuse = true                                     # false re-runs a check the run already watched pass

# Narrower than `commands`: one stack at a time, detection intact for the rest.
[verify.ecosystems]
python = false                                   # never run Python checks here

[verify.ecosystems.go]
commands = ["go build -race ./..."]              # replace the detected Go set
```

Ecosystem names are `js`, `go`, `python`, `rust` and `jvm`; `java`, `kotlin`,
`gradle` and `maven` all name the JVM one, and `ts`, `typescript` and `node`
name the JS one. Unlisted ecosystems stay enabled.

## Fixtures and tests

- `tests/fixtures/verifier/` — one tiny committed repository per ecosystem, with
  a passing and a failing variant. The failing ones are broken on purpose.
- `tests/unit/orchestrator/verifier-ecosystems.test.ts` — detection from the
  fixture layout, with no toolchain installed.
- `tests/unit/orchestrator/verifier-step-check.test.ts` — project scoping and
  the evidence record.
- `tests/unit/orchestrator/verifier-generated-state.test.ts` — what a pass of
  checks may remove from the tree, in real repositories.
- `tests/integration/verifier-ecosystems.test.ts` — runs the real commands, and
  skips with a printed reason when the toolchain is absent on the machine. On a
  laptop a skip is fine; in CI it would be a hole in the gate, so
  `RUNE_VERIFIER_REQUIRE_TOOLCHAINS=go,python,rust,java` (set by `ci.yml` on the
  ubuntu runner) turns a skip there into a failure that names what is missing.
