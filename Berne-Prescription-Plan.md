# Berne Prescription Plan — Engineering Work Order

**Date:** 2026-07-13 (revised same day after re-audit of the latest working tree) · **Status:** Approved direction — proprietary product, Berne engine retained, OSS subsystems imported (never the reverse).
**Tree state at revision:** `main` @ `25beb36` + ~800 lines uncommitted (LSP tool, native repo map, sandbox capability, reliability policy, token calibration, browser MCP). P4/P5/P10 were re-scoped accordingly — read their **[REVISED]** blocks, not just the original text.
**Companion doc:** `Berne-Competitive-Assessment.md` (diagnosis + §7 re-audit addendum). This document is the prescription.

---

## 0. Instructions to the executing agent (read first)

You are being handed this document in a fresh session to implement fixes in this repository with surgical precision. Ground rules:

1. **Never rebase Berne onto an external harness.** The decision is final: OSS code flows INTO Berne. Berne's engine, loop, and architecture stay.
2. **Read before editing.** Every file referenced below must be read in-session before modification. Line numbers were verified on 2026-07-13 and may have drifted — treat them as anchors, re-locate by symbol name.
3. **One problem per work unit.** Implement, test, verify, then move to the next. Do not batch unrelated fixes into one change.
4. **Verify by executing.** `bun test tests/unit/`, `cargo test` in `crates/`, and the eval runner (`bun run tests/eval/runner.ts`) are the acceptance gates. A fix without a passing check is not done.
5. **License hygiene.** Any code ported from OpenCode (MIT) or Codex (Apache-2.0) requires an entry in `THIRD_PARTY_NOTICES.md` (create it in P0 if absent): source repo, commit hash, license, files affected. Apache-2.0 ports must preserve NOTICE content. MIT ports must preserve the copyright line. This keeps the proprietary product legally clean.
6. **Match house style.** TypeScript: the codebase uses dense doc-comments explaining *why* (see `agent-loop.ts` header comments as the model). Rust: workspace conventions in `rustfmt.toml`. No new dependencies without checking `package.json` / `Cargo.toml` workspace deps first.

### System map (so you don't re-derive it)

Monorepo: Bun workspaces + Turbo (TS) and a Cargo workspace (Rust). ~46k LOC.

| Module | Path | Role |
|---|---|---|
| Agent loop | `packages/orchestrator/src/agent-loop.ts` | Turn loop: streaming, breakers, loop detection, evidence gate, parallel tool exec, interjections |
| Context engine | `packages/orchestrator/src/context-engine.ts` | Budgeted prompt assembly, pair-safe compaction, real-usage tracking |
| Engine | `packages/orchestrator/src/engine.ts` (~2.6k lines) | Wires everything: sessions, checkpoints, permissions, hooks, tiers |
| System prompt | `packages/orchestrator/src/prompts.ts` | Doctrine, env block, repo map, project memory (ALAN/CLAUDE/AGENTS.md) |
| Permissions | `packages/orchestrator/src/permissions.ts` | Broker: confirm/auto/turing modes, workspace confinement |
| Subagents | `packages/orchestrator/src/subagent.ts` (read-only `task`), `worker.ts` (write workers w/ disjoint file ownership) |
| Verifier | `packages/orchestrator/src/verifier.ts` | Post-edit project checks (typecheck/tests), feeds failures back |
| Memory | `packages/orchestrator/src/memory/` (episodic, working, manager), `notebook/` (learned hints, cost governor) |
| Struggle detector | `packages/orchestrator/src/struggle-detector.ts` | Deterministic thrash/churn/rephrase signals → incidents |
| Black box | `packages/telemetry/src/` (recorder, redact, sentinel, store) | Local flight recorder, fingerprinted incidents |
| Gateway | `packages/llm-gateway/src/` | 8+ providers, retry/fallback, Anthropic prompt caching (`providers/anthropic.ts`), tier defaults in `packages/shared/src/tiers.ts` |
| Tools | `packages/tool-registry/src/tools/` | builtin, multi-edit, diagnostics (syntax-only), background shells, web, MCP client (`src/mcp/`), skills loader (`src/skills/`) |
| LSP (new) | `packages/tool-registry/src/tools/lsp/` | `lsp` tool: definition/references/hover/diagnostics via tsserver/pyright/rust-analyzer/gopls; lifecycle in `manager.ts`, framing in `jsonrpc.ts` |
| Sandbox capability (new) | `packages/tool-registry/src/sandbox-capability.ts` | Machine's actual isolation ability (seatbelt/bwrap/none) vs user intent; gates bash auto-approval in `permissions.ts` |
| Reliability policy (new) | `packages/orchestrator/src/reliability-policy.ts` | All loop recovery bounds, per-model-family adjusted, `[reliability]` config overrides |
| Native repo map (new) | `crates/alan-index/src/repo_map.rs` + `packages/orchestrator/src/repo-map.ts` | Request-aware structural map, budgeted into context as retrieved chunks |
| Browser MCP (new) | `packages/tool-registry/src/mcp/browser-server.ts` | Built-in Playwright headless browser for web verification |
| Rust tools | `crates/alan-tools/` | Fast read/grep/edit (3-tier matching, hash-guarded) + bash |
| Sandbox | `crates/alan-sandbox/` | macOS Seatbelt (`macos.rs`), Linux bubblewrap (`linux.rs`), `noop.rs` fallback, `path_guard.rs` |
| Index | `crates/alan-index/` | Tree-sitter symbol index + request-aware repo map (`repo_map.rs`), SQLite store |
| Evals | `tests/eval/` | runner, harness, mock-provider, ~8 task families, baseline.json |
| Signing | `packages/orchestrator/src/signing.ts` | Ed25519 session-export signatures |

---

## 1. Problem register

Each entry: root cause → prescription → implementation steps → source material → acceptance criteria. Severity: **S1** blocks the product thesis, **S2** major capability gap, **S3** correctness bug, **S4** hardening.

---

### P1 · Eval flywheel absent — S1, do first

> **STATUS — phase-0 core DONE 2026-07-13 (uncommitted, feat/reliability-and-tooling).**
> Shipped: per-task tool-call/cost caps (real-mode defaults, env-tunable); `--compare`
> regression gate (per-mode baselines, task-level determinism check in mock, noise-banded
> rate in real, exit 1 on regression, incompatible-baseline skip); baseline hygiene
> (subset runs and gate-failing runs never auto-promote; mock/real baselines split so one
> can't clobber the other); suite grown 25 → 33 artifact-verified tasks; incident→eval
> miner `from-incidents.ts` (+ `--scaffold` stubs, `covered.json` contract,
> `tasks-from-incidents.ts` promotion barrel wired into ALL_TASKS) — proven against the
> real blackbox.db (71× provider-fallback etc.) and a synthetic store; CI: per-PR mock
> job now `--compare`-gated, nightly (cron 03:00) full real-model run vs baseline,
> results archived as artifacts; `tests/eval/README.md`; `THIRD_PARTY_NOTICES.md`.
> Open: grow 33 → 50+ tasks (the from-incidents pipeline is the intended source —
> filler tasks would game the count); SWE-bench Lite / Terminal-Bench adapter.

**Root cause.** ~8 eval task families and a mock provider. No external benchmark anchor, no regression suite, no incident→eval pipeline. Every subsequent fix in this plan is unmeasurable without this. This is why it is Phase 0: implementing P2–P10 without P1 means flying blind.

**Prescription.** Three tiers of evals, cheapest first:

1. **Regression evals from incidents.** The black box (`packages/telemetry/src/recorder.ts`, `store.ts`) and struggle detector already capture fingerprinted failures. Build `tests/eval/from-incidents.ts`: read the incident store, group by fingerprint class, and for the top recurring classes hand-write (or scaffold) a deterministic eval task reproducing the failure shape. Target: every incident class that fires ≥3 times gets an eval within a week of appearing.
2. **Grow the scripted suite to 50+ tasks** across the existing families (comprehension, fix-failing-test, multi-file-refactor, new-feature, tool-discipline). Each task: fixture repo under `tests/eval/fixtures/`, success predicate that checks *artifacts* (file content, test exit codes), never LLM-judged for pass/fail.
3. **External anchor.** A thin adapter running Berne headless against SWE-bench Lite (later Verified) and Terminal-Bench. Monthly score, tracked in `tests/eval/baseline.json`. Do not chase the leaderboard — the score exists to detect regressions and measure P3/P4 impact.

**Implementation.** Extend `tests/eval/harness.ts` with: per-task cost/turn caps, JSON result emission per run, and a `--compare baseline.json` mode that fails CI on regression beyond noise. Wire into `.github` CI as a nightly job (live-model tasks) and per-PR job (mock-provider tasks only).

**Acceptance.** `bun run eval` produces a scored report; CI fails on regression; ≥50 tasks; incident→eval pipeline documented in `tests/eval/README.md`.

---

### P2 · Compaction summary-of-summary degradation — S3, surgical bug

> **STATUS — DONE 2026-07-14 (uncommitted).** `compactWorkingSet` now detects a
> prior-summary head (both markers: `[Earlier conversation summary]` from rolling
> compaction and `[Conversation summary]` from /compress replay), strips it from the
> transcript, and passes it to `generateSummary` as PRIOR STATE with merge
> instructions over five FIXED labelled sections; a window containing only the old
> summary declines to compact instead of laundering it through the model again.
> `memory.summaries` verified write-only (buildPrompt never injects it) and capped
> to the latest entry. Tests: `compaction-degradation.test.ts` — 3 successive
> compactions keep a round-1 token, exactly one summary message, no marker in any
> post-first summarizer request, pairing invariants hold (36/36 incl. existing suites).

**Root cause.** `context-engine.ts` → `compactWorkingSet()` (line ~416): `toSummarize = messages.slice(0, safeCutPoint)` includes the previous compaction's `[Earlier conversation summary]` user message, which is then re-summarized by `generateSummary()` — prose summarizing prose, recursively lossy across repeated compactions in long sessions. Additionally `memory.summaries` (line ~473) accumulates every compaction's summary without pruning. Codex CLI shipped and fixed this exact defect (their `codex-rs/core/src/codex/compact.rs` moved to a clean template).

**Prescription.** Replace prose-accumulation with a **structured state block that is merged, never re-summarized**:

1. Define a `CompactionState` shape: `{ goals, decisions, filesTouched, commandsRun, openQuestions, currentState, nextStep }` — rendered as a fixed-format labelled block.
2. In `compactWorkingSet()`: detect a leading prior-summary message (starts with `[Earlier conversation summary]`); **exclude it** from the transcript fed to the summarizer. Instead pass its parsed state to the summarizer prompt as "PRIOR STATE — merge new facts into this, drop nothing still relevant, output the same labelled sections."
3. The summarizer prompt (in `generateSummary()`) gains a `merge` mode emitting the fixed sections. Output replaces the old summary message wholesale.
4. Cap `memory.summaries` to the latest entry per session (or delete the array's role in `buildPrompt` if it is dead weight — verify usage first; `buildPrompt` currently does not inject summaries, only discoveries, so the array may be pure bloat).

**Source material.** Read Codex's compact template for the section design (Apache-2.0 — port the *approach*; if any prompt text is copied verbatim, add a NOTICE entry). Repo: `github.com/openai/codex`, path `codex-rs/core/src/codex/compact.rs` (verify current location).

**Acceptance.** New unit test in `tests/unit/`: run 3 successive compactions over a synthetic 40-message transcript; assert (a) the final summary contains facts from message 1 (no recursive loss of early goals), (b) exactly one summary message exists, (c) tool_use/tool_result pairing invariants still hold (reuse existing `findSafeCutPoint` tests).

---

### P3 · Model–harness fit: no per-model-family tool adaptation — S2

> **STATUS — core DONE 2026-07-14 (uncommitted).** `tools/apply-patch.ts`: fresh
> parser for the full envelope (Add/Update/Delete File, Move to, multi-hunk @@,
> implicit first hunk, EOF marker, line-numbered parse errors); hunks route through
> multi-edit's exported `applyOneEdit` (same 3-tier matching + unambiguity-or-error);
> whole patch validates in memory before ANY write; temp+rename writes with
> best-effort rollback; per-file post-edit syntax pass; hard workspace confinement in
> the handler + `patchTargetPaths`-based confinement in the PermissionBroker (prompt
> gating, like `worker`). Family gating: `toLlmTools(forModel)` — apply_patch
> advertised only to /^(gpt-|o[134]|codex)/, registered for all, resolved once per
> loop (cache-stable); agent-loop + plan-runner pass their models. 12 parser/apply
> tests + 3 broker tests; 239 tool-registry+permissions tests green.
> Open: before/after eval delta on a live OpenAI-family model (needs a key);
> Anthropic fine-grained tool streaming / context-editing SDK check (needs live API).

**Root cause.** One generic tool schema set is presented to all 8 providers. OpenAI/Codex-family models are RL-trained on the `apply_patch` format; forcing them through `edit_file` string-replace fights their training. (Anthropic models are trained on string-replace editing — `edit_file` is already correct for them.)

**Progress note (re-audit).** `reliability-policy.ts` now adapts loop *behavior* per model family (budget models get extra retries/nudges) — a real first slice of model fit. Tool-*format* adaptation (`apply_patch`) remains fully open and is this item's substance.

**Prescription.** A model-family adapter layer:

1. In `packages/tool-registry`, add `apply_patch` as an alternative edit tool: accepts Codex's patch envelope format (`*** Begin Patch / *** Update File: path / @@ context hunks / *** End Patch`). Port the format parser semantics from `github.com/openai/codex` (Apache-2.0; locate the apply_patch implementation in `codex-rs` — verify path in-repo). **Do not port their file-writing code** — parse the patch, then route each hunk through the existing Rust `edit_file` executor (`crates/alan-tools/src/edit_file.rs`) so hash-guarding, atomicity, and post-edit syntax diagnostics (`tools/diagnostics.ts`) apply identically.
2. Registry gains per-model-family tool selection: a small map (Anthropic → `edit_file`/`multi_edit`; OpenAI family → `apply_patch` (+ `edit_file` retained as fallback); others → current default). Hang it where tier routing already lives — the engine resolves model per turn, so the registry's `toLlmTools()` needs a `forModel(model)` variant. Keep the advertised set **stable within a session** (cache discipline — see the header comment in `prompts.ts`).
3. While in the gateway: verify Anthropic fine-grained tool streaming and any context-editing API the SDK now exposes; adopt if available without breaking the existing `cache_control` placement (`providers/anthropic.ts` lines ~273–400).

**Acceptance.** Eval suite (P1) run twice on an OpenAI-family model — before/after — shows edit-task success delta; unit tests cover patch parsing edge cases (multi-hunk, create/delete file, context mismatch → clean error, never partial application).

---

### P4 · LSP semantic feedback loop — S2 **[REVISED after re-audit: ~70% closed]**

> **STATUS — DONE 2026-07-14 (uncommitted).** `tools/lsp/feedback.ts`:
> `withLspFeedback` wraps write_file/edit_file/multi_edit (inside freshness, beside
> the syntax pass); pulls `LspServerManager.diagnostics` with a 1.5s budget
> (readiness-gate timers unref'd so an abandoned race can't hold the process),
> appends severity-error-only `lsp_check` to the tool result; ONE manager shared
> with the `lsp` tool (builtin.ts refactored — no second server set). Opt-in
> `[lsp] autoFeedback = true` plumbed config→engine→module state, default OFF.
> Doctrine line verified present (prompts.ts:97). Fixture gained `--mute`;
> 4 new tests (on / off-default / budget-under-4s / pass-through) + existing
> client suite green. Open: eval delta on typed-language tasks to justify
> flipping the default (needs live runs); warm-path p95 latency measurement.

**Status change.** The LSP *infrastructure* now exists and is good: `packages/tool-registry/src/tools/lsp/` ships a full client (tsserver, pyright, rust-analyzer, gopls) with lazy spawn, mtime-keyed document sync, a readiness gate on first `publishDiagnostics`, zombie-proof teardown, and an on-demand `lsp` tool (definition/references/hover/diagnostics, auto-permission, parallel-safe). Tests exist (`tests/unit/tool-registry/lsp-client.test.ts`, `tests/fixtures/lsp/fake-lsp-server.ts`). **The OpenCode port is no longer needed** — study their repo only if a design question arises.

**Remaining gap (the actual OpenCode edge).** Diagnostics are pull-only: the model must *choose* to call `lsp diagnostics`. The post-edit path (`tools/diagnostics.ts`) is still syntax-only, so automatic same-turn self-correction on type errors doesn't happen unless the model is disciplined.

**Prescription (remaining work only).**
1. After a successful `write_file`/`edit_file`/`multi_edit` on a supported extension, call `LspServerManager.diagnostics()` for that file and append errors (not hints) to the tool result — same append mechanics `diagnostics.ts` already uses. Reuse the running manager instance registered in `builtin.ts` (~line 277); never spawn a second one.
2. Guards: 1.5s budget on the post-edit pull (the manager's readiness gate can wait up to 10s on first open — that's fine for the on-demand tool, too slow for the edit path; use a short timeout and fall back to the syntax pass); server must already be running or spawn must be non-blocking for the edit result; per-project opt-in `.alan/config` `[lsp] autoFeedback = true`, default off until eval-proven.
3. Consider a doctrine line in `prompts.ts` telling the model the `lsp` tool exists for symbol truth (verify one was/wasn't added — the prompt diff touched this area).

**Acceptance.** Unit test: edit introducing a type error in the fixture project → diagnostic appears in the same tool result when autoFeedback is on; syntax-pass-only when off. Eval (P1): typed-language pass-rate delta. Latency: p95 added per edit < 300ms warm.

---

### P5 · Retrieval is lexical-only — S2 **[REVISED: partially advanced]**

> **STATUS — DONE 2026-07-14 (uncommitted; embeddings stage deliberately deferred).**
> FTS5 verified compiled into bundled rusqlite. New `alan-index/src/search.rs`:
> `CodeSearch` — FTS5 table over tree-sitter symbol chunks (reuses repo_map's
> collector/parser, whole-file fallback chunk for declaration-less files), porter
> tokenizer with `_` tokenchars, incremental refresh by (mtime,size) with vanished-
> file cleanup, AND-first/OR-fallback query sanitization (operator chars can't break
> MATCH), hybrid rank = bm25(symbol×2, content×1) − symbol/path term boosts.
> Bridged as `alan-tools search-code` (db at `.alan/search.db`, gitignored) and
> advertised as `search_code` (read/auto → parallelizes free). **Measured on this
> repo: cold 347 files in 563ms (budget 10s), incremental 12ms (budget 500ms);
> live relevance: "where is the compaction summary merged with prior state" →
> compactWorkingSet #1, generateSummary #2.** 5 Rust tests + 1 end-to-end eval task
> (34/34 mock suite). Embeddings: only if evals demand it, per plan.

**Status change.** A native request-aware repo map landed (`crates/alan-index/src/repo_map.rs` ~850 lines, bridged through `alan-tools`, injected as budgeted `retrievedChunks` — see `packages/orchestrator/src/repo-map.ts` and the engine wiring). Structural retrieval is no longer a static file tree. The FTS5/BM25 step below is still open and is now the whole of this item.

**Root cause (remaining).** No ranked full-text search: grep/glob/symbol_search plus the structural map, but nothing answering "where do we handle stripe webhook retries" by relevance. Cursor's semantic index is its large-repo differentiator.

**Prescription.** Staged, local-first:

1. **BM25 via SQLite FTS5 inside `crates/alan-index`** (rusqlite is already a workspace dep with `vtab`; verify the bundled build has FTS5 enabled — `sqlite3_compileoption_used("ENABLE_FTS5")` — enable the feature flag if not). Index symbol-chunked content (the tree-sitter chunker in `repo_map.rs`/`index.rs` already exists). Expose as a `search_code` tool (registry category `read`, `permissionLevel: auto` → it parallelizes for free in the loop's Phase B).
2. **Hybrid ranking:** FTS5 score × the repo-map's existing symbol ranking. Incremental reindex on file mtime change.
3. **Embeddings later, only if evals demand it** — via local Ollama to preserve the local-first story. Do not add a cloud vector dependency.

**Acceptance.** `search_code "where are stripe webhook retries handled"`-style eval tasks (add to P1 suite) beat grep-only baseline on fixture repos; index build < 10s on this repo; incremental update < 500ms per file.

---

### P6 · Sessions are process-bound — S2

> **STATUS — core DONE 2026-07-14 (uncommitted).** engine-host gained `--socket
> <path>`: the SAME protocol frames over a unix domain socket — responses to the
> requesting client, streams broadcast to all clients, chat events tagged with
> sessionId in socket mode (stdio/desktop contract byte-identical); stale-socket
> probe (live host → refuse, dead → reclaim), socket unlinked on shutdown. New
> `host-client.ts` (line-buffered request/stream client) + `worktree.ts`
> (create/list/remove `.alan/worktrees/<run>` on `berne/run-*` branches). CLI:
> `berne detach "<prompt>"` (per-run host, registry at ~/.alan/run/, `--worktree`
> isolates) and `berne attach <session|latest>` (replay + live stream + Ctrl+C
> detaches). **Proven:** host survives an abruptly-killed client and serves the
> next one the same session (integration test); two worktrees are disjoint and
> merge back by ordinary git (4 tests). Open: live end-to-end detached CHAT run
> against a real provider (transport+isolation are proven; the full loop needs a
> key), richer attach rendering, idle-host reaping.

**Root cause.** OpenCode survives disconnects via client/server; Berne's CLI dies with the terminal. The split already exists in design: `packages/orchestrator/src/bin/engine-host.ts` + SQLite session store + `resumeSession()` in `engine.ts` (line ~1134).

**Prescription.**

1. Finish `engine-host` as a headless server: local socket/HTTP on a unix socket, speaking the protocol in `packages/shared/src/protocol.ts`; CLI becomes a thin attach/detach client (`--detach`, `berne attach <session>`). Event replay on reattach already exists (`resumeSession` replays transcript) — the missing part is the live process surviving client exit.
2. Background runs: per-run **git worktree isolation** (`git worktree add`) so a detached run cannot collide with the user's working tree; merge-back = ordinary git. This composes with the `worker` ownership model rather than replacing it.

**Acceptance.** Start a run, kill the terminal, reattach, receive the completed transcript; two concurrent detached runs on the same repo do not touch each other's files.

---

### P7 · Circuit breaker defeated by trivial arg variance — S3, small

> **STATUS — DONE 2026-07-14 (uncommitted).** New `call-signature.ts`: two-strength
> normalization (both fold whitespace/key-order/UUIDs/timestamps/long-hex;
> `breakerSignature` additionally folds ALL numbers — port-hopping on a failing bind
> is the target; `batchSignature` keeps small numbers distinct so paginated reads
> can't read as a fake loop). Wired into both the failure breaker (read + record
> sites share the key) and the repeated-batch detector; refusal message now shows
> the model its literal args and names the variant-folding. 12 new tests both
> directions; all 610 orchestrator tests green.

**Root cause.** `agent-loop.ts`: `failedCalls` and loop-detection signatures key on exact `toolName:argsJson` (lines ~785, ~900, ~1002). A model that mutates whitespace, a timestamp, or a port re-runs a doomed call unbounded. The repo already contains the needed normalizer: `commandsAreVariants` in `packages/orchestrator/src/notebook/capture.ts`.

**Prescription.** Normalize signatures before keying: collapse whitespace, strip volatile tokens (numbers in ports/timestamps/UUIDs), reuse/extract the variant logic from `capture.ts` into a shared helper. Apply to both the breaker map and the repeated-batch detector. Keep the raw args in the refusal message so the model sees what it actually sent.

**Acceptance.** Unit tests: two bash calls differing only in whitespace/timestamp count as the same signature; genuinely different commands do not.

---

### P8 · No plugin packaging layer — S4

> **STATUS — DONE 2026-07-14 (uncommitted).** New `plugins.ts`:
> `.alan/plugins/<name>/plugin.json` manifest (hooks/mcp/commands declared by
> relative path — paths escaping the plugin dir refuse; skills/ auto-discovered).
> Merged into all four loaders with provenance: skills root `.alan/plugins` (loader's
> path attribution names skills after their plugin), hooks concatenate AFTER user
> hooks (`loadHookConfig(root, extraFiles)`), MCP servers into `extraServers` (user
> mcp.json still overrides by name; cross-plugin name conflicts refuse the later
> plugin), commands tagged `source` (user names win; plugin shadowing refused with
> warning). Uninstall = delete directory (proven). Engine `listPlugins()` for
> attribution surfaces. 8 unit + 2 engine-integration tests; hooks/commands suites
> green.

**Root cause.** Skills (`.alan/skills/`), hooks (`.alan/hooks.json`), MCP (`.alan/mcp.json`), and commands (`.alan/commands/`) exist as four separate loaders with no bundle format — nothing shippable/installable as a unit for future customers.

**Prescription.** A `plugin.json` manifest (`.alan/plugins/<name>/`) declaring bundled skills/hooks/mcp/commands by relative path; a loader that merges each into the existing four loaders with provenance tags (so `/skills` and `/status` can attribute origin, and uninstall = delete directory). Model the manifest shape on pi's extension packaging and Claude Code's plugin bundle concept — study for design, implement fresh (no code port needed at this size).

**Acceptance.** A fixture plugin bundling one skill + one hook + one MCP server loads, functions, and uninstalls cleanly; conflicting names refuse to load with a clear error.

---

### P9 · Compliance story not productized — S1 for the chosen niche

> **STATUS — DONE 2026-07-14 (uncommitted).** New `org-policy.ts`: Ed25519-signed
> policy at root-owned system paths (`/etc/berne/policy.json` + separate
> `/etc/berne/org.pub` trust anchor; macOS `/Library/Application Support/Berne/`;
> env override honored ONLY when no system policy exists). Keys: toolsDeny/
> toolsAllow, forbidPermissionModes, networkDefaultDeny, providerAllow/modelAllow
> (prefix `*`), telemetryEndpoint pin (field reserved). Enforcement: PermissionBroker
> checks policy FIRST — before yolo/turing, trust, and grants (all three proven
> unable to override); `setMode` refuses forbidden modes (Shift+Tab cycle skips,
> config yoloMode stripped at boot); per-turn model/provider allowlist gate in
> `chat()`. Present-but-invalid policy ⇒ engine REFUSES TO START. `/status` shows
> `⛨ org · fingerprint`. Admin tooling: `scripts/sign-policy.ts` (canonical-JSON
> signing, keygen). 12 unit + 3 engine-integration tests; 623 orchestrator tests
> + full typecheck green.

**Root cause.** The differentiators (signed exports via `signing.ts`, black box, redaction, local-first, kernel sandbox) exist as primitives, but a regulated buyer needs *policy*: admin-enforced constraints the end user cannot lift.

**Prescription.** A signed policy file at a system path (`/etc/berne/policy.json` + macOS equivalent; Ed25519-signed with an org key, verified with the machinery in `signing.ts`):

- Enforceable keys: tool allow/deny lists, forced permission mode (e.g., `turing` banned), network default-deny, mandatory session export + signature, telemetry endpoint pinning, model/provider allowlist.
- Enforcement point: `PermissionBroker` (`permissions.ts`) — policy denials are terminal (`{type:"denied"}`), checked **before** yolo/trust shortcuts (a policy must override `turing` mode — note current `check()` returns allowed immediately in yolo mode at line ~85; policy check must precede it).
- `/status` displays active policy + fingerprint; tampered/unsigned policy = refuse to start in enforced mode.

**Acceptance.** Unit tests: policy denies `bash` network escalation even in turing mode; unsigned policy rejected; no-policy behavior unchanged.

---

### P10 · Windows runs with silent noop sandbox — S4 **[REVISED: substantially implemented]**

> **STATUS — verifiable slices DONE 2026-07-14 (uncommitted).** (b) confirmed: the
> model-visible env block states the degraded posture verbatim (prompts.ts:236-241,
> "enabled but DEGRADED — no OS isolation backend…"), alongside banner/status/tool-
> description consumers. Unit coverage: sandbox-capability.test.ts (UNKNOWN fails
> safe, requireOs refusal). (a) REMAINS OPEN: end-to-end verification on a physical
> Windows machine (probe → banner → prompt behavior) — cannot be truthfully claimed
> from macOS. (c) WSL2 delegation: separate work order, unstarted, per plan.

**Status change.** `packages/tool-registry/src/sandbox-capability.ts` now distinguishes intent from ability: capability is probed (seatbelt/bwrap/none), UNKNOWN fails safe to "not isolated", and `permissions.ts` `isWorkspaceConfined` requires `isSandboxEnabled() && isOsIsolationAvailable()` before auto-approving bash — exactly the original prescription. A `[sandbox] requireOs` config key can refuse degraded runs outright. Status row, banner, and the model-facing bash description are documented as consumers.

**Remaining work.** (a) Verify end-to-end on an actual Windows machine (probe result, banner text, prompt behavior in auto mode) — all current evidence is from unit tests (`sandbox-capability.test.ts`). (b) Confirm the env block in `prompts.ts` states the degraded posture in the model-visible text, not just the UI. (c) WSL2 delegation remains a later, separate work order — do not attempt AppContainer.

**Acceptance.** On a noop-capability machine: banner shown, bash prompts in auto mode, env block states the absence of OS isolation, `requireOs = true` refuses sandbox-tier bash with a clear error.

---

## 2. Execution order

| Phase | Items | Rationale |
|---|---|---|
| 0 | P1 (minimum viable: 30 tasks + CI + baseline), `THIRD_PARTY_NOTICES.md` | Everything after this is measured. Do not skip to the fun parts. |
| 1 | P2, P7 | Pure correctness, small diffs, immediately testable. |
| 2 | P3, P4 | The capability gaps with measurable eval deltas (require Phase 0 to prove). |
| 3 | P5, P9 | Retrieval + the compliance moat. |
| 4 | P6, P8, P10 | Durability, packaging, platform honesty. |

Dependencies: P3/P4/P5 effect sizes are only knowable via P1. P9 depends on nothing but should land before any external pilot. P6's worktree isolation should land before advertising parallel background runs.

## 3. Source-material summary (what to take from where)

| From | License | Take | Into |
|---|---|---|---|
| `github.com/openai/codex` (codex-rs) | Apache-2.0 | Compaction template design (`compact.rs`); `apply_patch` format + parser semantics | P2, P3 |
| `github.com/anomalyco/opencode` | MIT | ~~LSP client lifecycle~~ (no longer needed — Berne now has its own; reference only for auto-feedback design questions) | P4 |
| `github.com/badlogic/pi-mono` | MIT | Extension/packaging manifest design (study, reimplement) | P8 |
| SWE-bench / Terminal-Bench | public benchmarks | External eval anchors | P1 |

Claude Code and Cursor are closed-source: study behavior from docs/blogs only; never from decompiled sources.

## 4. Standing verification protocol (every phase)

1. `bun test tests/unit/` green; `cargo test` green.
2. `bun run eval -- --compare tests/eval/baseline.json` — no regression beyond recorded noise band; improvements update the baseline in the same change.
3. New unit tests accompany every fix listed above (each Acceptance section is the test spec).
4. For loop/context changes (P2, P7): additionally run one live end-to-end session against a real provider on this repo ("add a failing test, fix it") and read the transcript for pairing violations or breaker misfires.
5. Update this document's problem register — mark items `DONE <date, commit>` — so the next session inherits current state.
