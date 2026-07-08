# PROJECT ALAN — Blueprint v2.0 (Reconciled & Refined)

**Codename:** Alan
**Class:** Sovereign Agentic Coding System (CLI core + Desktop shell)
**Author:** Savoir Studio
**Status:** Blueprint v2.0 — supersedes v1.0 for planning; v1 (`Alan-Blueprints.md`) kept as the original target spec
**Date:** 2026-07-04
**Method:** every claim below was verified against the working tree at commit `ea68d01` on `feat/reliability-and-tooling` (709 unit tests green). This is not aspiration — Part I is an audit, Part II is the delta, Part IV is the path.

---

# PART I — SCORECARD: v1 BLUEPRINT vs. REALITY

v1 was written pre-implementation. Since then, **v1's Phases 0–3 are done, Phase 4 is mostly done, Phases 5–6 are partially done, Phase 7 is not started.** The remaining work is depth, proof, and distribution — not greenfield construction.

| v1 Component | Spec (v1 §) | Reality | Verdict |
| --- | --- | --- | --- |
| Orchestrator / agent loop | 3.1, 3.3 | `packages/orchestrator/src/agent-loop.ts` — hardened flat loop: verification step, execution-evidence gate, per-call repeated-failure breaker, rate-limit wait-and-resume, parallel tool calls, bounded fan-out, stuck-nudge | **DONE** (flat tier) |
| Planner-Executor split | 3.3 | `planner.ts` + `plan-runner.ts` exist, wired into `engine.chat()` behind `plannerMode` — **default false, never A/B-tested against the flat loop** | **PARTIAL** |
| Session Manager | 3.2 | `packages/shared/src/session.ts` — SQLite (bun:sqlite), append-only events, UUIDv7, resume + transcript replay, titles, archive/delete, `/rewind` (truncate-after-seq) | **DONE** minus fork & periodic checkpoints |
| Context Engine — working set + session memory | 3.4 | `context-engine.ts` — budget passes, pair-safe assembly, 30k tool-result caps, rolling compaction (`/compress`), thinking preservation, FileFreshness hash injection, system-memory "dreaming" | **DONE** (tiers 1–2) |
| Context Engine — long-term store | 3.4 | `crates/alan-index` (tree-sitter, symbol store) exposed as `symbol_search`/`ast_query` tools via `rust-bridge.ts` → `alan-tools` binary. **No embedding index, no background indexing at workspace open** | **PARTIAL** |
| Tool Registry | 3.5 | All v1 built-ins + `multi_edit`, `glob`, `todo_write`, background shells (`run_in_background`/`bash_output`/`kill_shell`), `ask_user`, `web_search`/`web_fetch`, 181 skills w/ progressive disclosure, custom loader (`custom-loader.ts`), `n8n_trigger` | **DONE++** (exceeds v1) |
| MCP client | 3.5 | `tool-registry/src/mcp/*` — production-grade: stdio+HTTP, capability negotiation, pagination, cancellation, ping health, live list_changed | **DONE** |
| MCP server wrapper (`alan-mcp`) | topology, Phase 6 | Not built | **MISSING** |
| Permission Broker | 3.6 | `permissions.ts` — modes (confirm/auto/turing) + scoped grants with regex arg patterns; TUI/CLI permission cards; desktop `PermissionModal.tsx` | **DONE** (auto-suggested scopes: partial) |
| Sandbox | 3.6 | `crates/alan-sandbox` — macOS seatbelt real & regression-tested (broad-read + credential denylist + workspace-confined writes + deny-net); Linux bwrap implemented; env curation real (`env_clear` + curated PATH/HOME/TERM/LANG); PathGuard canonicalization everywhere | **PARTIAL** — only `bash` is OS-sandboxed; file tools are PathGuard-only; `config.sandbox.enabled` is cosmetic; Linux profile never validated on real Linux; no Docker fallback tier |
| Audit log | 3.6 | `alan-sandbox/src/audit.rs` — hash-chained entries (args/result hashes, duration, exit code) | **DONE** |
| Auditable session export | v1 §6.4 | `session-export.ts` + `signing.ts` — tamper-evident, Ed25519-signed export w/ audit-chain verification, transcript, tool table, diffs | **DONE** (MD only; no PDF, no `alan verify` UX) |
| LLM Gateway | 3.7 | 8+ providers (Anthropic/OpenAI/Google/Ollama/Groq/xAI/DeepSeek/OpenRouter + local), streaming, retry/backoff, fast 429 fallback + Retry-After, prompt caching (`cache_control`), cost tracker, three-tier routing (heavy/standard/light), malformed-tool-JSON salvage | **DONE++** |
| Error handling taxonomy | 3.8 | All seven classes implemented (schema reject, stderr observation, re-prompt on malformed, loop breaker, compaction, sandbox kill, provider fallback) | **DONE** |
| Performance targets | 3.9 | **Never measured.** No benchmark exists for first-token latency, indexing throughput, resume time, or idle memory | **MISSING** |
| Desktop shell | 3.10, Phase 4 | Tauri 2 + React, Savoir design system; all v1 components exist (`SessionList/MessageStream/ToolCard/DiffViewer/PermissionModal/PlanPane/Composer/Settings`); real engine via `engine-host.ts` stdio sidecar; DMG built; live chat verified | **PARTIAL** — component depth vs. live engine events unproven (diff apply/reject, permission flow, plan pane); keys in `secrets.json` not OS keychain; no auto-update |
| CLI surface | Phase 1–2 | Far beyond v1: alt-screen TUI + inline scrollback, 18 themes, collapsed turn renderer, type-ahead queueing, sessions/keys/model/theme/memory/research/mcp/skills commands, mouse scroll, launch picker | **DONE++** |
| Daemon (`alan-core`, Unix socket JSON-RPC) | 2, Phase 0 | Not built. Engine runs in-process (CLI) or as stdio sidecar (desktop) | **DELIBERATELY DIVERGED** — see D1 |
| CI | Phase 0 | `ci.yml` — mac+linux matrix: fmt, clippy -D warnings, bun test, cargo test, release build, integration, mock-eval gate, secret-gated real-eval gate | **DONE** |
| Eval harness | Phase 1–2, 7 | Real harness (5 categories, baseline.json, throttle-exclusion protocol); **first real number: 94.7% clean ceiling (18/19)** — but the suite is ~19–25 tasks, tool-discipline starved, no SWE-bench | **PARTIAL** |
| Telemetry | stack table | `packages/telemetry` is a 28-line stub; no OTel | **MISSING** |
| Distribution | Phase 6 | No brew tap, no install script, no deb/rpm, no signed auto-update, `docs/` is empty | **MISSING** |
| Differentiator: n8n | §6.1 | `n8n_trigger` — webhook trigger only. v1's vision was workflow *injection/generation* | **PARTIAL** |
| Differentiator: local-only mode | §6.5 | Ollama/LM Studio first-class, reasoning-leak fixes, keyless DDG search — but never eval-certified end-to-end | **PARTIAL** |
| B2B (SOC2, pricing, partners) | Phase 7 | Not started | **MISSING** |

**Bottom line:** ~80% of v1's engine-level spec exists and is tested. The five real fronts are: **(1) measurement is too small to steer by, (2) the retrieval third tier + anti-drift loop are missing, (3) the trust stack is 70% built but unproven as a system, (4) surfaces/distribution are unfinished, (5) the differentiators are stubs of their intended selves.**

---

# PART II — GAP REGISTER (ranked by leverage)

Ranked against the locked direction: **reliable agent first, audit/compliance differentiator second, parity with Claude Code never.** Each gap has acceptance criteria — a gap is closed when the criteria pass, not when code lands.

### G1 — The eval compass is too small to steer by
19–25 tasks cannot detect a 5-point regression, and two of five categories (tool-discipline, new-feature) are starved. Every other gap's "done" depends on this one.
**Accept when:** ≥100 tasks across 6 categories (comprehension / fix-failing-test / multi-file-refactor / new-feature / tool-discipline / long-horizon), per-category floors tracked in `baseline.json`, nightly clean-ceiling run, and one published SWE-bench-Lite number with the harness committed.

### G2 — No semantic tier, no background indexing (Context Engine tier 3)
Retrieval today = lexical (grep) + symbolic (symbol_search on demand). No embeddings, no cold-start indexing, index freshness invisible to the agent.
**Accept when:** workspace open triggers background indexing with progress + freshness events in the session log; embedding index over AST-boundary chunks queryable via a `semantic_search` tool; retrieval ladder (lexical→AST→semantic) returns *ranges, not files*; a new retrieval eval category shows the ladder beats lexical-only.

### G3 — Anti-drift is half-built (v1 §4.4)
FileFreshness injects hash-mismatch warnings, but nothing *validates the agent's claims* about file contents before they reach the user.
**Accept when:** assertions in final answers that cite code carry `(path, hash, range)`; the orchestrator verifies cited ranges against current content and forces re-read + rerun on mismatch; drift eval tasks (mutate file mid-session) pass.

### G4 — Sandbox coverage is honest nowhere but bash
Only `bash` runs under the OS sandbox. File tools are PathGuard-only. `config.sandbox.enabled` toggles nothing. Linux bwrap has never run on Linux. No network allowlist per session. No high-risk Docker tier.
**Accept when:** the sandbox matrix (tool × platform × guarantee) is documented and every cell is either enforced or explicitly marked "path-guard only"; `config.sandbox.enabled` is real or removed; Linux profile passes a containerized CI job with escape-attempt tests; per-session network allowlist enforced in the seatbelt/bwrap profiles.

### G5 — No threat model, no adversarial proof
The trust stack (sandbox + audit chain + signed export) is the differentiator, and it has never been attacked.
**Accept when:** threat-model doc published in `docs/`; a security test suite (path escapes, symlink games, env exfil, prompt-injection→tool-abuse scenarios) runs in CI; one external pen-test pass completed with no Critical/High open.

### G6 — Planner-Executor is unproven, default-off
The flat loop got all the hardening; PlanRunner never got an A/B. v1 assumed the split wins — that's an assumption, not a result.
**Accept when:** PlanRunner A/B'd against the flat loop on the full eval suite (≥50 long-horizon tasks); promoted to default only if it wins by a margin; if it loses, it's demoted to `/plan` opt-in and the blueprint stops claiming it.

### G7 — No checkpoints, no session fork
`/rewind` exists; periodic checkpoints and fork-to-branch do not. Long-horizon reliability needs restore points.
**Accept when:** checkpoint event every N turns + on-demand; `alan fork <id>` clones a session at a seq; crash recovery offers rollback-to-checkpoint on dirty session detect.

### G8 — Desktop components exist but the deep wiring is unproven
DiffViewer/PermissionModal/PlanPane exist as components; whether per-hunk apply/reject, live permission prompts, and live plan updates actually flow through `engine-host.ts` end-to-end has not been verified since the real-engine bridge landed.
**Accept when:** a scripted desktop E2E (tauri-driver or Playwright against dev server) exercises: permission prompt → allow-once, a multi-hunk diff → apply one hunk reject another, plan pane updates during a planner run; daily-dogfood for one week with zero blocker bugs.

### G9 — Alan is an MCP client but not an MCP server
`alan-mcp` (v1 topology, third client) doesn't exist. It's cheap now — the engine is a library and the MCP types are already in-repo.
**Accept when:** `alan mcp-serve` exposes engine tools (read-only set by default) over MCP stdio; verified working from Claude Desktop and one other MCP client.

### G10 — No telemetry, no measured performance
`packages/telemetry` is 28 lines. None of v1 §3.9's six targets has ever been measured.
**Accept when:** local-first structured event log (opt-in remote later); `bench/` scripts measure all six §3.9 targets in CI (regression-gated on the two that matter most: first-token latency, session-resume time); numbers recorded in docs.

### G11 — Zero distribution
No install path but `git clone`. `docs/` is empty. No signed releases, no auto-update, no changelog discipline.
**Accept when:** `curl | sh` installer + brew tap live; versioned GitHub releases with signed artifacts; Tauri auto-updater with kill switch; docs site covering install, quickstart, every command, config reference, sandbox guarantees.

### G12 — n8n differentiator is a stub of its vision
`n8n_trigger` fires webhooks. The moat (v1 §6.1) is *generation*: the agent writes/edits workflows.
**Accept when:** `n8n_workflow` tool set (list/get/create/update/activate via n8n REST API) + a workflow-JSON validation layer + dry-run; demo: "build me a workflow that watches Gmail and posts to Slack" produces a working workflow on a real n8n instance; 10-task n8n eval category.

### G13 — Local-only mode is plumbed but uncertified
Providers work; nobody has proven the *agent* works acceptably fully-local.
**Accept when:** the eval suite runs fully-local (Ollama + qwen-coder class model, keyless DDG) and the floor is published honestly in docs — even if the number is modest, "measured local floor" is itself the differentiator.

### G14 — Windows posture undecided
`noop.rs` sandbox, no CI, no packaging. Silence reads as "broken" to users.
**Accept when:** a one-paragraph decision is published in docs (recommended: PathGuard-only with explicit warning banner, no OS sandbox claim, CI build-only job) — not when Windows is "supported."

### G15 — B2B pack not started
License undecided, pricing undecided, no partners, no SOC2.
**Accept when:** license locked (see D6), 5 design partners onboarded with weekly feedback, pricing decided *from* partner feedback, SOC2 Type 1 engagement started only after first paying intent.

---

# PART III — ARCHITECTURE DECISIONS LOCKED (deltas from v1)

These close v1's Appendix B and codify where reality already diverged correctly. Stop relitigating these.

**D1 — No daemon. Engine-as-library with three hosts.**
v1's Unix-socket `alan-core` daemon is dead. The engine is a TS library embedded in-process by the CLI, spawned as a stdio sidecar (`engine-host.ts`) by desktop, and (next) wrapped as an MCP server. What replaces the daemon spec: **formalize the engine-host JSON-lines protocol** in `packages/shared` (versioned schema, documented) so all hosts speak one contract. Revisit a socket daemon only if a real multi-client concurrent-session demand appears.

**D2 — The Rust/TS boundary is settled.**
Rust = `alan-tools` binary (file ops, bash+sandbox, grep, index/symbol-search) + `alan-sandbox` + `alan-index`. TS = everything else (loop, context, gateway, registry, surfaces). No `alan-core`/`alan-cli` Rust crates, ever, unless D1 is reopened.

**D3 — The flat hardened loop is the default until data says otherwise.**
All reliability machinery (evidence gate, breakers, verification) lives on the flat loop. PlanRunner is promoted by eval victory (G6) or demoted honestly. No architecture by vibes.

**D4 — Retrieval ladder stays lexical → AST → semantic, returning ranges.**
Semantic tier is built *last* and must prove lift in evals (G2). Embedder is local-first (Ollama `bge`-class), keyed-API fallback optional. Store: start with sqlite-vec in the existing SQLite; LanceDB only if scale forces it.

**D5 — Windows is PathGuard-only until after distribution phase.** Stated in docs, warning at runtime, CI build-only. No sandbox claims on Windows.

**D6 — v1 Appendix B, closed:**
1. **License:** open-core — engine (packages/ + crates/) Apache-2.0, desktop app + compliance pack commercial.
2. **Providers:** already answered by reality — multi-provider BYOK with three-tier routing; Anthropic recommended default, local mode first-class.
3. **Telemetry:** opt-in only, local-first JSONL, anonymous aggregate opt-in later. Never default-on.
4. **Auto-update:** on by default for desktop, signed, kill switch. CLI updates via brew/installer only.
5. **Workspace:** single workspace per session (current behavior) — locked for v1.0; multi-workspace is a desktop-era feature.
6. **Pricing:** decided in R7 from design-partner feedback, not before.

---

# PART IV — EXECUTION PLAN (R1–R7)

Rules of engagement (how this project actually runs):
- **No time estimates.** Phases are ordered by dependency and exited by criteria, not dates.
- **Evidence-gated done:** nothing is "done" without the stated verification actually run (tests + typecheck + live/PTY validation where UI is involved + eval where behavior is involved).
- **Parallel lanes with disjoint file ownership.** Lanes below are designed so sub-agents can run concurrently without merge collisions; cross-lane needs are expressed as contracts (types in `packages/shared`) agreed before fan-out.
- R1 starts first and never stops (the compass runs continuously). R2 and R3 are parallel lanes. R4 needs R1's suite. R5 can start after R3's permission semantics settle. R6 needs R5. R7 rides on R3+R6.

---

### R1 — MEASUREMENT (the compass) — closes G1, G10-perf
*Lane owns: `tests/eval/**`, `bench/**`, `.github/workflows/ci.yml` (eval jobs only).*

1. Grow the suite to ≥100 tasks: +20 tool-discipline (the starved tail: parallel-call usage, no-redundant-reads, edit-after-read discipline), +20 new-feature, +15 long-horizon (20–40 turn sessions on a 50k-line fixture repo), +10 drift tasks (mutate files mid-session — feeds G3), top up the rest.
2. Per-category floors in `baseline.json`; CI real-eval gate fails on any category dropping >5 points below floor (keep the throttle-exclusion protocol — never let 429s masquerade as failures).
3. Nightly scheduled clean-ceiling run (secret-gated, cheap tier for bulk + heavy tier for long-horizon), trend file committed to a `results/` branch or artifact.
4. SWE-bench Lite: build the adapter harness (repo checkout → alan non-interactive run → patch extraction → official scorer), run once on the heavy tier, publish the number in README with the harness commit hash. The first number will be humbling; publish it anyway — it's the baseline for every later claim.
5. `bench/` scripts for all six v1 §3.9 targets (first-token latency cached/uncached, tool roundtrip, cold-index throughput, budget-hit rate, resume time on a 1k-event session, idle RSS). Wire the two cheapest (resume time, tool roundtrip) into CI as regression gates; record all six in `docs/performance.md`.

**Exit:** suite ≥100 w/ per-category floors enforced in CI; SWE-bench Lite number published; §3.9 table filled with measured values.
**Verify:** the CI gate actually failing on an injected regression (test the test).

---

### R2 — CONTEXT DEPTH (retrieval v2 + anti-drift) — closes G2, G3
*Lane owns: `crates/alan-index/**`, `packages/orchestrator/src/context-engine.ts`, new `packages/orchestrator/src/retrieval.ts`, `tool-registry` search tools. Contract with R1: retrieval eval category task format.*

1. **Background indexing:** `alan-tools index --watch`-style subcommand; engine triggers it on session start; progress + completion land as `system_note` events (agent sees "index: 42% — symbol results may be partial", satisfying v1 §4.3); freshness stamp on every index-backed tool result.
2. **Embedding tier:** chunk at AST function boundaries (alan-index already has the parse); embed via local Ollama embedder with graceful "semantic tier unavailable" degradation when no local model; store vectors in sqlite-vec inside the existing index DB; expose `semantic_search(query, k)` tool.
3. **Retrieval ladder:** one `retrieval.ts` entry point — lexical (rg) first, symbolic second, semantic third, early-exit on confident hits; returns scored *ranges*; Context Engine inlines or summarizes each range by remaining budget (v1 §3.4 verbatim — the design was right, it just wasn't built).
4. **Discoveries ledger:** structured `discovery` session events ("auth lives in services/auth/jwt.go, HS256") written by the loop when verification confirms a fact; injected into session-memory tier; distinct from the global system-memory guide.
5. **Citations loop (G3):** final-answer post-pass extracts code claims with `(path, hash, range)`; orchestrator validates against current file; mismatch → forced re-read + one bounded rerun; then surface honestly ("file changed during session") rather than loop.

**Exit:** retrieval eval category shows ladder > lexical-only by a real margin; 30-turn/50k-line eval passes without context overflow; drift tasks from R1 pass.
**Verify:** eval numbers, plus one live session on this very repo demonstrating semantic hit where grep misses (paraphrase queries).

---

### R3 — TRUST STACK COMPLETION (the differentiator) — closes G4, G5, export polish
*Lane owns: `crates/alan-sandbox/**`, `crates/alan-tools/src/bash.rs`, `session-export.ts`, `signing.ts`, `docs/security/**`. No overlap with R2.*

1. **Sandbox truth matrix:** document tool × platform × guarantee; make `config.sandbox.enabled` real (route file tools through the sandboxed binary path when on) or delete the flag; keep PathGuard as the always-on inner ring.
2. **Linux validation:** CI job runs the bwrap profile inside a privileged container with an escape-attempt suite (write outside workspace, read `~/.alan/secrets.json`, network egress, symlink traversal, `/proc` games) — mirror of the 6 macOS seatbelt regression tests, plus the SIGABRT-class regression test pattern.
3. **Network allowlist per session:** permission grant type `network:<host-pattern>` flows into the seatbelt/bwrap profile generation; deny-by-default stays.
4. **High-risk Docker tier:** optional third tier for `sandbox`-level tools when Docker present; read-only workspace bind + tmpfs scratch; auto-detect, never required.
5. **Threat model:** `docs/security/threat-model.md` — assets, adversaries (malicious repo content / prompt injection → tool abuse / supply-chain MCP servers), trust boundaries (the engine-host protocol, MCP subprocesses, model outputs), mitigations mapped to code, known gaps stated plainly (Windows, file-tool ring).
6. **Security test suite in CI:** the escape suite from (2) on both platforms + prompt-injection→tool-abuse scenario tests at the loop level (hostile file content instructing exfil; assert permission gate + allowlist hold).
7. **Export UX:** `alan export <session> [--pdf] [--sign]` + `alan verify <file>` as first-class commands; PDF via headless render of the existing MD (keep MD canonical, PDF is presentation); include audit-chain verification result *inside* the report header.
8. **Pen-test prep → engagement:** scope doc from the threat model; engage after (1)–(6) are green.

**Exit:** matrix documented with zero dishonest cells; escape suite green on mac+linux CI; `alan export --sign` → `alan verify` round-trips; threat model published; pen-test scheduled or done with no Critical/High open.
**Verify:** run the escape suite live on macOS locally (the seatbelt work already has the harness pattern); containerized Linux run in CI.

---

### R4 — LONG-HORIZON AGENCY — closes G6, G7
*Lane owns: `plan-runner.ts`, `planner.ts`, `packages/shared/src/session.ts` (checkpoint/fork), TUI plan rendering. Starts after R1's long-horizon tasks exist.*

1. **Checkpoints:** `checkpoint` event every N turns + before any multi-file edit burst; `alan fork <id> [--at seq]`; dirty-session detect on startup → offer rollback (v1 Phase 5 crash-recovery item, moved here where it belongs with session machinery).
2. **Planner A/B:** run flat vs. PlanRunner on the full suite, three seeds, cost-normalized (planner on heavy tier, executor on standard — the routing already exists). Decision by data: promote, keep opt-in, or delete. Write the result into this doc.
3. **If promoted:** plan-as-artifact UX — editable steps (reorder/edit/mark-done) in TUI + desktop PlanPane (v1 §6.3); replan triggers per the v1 state machine (K-step re-eval, 2-strike step failure → replan) — the loop breaker from the flat loop already provides the 2-strike primitive.
4. **If not promoted:** `/plan` remains a user-invoked mode; long-horizon reliability continues to ride the flat loop + checkpoints.

**Exit:** A/B result recorded with numbers; checkpoints + fork shipped and exercised by a crash-recovery integration test.
**Verify:** kill -9 the CLI mid-session in a PTY test; restart offers rollback; fork produces divergent sessions.

---

### R5 — SURFACES TO ENGINE PARITY — closes G8, G9, keychain, auto-update
*Lane owns: `apps/desktop/**`, `engine-host.ts` protocol, new `packages/orchestrator/src/bin/alan-mcp.ts`. Contract: protocol schema versioned in `packages/shared` first (D1).*

1. Formalize + version the engine-host protocol (D1); typecheck both sides against the shared schema.
2. Desktop E2E harness (Playwright against `tauri dev`, or tauri-driver): scripted flows for permission modal (allow-once/deny), multi-hunk diff (apply one, reject one, verify file state), plan pane live updates, session resume.
3. Fix what the E2E finds (the components exist; assume wiring gaps until proven otherwise).
4. Keys → OS keychain via Tauri keyring plugin; `secrets.json` stays for CLI/headless with its 600-perms behavior; migration prompt in Settings.
5. Auto-update: Tauri updater, signed artifacts, kill-switch flag in config (D6.4).
6. **`alan-mcp` (G9):** thin host exposing engine tools over MCP stdio — read-only tool set by default (`read_file`/`grep`/`list_dir`/`symbol_search`/`semantic_search`), full set behind an explicit flag; session-per-connection; verified from Claude Desktop.
7. Context inspector (v1 §3.10 debug pane): what's in the window, per-item token cost — desktop-only power feature; the Context Engine already computes budgets, this is exposure not new logic.

**Exit:** E2E suite green in CI (headless where possible); one week of daily desktop dogfood, zero blockers; `alan-mcp` demoed from an external client.
**Verify:** the E2E suite itself + dogfood log.

---

### R6 — DISTRIBUTION, TELEMETRY, DOCS — closes G11, G10-telemetry, G14
*Lane owns: `docs/**`, `scripts/install/**`, release workflows, `packages/telemetry`.*

1. Release pipeline: tagged versions → GitHub Releases with signed macOS (notarized) + Linux artifacts; changelog discipline (conventional commits already in use — generate).
2. Install: `curl -fsSL … | sh` + `brew tap savoir/alan`; deb/rpm after.
3. Docs site (docs/ is empty today): quickstart, install, every command, config.toml reference, provider setup incl. local-only, sandbox guarantees page (the R3 matrix, verbatim — honesty as marketing), threat model, performance numbers (R1), export/verify guide.
4. Telemetry v1: opt-in, local JSONL of structured events (session counts, tool latency histograms, error classes — no content, no paths); `alan telemetry status|on|off`; remote aggregation deferred until there's a reason.
5. Windows posture published (D5): docs page + runtime warning banner + CI build-only job.

**Exit:** a stranger on a clean Mac goes install → first session → export in under 10 minutes using only the docs.
**Verify:** actually run that scenario on a clean macOS VM/user account.

---

### R7 — VERTICALS & B2B — closes G12, G13, G15
*Lane owns: `tool-registry/src/tools/n8n*.ts`, eval n8n category, `docs/compliance/**`, commercial collateral. Rides on R3 (trust story) + R6 (installability).*

1. **n8n generation (the moat, v1 §6.1):** `n8n_workflow` tool family — list/get/create/update/activate via REST API (API-key auth from `/keys`); workflow-JSON schema validation before submit; dry-run mode returning the diff of nodes/connections; `n8n_trigger` retained for execution. 10-task eval category on a disposable n8n instance (docker-compose fixture in `tests/fixtures/`).
2. **Local-only certification (G13):** full eval suite on Ollama qwen-coder class; publish the measured local floor in docs; fix the top-3 local-specific failure modes (tool-JSON salvage already exists — expect prompt-format issues next).
3. **Compliance pack (commercial):** session export + retention policy template + audit-chain verification guide + (post-pen-test) the security report summary. This is the sellable artifact for compliance-conscious buyers (v1 §6.4).
4. **Design partners:** 5 from the Savoir network; free white-glove; weekly feedback; their usage drives the eval suite's new tasks (real tasks > synthetic).
5. **License execution (D6.1):** split LICENSE files, CLA if outside contributions wanted; then pricing from partner signal; SOC2 Type 1 only after first paying intent.

**Exit:** n8n demo on a real instance from a one-sentence prompt; local floor published; 5 partners active; license shipped; pricing decided.
**Verify:** partner sessions in the wild + the n8n eval category green.

---

# PART V — RISKS (refreshed)

| Risk | Change vs v1 | Mitigation |
| --- | --- | --- |
| Frontier vendors ship your differentiator | Unchanged (High/High) | Audit/compliance + n8n + local-only are the three they won't chase; R3/R7 front-load them |
| Edit corruption | **Reduced** — hash-check, atomic writes, freshness, 709 tests | Keep drift tasks (R1) as the canary; never regress the evidence gate |
| Sandbox escape | **Partially reduced** (macOS proven; Linux unproven) | R3.2 escape suite before any "sandboxed" marketing claim |
| Eval overfitting to a 19-task suite | **New** | R1 scale + SWE-bench external anchor + partner-derived tasks |
| Planner-Executor sunk-cost | **New** | R4.2 kill criterion — data decides, doc records |
| Solo burnout | Unchanged (High/High) | Lanes are independently shippable; each phase exits with something usable; R6 before R7 so distribution isn't blocked on sales |
| Local-model floor embarrassment | New | Publish it anyway with framing: "measured, private, improving" — no competitor publishes a local floor at all |

---

# PART VI — FIRST THREE MOVES (concrete, today-sized)

1. **R1.1 — expand tool-discipline evals** (`tests/eval/tasks-tool-discipline.ts` has ~1 task; the category exists, the harness works — pure task-writing, immediately raises signal).
2. **R3.1 — write the sandbox truth matrix** into `docs/security/sandbox-matrix.md` and decide `config.sandbox.enabled`'s fate (one honest page; unblocks the threat model and the marketing claim).
3. **R2.1 — background indexing trigger** (alan-index + symbol_search already work; wiring "index on session start + freshness note event" is small and makes the existing index actually load-bearing).

These three are independent (disjoint files), each provable in a day-scale sitting, and each moves a different lane's exit criteria.

---

*End of Blueprint v2.0. The v1 document remains the reference for original intent; this document is the operating plan. Update Part I's scorecard and Part IV's phase exits as reality moves — a blueprint that drifts from the tree is worse than none.*
