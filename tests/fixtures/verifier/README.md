# Verifier fixtures (P10.4)

One tiny repository per ecosystem, committed, so verification detection is
asserted against a real directory layout rather than a mock filesystem.

| fixture                       | what it proves                                                    |
| ----------------------------- | ----------------------------------------------------------------- |
| `go-pass` / `go-fail`         | `go build ./...`, `go vet ./...`, `go test ./...`                 |
| `python-pass` / `python-fail` | stdlib `unittest` discovery and the `py_compile` step check       |
| `python-pytest`               | pytest is detected only when the project configured it            |
| `python-typed`                | mypy and ruff are detected only when configured                   |
| `python-uv`                   | a `uv.lock` makes every command `uv run …`                        |
| `rust-pass` / `rust-fail`     | `cargo check --quiet`, `cargo test --quiet`                       |
| `rust-clippy`                 | clippy is detected only when `[lints.clippy]` says so             |
| `java-pass` / `java-fail`     | a bare Java tree compiles with `javac` into a throwaway directory |
| `gradle-app` / `maven-app`    | wrapper detection (`./gradlew classes`, `./mvnw compile`)         |
| `monorepo`                    | three projects, three check sets, scoped by the files touched     |

**The `-fail` variants are broken on purpose.** Each contains exactly one
compile error, because a verifier that only ever sees green code is untested.

**The gradle and maven wrappers are placeholders.** A real `gradlew` is a script
plus a jar that downloads a Gradle distribution on first use; committing one
would put a network install inside a unit-test fixture. Detection only reads
that the wrapper file exists, so a placeholder is the honest fixture, and the
runnable JVM proof is the bare-`javac` fixture instead.

Unit tests (`tests/unit/orchestrator/verifier-ecosystems.test.ts`) assert
detection from these layouts without running any toolchain. Integration tests
(`tests/integration/verifier-ecosystems.test.ts`) run the real commands, and
skip with a printed reason when the toolchain is absent on the machine.
