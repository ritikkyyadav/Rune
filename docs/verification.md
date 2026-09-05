# Verification

Rune runs the project's own checks after the agent claims it is done, and again
at every plan step that wrote files, and feeds any failure back so the agent
self-corrects. This page says what it detects, what it refuses to guess, and how
to override it.

The rule underneath all of it: **if no check can be detected, verification
passes trivially with `ran: false`.** A task is never failed because Rune could
not work out how to verify it. The corollary matters just as much — `ran: false`
is not a green tick, and the plan ledger cannot close a step on it.

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

## Configuration

```toml
[verify]
enabled = true                                   # false skips verification entirely
commands = ["bun run lint", "bun test tests/unit/"]  # replaces detection wholesale
timeoutSecs = 120
perStep = true

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
- `tests/integration/verifier-ecosystems.test.ts` — runs the real commands, and
  skips with a printed reason when the toolchain is absent on the machine. On a
  laptop a skip is fine; in CI it would be a hole in the gate, so
  `RUNE_VERIFIER_REQUIRE_TOOLCHAINS=go,python,rust,java` (set by `ci.yml` on the
  ubuntu runner) turns a skip there into a failure that names what is missing.
