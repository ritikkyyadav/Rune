# Phase 10 — Capability closers

**One agent at a time · after Phase 9 and the v0.3.0 tag · nine items ordered by weight × headroom**

## Goal

Move every capability axis that agents can move to its reachable ceiling on the 2026-09-02 bench, honestly: core coding loop 8.5 → 9.4, autonomy 9.0 → 9.5, verification 9.0 → 9.5, context 8.0 → 8.8, integration 7.5 → 8.5, extensibility 8.5 → 9.3, model breadth 8.0 → 9.0. Projected capability index about 129 (from 121). This phase does not move maturity; a public install link, one external user and a second release do, and those are the founder's.

Rules: docs/program/00-program.md §0 in full, plus the two added during execution: gates include `bun run lint && bun run format:check` and `bun run eval -- --compare` with a fresh `rune-tools` (`RUNE_TOOLS_BINARY`); every item lands as its own draft PR against gear/phase-0-stabilize from a branch `lane/p10-<n>` forked from the current tip; one agent runs at a time.

## Items

**P10.1 Post-edit diagnostics in the same turn (core loop, weight 15).** `packages/tool-registry/src/tools/lsp/manager.ts` manages typescript-language-server, pyright, rust-analyzer and gopls; `lsp/feedback.ts` is a stub and `[lsp] autoFeedback` exists in config. Wire it: after `edit_file`, `multi_edit`, `write_file` and `apply_patch`, request diagnostics for the touched file from the running server (spawn lazily, readiness-gated as the manager already does), append errors and warnings (bounded to 20 lines, file:line:message) to the tool result under a `diagnostics:` block, and keep the existing syntax-only path as the fallback when no server is available. Opt-in per project at first (`[lsp] autoFeedback = true` default for TypeScript and Python workspaces where the server binary is present; off otherwise), with a `/config lsp off` escape. Measure on the `fix-failing-test` and `multi-file-refactor` eval families in mock mode (scripts updated to the new tool-result shape) and record the delta in docs/benchmarks.md.

**P10.2 Windows parity (core loop + maturity).** Fix the read-before-edit ledger path keys (`packages/tool-registry/src/tools/freshness.ts` and the rune-tools path normalization: separators, drive-letter case, long paths); make `packaged-e2e (windows-latest)` green; burn down the POSIX assumptions in tests/unit so `ts-windows` runs the unit suite, not only typecheck; document what still differs on Windows (no OS sandbox) in README.

**P10.3 Supervisor recall (autonomy, weight 12).** Using the 227-row corpus (`tests/eval/auto-mode-corpus.ts`), raise the fast screen's recall on reviewer-only blocks from 13/46 to at least 35/46 while holding its false-positive rate under 10%: tune the fast prompt, add mechanical pre-screens for the five breaker gaps in docs/program/backlog.md, and add the patterns the corpus shows the cheap reviewer misses. Report per-source precision/recall before and after; the CI gate blocks regression.

**P10.4 Verifier ecosystems (verification, weight 10).** `packages/orchestrator/src/verifier.ts` detects typecheck/test/lint for a few stacks; add detection and per-step compile checks for Go (`go build`, `go vet`, `go test`), Python (pyright/mypy, pytest, ruff), Rust (`cargo check`, `cargo test`, clippy), Java/Kotlin (gradle/maven test), and monorepo roots; a fixture repo per ecosystem in tests/unit/verifier; the evidence ledger records which check ran.

**P10.5 Enterprise providers (model breadth, weight 8).** AWS Bedrock (Anthropic models via the Bedrock Messages API, SigV4 from the default credential chain), Google Vertex (Anthropic and Gemini via Vertex, ADC), Azure OpenAI (deployment-name routing, API-version header); each as an auth plus base-URL variant over the existing Anthropic/OpenAI/Google adapters; live discovery for every provider that offers a list endpoint; the three model tables collapse to one with a test that they agree. Measured with `scripts/verify-cache.ts` only where a credential exists.

**P10.6 Integration proofs (integration surface, weight 10).** A live VS Code load under `@vscode/test-electron` in CI (opens the webview, sends a selection, asserts a session starts); ACP conformance against the reference client implementation rather than the hand-written harness; `rune-review.yml` enabled on this repo behind the secret the founder sets; `rune pr <n>` exercised on a real PR in the integration suite.

**P10.7 Plugin index and sandboxed tools (extensibility, weight 8).** A public JSON index (`plugins/index.json` in this repo for now) that `rune plugin search` reads; `rune plugin add <name>` resolves through it; executable plugin tools run as subprocesses under the OS sandbox with a declared capability manifest (D6 v2), refused when the sandbox is unavailable; three example plugins in `examples/plugins/`.

**P10.8 Context quality (context management, weight 10).** A compaction-quality eval: long mock runs where the verify() checks that facts pinned before compaction survive after it (todo state, file ledger, decisions); fix what it finds; `rune audit` reports context utilization per turn; Anthropic context-editing where the API offers it, behind the existing cache policy table.

**P10.9 Orchestration polish (weight 10, small headroom).** Fleet view grouped by workflow wave in the web app and the console; `research.ts` refactored onto the workflow executor; `rune workflow` examples for review and greenfield in `examples/workflows/`.

## Gate per item

Each PR body carries: the axis, the before/after evidence (an eval delta, a corpus table, a CI job turned green, or a live test), and the standard gate output. No item lands on prose alone.

## What this phase does not do

It does not touch the terminal console (frozen), reliability (at ceiling), or the self-improvement real arm (needs credits). It does not ship, sign, host, or find users.
