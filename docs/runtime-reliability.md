# Runtime reliability work — 2026-09-05

This is the first delivery's historical record. See the
[2026-09-08 follow-through](audit-followthrough-20260908.md) for subsequent fixes,
live comparison evidence, current verification and installed provenance.

This change connects session state, inference accounting, delegation, settings and shell
execution across the existing runtime. It is an engineering improvement, not evidence of
leadership over other coding agents or a measured price comparison.

## What changed

| Failure                                                                                     | Resulting behavior                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic compaction persisted only metrics. Each later turn replayed the original history. | Versioned checkpoints persist the exact reduced working set, preserving eviction decisions and opaque provider reasoning. Later turns and a new Engine restore it. The append-only audit history remains available for rewind.                                                                                 |
| The lead's usage events missed nested inference and utility requests.                       | Gateway usage feeds a session-scoped ledger for lead, agents, compaction, research and reviewers. Late background replies keep their original session. Historical cost rows retain the rates originally recorded.                                                                                              |
| The cost limit did not guard all model paths.                                               | Each inference attempt checks the shared budget, including retries and fallbacks. A billed response is retained even when it crosses the cap; the next request stops. `/config budget` can raise or remove the cap.                                                                                            |
| Separate workflow fan-outs could multiply concurrency.                                      | A shared pool bounds active tasks and workers, including workflow nodes. Default delegate concurrency is three. Queued cancellation starts no work; completion and failure release capacity. Ordinary file tools retain their independent pool of eight.                                                       |
| Per-call agent budget fields were outside JSON Schema `properties`.                         | Models can see and supply the budget controls. Budget exhaustion no longer triggers an additional paid report-repair call.                                                                                                                                                                                     |
| Terminal configuration was fragmented.                                                      | `/config` opens a picker; `/config <setting> <value>` and `/settings` use the same validator and live setters as `update_config`, with no model call. Numeric values are bounded. The writer updates an existing project override and reports the actual destination. Sandbox edits clear stale sidecar state. |
| `network: true` disabled the filesystem sandbox; background commands bypassed it.           | Network access is an option inside the native sandbox. Foreground and background shells use the same platform profiles and curated environment. A background shell refuses to start without a native isolation plan. Network preflight also covers background commands.                                        |
| Interface guidance arrived after the first visual write.                                    | Relevant requests receive design and planning guidance before first inference. It covers shared component contracts, responsive states, a working vertical slice, and actual browser inspection. Compaction/resume updates whether guidance is still present.                                                  |
| Engine-host configuration omitted some CLI settings.                                        | Session budget, reliability policy, OS-isolation requirement and rate-limit settings reach the host as well as the terminal.                                                                                                                                                                                   |
| Case differences in macOS paths looked like a different checkout to the installer.          | The guard checks filesystem identity while retaining commit-ancestry and dirty cross-worktree protection.                                                                                                                                                                                                      |

Self-evolution continues through the existing evidence and consent gates. Run retrospectives
now see the shared session costs, and playbook generation can be configured in the terminal.
This does not enable unreviewed self-modification or change learning consent.

## Reproducible checks

Run from the repository root, with Bun, Rust and the native tools available:

```bash
cargo build -p rune-tools
bun test tests/unit </dev/null
bun test tests/integration </dev/null
bun run typecheck --force
bun run lint --force
bun run format:check
cargo test --all
cargo clippy --all-targets --all-features -- -D warnings
RUNE_TOOLS_BINARY="$PWD/target/debug/rune-tools" bun run tests/eval/runner.ts --compare
bun run tests/eval/auto-mode-safety.ts --offline --compare
```

New regressions cover actual Engine restart after compaction, attribution of late helper
usage after a session switch, restoring and changing an exhausted budget, direct settings
and project overrides, shared delegation capacity and queued cancellation, first-request
design guidance, and actual native background-shell containment. They use scripted
providers, not paid API calls. The language-server fixture supplies the repository's
TypeScript compiler so it does not depend on an unrelated global compiler installation.

## Verified local result

The combined working checkout passed the following checks on 2026-09-05. Concurrent UI
and planning edits were preserved and included in validation. Source changes remain
uncommitted; the base commit alone does not reproduce this build.

| Check                            | Result                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unit suite                       | 3,673 passed, zero failures                                                                                              |
| Integration suite                | 113 passed, five Go/Java toolchain skips, zero failures                                                                  |
| Rust suite                       | 90 passed, zero failures                                                                                                 |
| Typecheck                        | 14 tasks passed, cache bypassed; new test files also checked directly                                                    |
| Lint                             | Seven tasks passed, cache bypassed                                                                                       |
| Formatting and static checks     | Prettier, Rust formatting, Clippy with warnings denied, shell syntax and diff whitespace passed                          |
| Deterministic harness evaluation | 63/63 passed; baseline unchanged                                                                                         |
| Offline Auto evaluation          | 227 cases; precision 90.0%, recall 89.1%, F1 89.6%; baseline unchanged                                                   |
| Installed native tools           | Write/read/edit/shell round trip passed                                                                                  |
| Installed server                 | Session check passed and test hosts were cleaned up                                                                      |
| Installed TUI                    | `/config` picker and direct edit saved budget/concurrency; a new process restored both settings through `/settings list` |

The guarded installer delivered **Rune v0.3.0-dev+8d7c89f**, built from base commit
`8d7c89f3158b84a666dc13083eb39c13e41ddbf2` plus the working changes. Fresh login and
minimal-environment shells resolved the installed build. The settings smoke used an
isolated profile and made no model requests. Tests requiring live enterprise services
were not exercised against those services.

Installed provenance is recorded in `~/.rune/bin/rune-compiled.meta`. The SHA-256 values
are:

```text
CLI    ec0423e45f7adf728bc121b19e13831e4e7259c5f9228e740bda80fa76c87912
Tools  d1509d8a399d1ab396514a11221154846eccb526ce515786485292d925854098
```

The installer retained the prior CLI, native tools, launcher and metadata under
`~/.rune/bin/` with the suffix `.backup-1788624624`.

## Limits of the evidence

- Dollar caps use recorded list-price usage. Concurrent calls already in flight can overshoot
  a limit, and unknown prices cannot supply a dollar guarantee. Search-provider charges and
  external infrastructure invoices are not LLM usage. Deadline and turn limits still matter.
- The native integration probe verifies macOS Seatbelt on this machine. Linux uses the shared
  Bubblewrap profile but still needs execution in Linux CI; Windows has no equivalent shell
  isolation implementation here. Broad filesystem reads, explicit writable temporary/cache
  roots and credential denylists remain the existing sandbox policy. This is not VM isolation.
- The 63-task deterministic evaluation checks harness behavior. It does not measure live-model
  coding success, visual quality, Auto reviewer latency, or price parity with Pi/OpenCode.
- The offline Auto corpus has 227 scenarios. Its 171 mechanical cases match the expected
  decisions; the reviewer-dependent cases need live validation, and 38 labels await review.
  An offline report cannot establish the accuracy of a live supervisor.
- Licensing files and metadata remain unchanged at the user's request. This work does not
  publish a release or resolve the existing license-metadata discrepancy.

Before any superiority or price-parity claim, run the same real tasks, model, budget, network
policy and independent acceptance checks across harnesses, including long-session restarts
and browser-verified frontend tasks. Preserve completed-task cost and wall time along with
success rate; raw token savings alone are not a quality result.
