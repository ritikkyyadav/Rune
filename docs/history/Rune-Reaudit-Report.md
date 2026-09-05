# Rune Re-Audit Report — Post-Implementation Verification

**Date:** 2026-07-14 · **Tree:** `main` @ `1ad61db` + ~104 changed/new uncommitted files
**Scope:** Verify the P1–P10 prescription (`Rune-Prescription-Plan.md`) against source. Every claim below was checked in code, not taken from commit messages.
**Limit of this audit:** source-verified only — `bun` is unavailable in the audit environment, so the test suites and evals were **not executed here**. CI config (mock-gated PR evals + nightly real-model evals) exists but its green status must be confirmed on your machine: `bun test tests/unit/ && bun run eval -- --compare`.

---

## 1. Item-by-item verdict

| Item | Status | Evidence |
|---|---|---|
| P1 Eval flywheel | **LARGELY DONE** | `tests/eval/from-incidents.ts` (188 lines) mines the black-box incident store into regression tasks with a `covered.json` ledger; scripted suite grew to ~90 named tasks across five families (was ~8–10); runner gained `--compare` + `--noise` regression gating with `baseline.json`/`baseline-mock.json`; CI runs mock evals per PR and a nightly real-model eval. **Missing:** the external anchor — no SWE-bench/Terminal-Bench adapter found; and no published scores yet. |
| P2 Compaction merge | **DONE** | `context-engine.ts`: prior `[Earlier conversation summary]` is now extracted (`priorSummaryText`), excluded from the transcript, and passed as `priorState` for the summarizer to MERGE; `memory.summaries` is replaced (`= [`), not appended. Recursive summary-of-summary path is closed. |
| P3 apply_patch + model gating | **DONE** | `tools/apply-patch.ts`: full Codex envelope (Add/Update/Delete/Move, `@@` hunks, locator-advisory, End-of-File terminator), implemented fresh for interoperability with a `THIRD_PARTY_NOTICES.md` entry; every hunk routes through multi-edit's `applyOneEdit` (3-tier matching), whole-patch in-memory validation, temp+rename atomic writes with rollback — nothing lands partially. `registry.toLlmTools(forModel)` gates family-specific tools and the agent loop passes `this.config.model` (agent-loop.ts:357). This *exceeds* the prescription (atomicity + rollback weren't required). |
| P4 LSP auto-feedback | **DONE (default off, correctly)** | `tools/lsp/feedback.ts`: post-edit semantic diagnostics appended to the tool result, opt-in via `[lsp] autoFeedback` (engine + CLI wiring verified), deliberately OFF until eval-proven — exactly the prescribed discipline. On-demand `lsp` tool (4 languages) already verified in the prior re-audit. |
| P5 BM25 retrieval | **DONE** | `crates/rune-index/src/search.rs`: SQLite FTS5 BM25 over tree-sitter symbol chunks (whole-file fallback for unparsed files), incremental by (mtime, size), plain local file under `.alan/`, no daemon/network; `search_code` tool registered in `builtin.ts`. Matches the prescription line for line. Embeddings intentionally deferred — correct. |
| P6 Durable sessions | **MOSTLY DONE** | `engine-host.ts` (+145 lines): `--socket` serves the same frames over a unix domain socket, multi-client, engine survives last-client disconnect, immediate session-id ack for reattach, per-session event tagging. **Unverified:** depth of worktree-isolated background runs (worktree references exist in `engine.ts`/`git-undo.ts` but the isolation flow wasn't traced end-to-end). |
| P7 Signature normalization | **DONE — better than prescribed** | New `call-signature.ts` with a two-tier design: `breakerSignature` (aggressive — folds whitespace, key order, UUIDs, timestamps, hashes, all numbers; counts failures only) and `batchSignature` (conservative — keeps legitimately-advancing numerics like offsets distinct, so pagination loops aren't false-flagged). The two-tier split avoids a false-positive class the prescription didn't anticipate. |
| P8 Plugin bundles | **DONE** | `plugins.ts`: `.alan/plugins/<name>/plugin.json` bundling skills/hooks/mcp/commands; install = drop directory, uninstall = delete; provenance attribution everywhere; conflicts refuse loudly (name/dir mismatch, missing declared files, duplicate MCP server names). |
| P9 Org policy | **DONE** | `org-policy.ts`: policy loaded from a **root-owned system path**, Ed25519 signature verified via existing `signing.ts`, embedded-key forgery explicitly reasoned about; `PermissionBroker` checks policy **first, before the yolo/trust shortcuts** (the precedence requirement), and `forbidPermissionModes` can ban Hands-Free on managed machines. |
| P10 Sandbox honesty | **DONE (Windows machine-verify pending)** | Verified in the prior re-audit: capability probe, broker gate requiring `isSandboxEnabled() && isOsIsolationAvailable()`, `requireOs` refusal mode. Remaining: run once on a real Windows box to confirm banner/prompt behavior. |

**Bookkeeping:** `THIRD_PARTY_NOTICES.md` exists. CI (`.github/workflows/ci.yml`) gained eval stages.

## 2. What went right — quality observations

The implementations are not checkbox work. Three exceed the prescription: apply_patch's whole-patch validation with atomic writes and rollback; the two-tier call-signature design; and org-policy's root-owned-path + signature double defense with the embedded-key-forgery analysis written into the header. The discipline of shipping P4's auto-feedback **default-off until evals prove it** is exactly right and rarer than it should be. House style held: every new module carries the why-first doc comments the codebase is built on.

## 3. What still needs improvement — the remaining register

1. **External benchmark anchor (P1 residue) — now the single most important open item.** The flywheel exists; the *credibility artifact* doesn't. Build the SWE-bench Lite / Terminal-Bench adapter and produce one scored run. Until a number exists, every parity claim below is self-graded homework.
2. **Execution verification.** This audit could not run the suites. Confirm locally: full unit suite, `cargo test`, mock eval baseline, one nightly real eval, and one live session exercising apply_patch (Codex-family model), search_code, LSP auto-feedback on, and a socket reattach.
3. **Eval-prove the default-off features** (P4 autoFeedback, and measure apply_patch vs edit_file per family), then flip defaults per evidence.
4. **Worktree background isolation** — trace/finish end-to-end (P6 residue).
5. **Windows machine verification** (P10 residue).
6. **Embeddings** — only if `search_code` evals show BM25 ceiling (deferred by design).
7. **The unbuildables remain unbuilt** — by definition: model co-training, marketplace/community, distribution, support story. Post-P1–P10, these are 100% of the head-on gap. Next actions live outside the codebase: published eval scores, first design partners, security audit of the sandbox/policy claims.

## 4. Scoring — before vs now

Two scales, kept separate on purpose:

**A. Capability parity vs the frontier harnesses** (Claude Code/Codex = 100; features and behaviors only, ecosystem excluded):
- v1 (first audit, Jul 13): **~70%**
- v2 (first re-audit: +LSP tool, native repo map, sandbox capability): **~75%**
- v3 (this audit, P1–P10 verified): **~87%**
The remaining ~13 points are mostly things a harness cannot reach alone: model co-training, usage-scale hardening, and the ecosystem's tool breadth.

**B. Product-readiness composite** (weighted; measurement and enterprise dimensions included):

| Dimension | Weight | v1 | v2 | v3 |
|---|---|---|---|---|
| Core loop & reliability | 15 | 85 | 88 | 90 |
| Context management | 10 | 75 | 78 | 88 |
| Editing & model fit | 12 | 60 | 62 | 82 |
| Code intelligence (LSP) | 10 | 35 | 70 | 85 |
| Retrieval | 8 | 45 | 60 | 80 |
| Sandbox & security | 10 | 80 | 90 | 92 |
| Measurement & evals | 15 | 15 | 15 | 60 |
| Sessions & durability | 6 | 50 | 50 | 78 |
| Ecosystem & packaging | 7 | 20 | 20 | 45 |
| Enterprise & compliance | 7 | 40 | 45 | 82 |
| **Composite** | | **52** | **59** | **79** |

Measurement scores 60, not 90, despite P1 landing: infrastructure ≠ evidence. It reaches 85+ when external benchmark scores exist and defaults have been flipped on eval proof. Ecosystem stays low because plugins-the-mechanism isn't plugins-the-community.

**Bottom line:** Jul 13 morning → Jul 14: composite 52 → 79, parity ~70% → ~87%. The codebase is now, feature-for-feature, a legitimate top-tier harness with a compliance layer nobody else ships. What separates 79 from the low 90s is no longer engineering: it is one published benchmark number, one green CI history, one Windows run, and the first external user.
