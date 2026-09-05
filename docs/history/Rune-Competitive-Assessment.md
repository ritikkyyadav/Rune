# Rune vs. the Field: An Honest Competitive Assessment

**Date:** July 13, 2026 · **Scope:** Rune v0.1 (this repo, ~46k LOC TS+Rust, 65 commits, single author) compared against Claude Code, OpenAI Codex CLI, Cursor, OpenCode, and pi.
**Method:** full read of the engine source (agent loop, context engine, permissions, sandbox crates, tools, subagents, memory, evals) plus verification of competitors' July-2026 state via current public sources.

---

## 1. The verdict up front

Rune's *architecture* is top-decile. Its *product position* is bottom-decile. These are two different axes and conflating them is the most common mistake solo builders make.

On design, this codebase independently encodes most of the hard lessons the leading harnesses learned publicly through 2025–2026: pair-safe compaction driven by real provider token counts, byte-stable system prompts for prompt-cache discipline, kernel-level sandboxing (Seatbelt on macOS, bubblewrap on Linux — the same approach Codex CLI is famous for), post-edit syntax diagnostics fed back in the same turn (a lightweight form of OpenCode's LSP loop), skills with progressive disclosure, MCP, hooks, project memory files, checkpoints/rewind, and git auto-commit undo. A handful of things here are genuinely *ahead* of the mainstream: the execution-evidence gate (the loop mechanically refuses a "done" claim when files were written but nothing was ever executed), write-capable parallel workers with mechanically enforced disjoint file ownership, the struggle detector + black-box incident recorder, and Ed25519-signed session exports.

On product reality, Rune is a two-month-old v0.1 with one developer, a proprietary license, no distribution, no users, no ecosystem, and an eval suite of roughly a handful of task families. Claude Code and Codex ship 10–15 commits a day from funded teams, are co-developed with the models they run, and are validated across millions of real sessions. That — not any single feature — is the actual moat.

So the true position: **Rune is architecturally comparable to OpenCode circa early 2026 and ahead of pi in built-in scope (pi is minimal by philosophy, so that comparison flatters no one), but it sits well behind Claude Code, Codex, and Cursor on the dimensions that decide outcomes today: model–harness fit, evidence at scale, and distribution.**

---

## 2. Feature-level comparison (July 2026)

| Dimension | Rune v0.1 | Claude Code | Codex CLI | Cursor | OpenCode | pi |
|---|---|---|---|---|---|---|
| Core loop hardening (loop detection, breakers, truncation safety, empty-completion recovery) | Strong — unusually thorough for its age | Strong | Strong | Strong | Strong | Minimal by design |
| Context management | Pair-safe compaction, real-usage-driven, cache-stable prompts | Compaction + context editing, mature | Auto-compaction (fixed summary-of-summary bug in v0.5x) | Model-side, 200k+ windows | Auto-compact | Manual/simple |
| OS-level sandboxing | Seatbelt + bwrap, network escalation prompts | Sandboxing + permission modes | Kernel-level, whole process tree, default-on; Windows support | Cloud VM isolation for background agents | Application-layer | None built in |
| Editing reliability | Hash-guarded, atomic, 3-tier matching (TS + Rust parity) | Mature string-replace + hooks | apply_patch format **co-trained into the model** | Custom diff model, co-trained | LSP-verified edits | Basic |
| Post-edit feedback | Syntax-only (tsc syntactic pass, ast.parse, bash -n, JSON) | LSP via code-intelligence plugins | Diagnostics RPCs | Full IDE diagnostics | **Full LSP loop (types, references) — its signature edge** | None |
| Retrieval | Tree-sitter repo map (request-aware) + grep/glob/symbol_search | Agentic search + LSP plugins | Agentic search | **Semantic embedding index over whole repo** | Agentic + LSP symbols | Agentic only |
| Subagents | Read-only `task` + **ownership-enforced parallel write workers** (ahead of mainstream) | Subagents w/ isolated context, fleet Agent View | Multi-runtime agent patterns | Up to 8 parallel cloud background agents | Scout + background subagents | Extensions |
| Sessions | SQLite, checkpoints, /rewind, signed export | Checkpoints, resume, teleport | Resume, cloud handoff | Cloud-native | **Client/server — survives disconnects** | Simple |
| Multi-provider | 8+ providers incl. local Ollama, tier routing, fallback | Anthropic only | OpenAI-centric | Own + frontier models | 75+ providers | Many |
| Ecosystem | Skills (181 bundled), hooks, MCP — no plugin packaging, proprietary | **Plugins marketplace (skills+hooks+agents+MCP+LSP)** | Plugin marketplace emerging | Extension of VS Code ecosystem | Large OSS community (~160k stars) | ~62k stars, extension system |
| Evals/hardening evidence | ~8 scripted task families, mock provider, 106 unit tests | Massive internal + public benchmarks | Massive | RL-trained on own harness | Community-scale usage | Community usage |
| Team/enterprise controls | None (but has audit primitives: signed exports, black box) | Managed settings, policy | Enterprise offering | Enterprise | Some | None |

---

## 3. Where the system truly lies, and why

**Design maturity: ~8/10.** The agent loop is more defensive than anything except the big three. Details like refusing to execute tool calls from a `max_tokens`-truncated response (because salvaged JSON args could be destructive), waiting out all-provider rate limits instead of dying at the finish line, and force-compacting on provider-rejected oversized prompts are the kind of scar tissue that usually only accumulates through production traffic. Someone here has studied the field carefully and, in a few places, gone past it.

**Model–harness fit: ~4/10.** This is the deepest technical gap and the one architecture can't fully close. Codex models are trained on the `apply_patch` format; Cursor's Composer is RL-trained against Cursor's own tools; Claude is co-developed with Claude Code's tool suite. Rune presents one generic tool schema to eight providers. A generic harness now measurably underperforms a co-trained one on the same model — the harness stopped being a neutral layer around 2025.

**Evidence at scale: ~2/10.** The eval suite (`tests/eval/`) is real but thin — a handful of task families against a mock provider plus small live tasks. Nothing anchors the harness against SWE-bench Verified or Terminal-Bench, so there is currently no way to know whether any given change to prompts, compaction, or tools makes the agent better or worse. Every serious competitor's core activity in 2026 is eval-driven harness iteration.

**Distribution & ecosystem: ~1/10.** Proprietary license, no marketplace, no community, bus factor of one, competing against free tools with 60k–160k GitHub stars and funded teams. Feature parity does not move this number.

**Net position, stated plainly:** as a general-purpose coding agent competing head-on with Claude Code/Codex/Cursor, Rune is not competitive now and will not become so by adding features — the leaders' advantage compounds through model co-training and usage-scale evals that a solo proprietary project cannot replicate. As a *specialist* harness, it holds cards the leaders don't prioritize: fully local operation (Ollama path), kernel sandboxing plus signed, tamper-evident transcripts plus a black-box flight recorder — an audit/compliance story none of the big three lead with.

---

## 4. The gaps, prioritized, with the best available fixes

**Gap 1 — No eval flywheel (highest leverage).** You cannot improve what you cannot measure, and right now harness changes are flying blind.
*Fix:* Anchor externally on SWE-bench Verified (or Lite) and Terminal-Bench for a monthly score. More importantly, close the loop you already half-built: the black-box recorder and struggle detector are capturing real failures with fingerprints — pipe every recurring incident class into a regression eval task automatically. A nightly 100+ task suite grown from your own failures beats a static benchmark and is unique to your architecture. This is weeks of work and changes everything downstream.

**Gap 2 — Generic tool surface vs. co-trained models.**
*Fix:* You can't train models, so meet each model where it was trained. Add per-model-family adapters in the gateway: `apply_patch`-format editing for OpenAI/Codex models (they're RL-trained on it, your string-replace editor fights that training), keep `edit_file` for Claude models, and adopt provider-native features where they exist (Anthropic context-editing/memory APIs, fine-grained tool streaming). The tier-routing plumbing you already have is the right place to hang this.

**Gap 3 — Retrieval stops at a repo map.** Cursor's semantic index is its differentiator on large codebases; your tree-sitter map is good but lexical.
*Fix:* Cheapest 80%: add SQLite FTS5/BM25 over symbol-chunked content inside `rune-index` (the crate is already the right home, with tree-sitter chunking done). Then optional local embeddings (small local model via Ollama keeps the local-first story intact) for hybrid ranking. Skip a cloud vector DB entirely — it contradicts your positioning.

**Gap 4 — Syntax-only diagnostics vs. OpenCode's full LSP loop.** Your same-turn syntax feedback is well-designed but catches braces, not type errors — and typed-language self-correction is OpenCode's proven edge.
*Fix:* One language first: a persistent `tsserver` process (you already embed the TS compiler API) upgraded from syntactic to semantic project-aware diagnostics, appended to edit results exactly as now. Then rust-analyzer over LSP. Keep it opt-in per project like Claude Code's code-intelligence plugins — always-on LSP is the top OpenCode complaint (latency).

**Gap 5 — Process-bound sessions.** OpenCode's client/server survives SSH drops; Cursor/Codex offer cloud background agents. Your engine/client split (`engine-host.ts`) is designed for this but unfinished.
*Fix:* Finish the headless engine server with reattach over the session DB you already have. For background work, skip the cloud: local git-worktree isolation per background run (Cursor's worktree trick, no VM) is achievable and pairs naturally with your worker-ownership model.

**Gap 6 — Compaction can eat its own summaries.** `compactWorkingSet` summarizes everything before the cut — including the previous `[Earlier conversation summary]` message. Repeated compactions on long sessions will degrade recursively. Codex shipped and then fixed this exact bug (v0.54→0.56).
*Fix:* Maintain one structured state block (goals / decisions / files touched / current state / next step) that each compaction *replaces* via merge, never re-summarizes as prose input. Your "comprehensive resume-grade" prompt mitigates but doesn't remove the accumulation.

**Gap 7 — Windows.** Sandbox falls to `noop` on Windows; Codex now ships Windows sandboxing.
*Fix:* Near term, be honest in-product (confirm-mode forced on Windows, banner stating no OS sandbox). Medium term, WSL2 delegation — a real Windows AppContainer implementation is not worth solo effort yet.

**Gap 8 — No packaging/ecosystem layer, proprietary license.** Skills+hooks+MCP exist but can't be bundled or shared; the license forecloses community leverage while free competitors have six-figure stars.
*Fix:* Technical part is small: a plugin manifest bundling skills/hooks/MCP/commands mirrors Claude Code's model. The real decision is business: either open-core (open the harness, monetize the compliance layer — telemetry collector, signed audit, policy controls) or accept that closed + undistributed means the product functions as a portfolio/acquisition asset, not a competitor. There is no viable middle path in 2026's market.

**Gap 9 — Compliance positioning is asserted, not productized.** Signed exports, audit trails, redaction, and local-first are the differentiators, but there's no policy file, no managed settings, no admin controls — the features an actual regulated buyer needs.
*Fix:* A signed, system-path policy file (tool allow/deny lists, forced permission modes, network bans, mandated audit export) is days of work on your existing PermissionBroker and would make the compliance story real rather than implicit.

---

## 5. Realistic timelines

**Now:** Competitive as a daily driver for its author and as a compliance-niche demo; not competitive for general adoption. The honest pitch today is "the auditable, local-first agent," not "a Claude Code alternative."

**2 years:** With the eval flywheel (Gap 1), model adapters (Gap 2), and a decided license/business model (Gap 8), a defensible niche in regulated/air-gapped environments is plausible — that segment is underserved and the big three are structurally uninterested in fully-local. Head-on general-purpose competition remains implausible: the co-training + distribution compounding does not slow down.

**10+ years:** Harnesses are likely commoditized into model-native agent runtimes; independent harness value concentrates entirely in trust layers (audit, policy, isolation, provenance) — which is, notably, the part of Rune that is currently most original. The long-term bet embedded in this codebase is directionally correct even though the near-term competitive framing ("compare with Claude Code") is the wrong fight to pick.

---

## 6. Bottom line

The engineering is not the problem — parts of it (evidence gate, ownership-enforced workers, black box) are better than what ships in the leaders. The problem is that in 2026 harness quality alone no longer decides outcomes; measured performance, model fit, and distribution do, and Rune currently has none of the three. Fix measurement first (Gap 1 — it's cheap and compounds), fit second, and make the license/positioning decision deliberately instead of by default. Competing with Claude Code is unwinnable; being the agent that regulated teams are *allowed* to run is wide open.

---

## 7. Re-audit addendum — 2026-07-13, latest working tree

The original audit read a slightly older sync of the repo. Re-audited against the current tree: `main` @ `25beb36` (PR #1 `feat/reliability-and-tooling` merged, 70 commits) **plus ~800 lines of uncommitted work** across 35 files and several new untracked modules. Findings:

**New since the audited baseline (verified in source):**

1. **Real LSP integration** (`packages/tool-registry/src/tools/lsp/` — jsonrpc, 442-line manager, `lsp` tool). Four servers (typescript-language-server, pyright, rust-analyzer, gopls), lazy spawn per workspace, mtime-keyed document sync, a readiness gate on first `publishDiagnostics` (avoids the confidently-wrong-answers-before-project-load trap), zombie-proof teardown, and self-heal install hints. Actions: definition / references / hover / diagnostics, read-only + auto-permission so calls parallelize. **This closes most of Gap 4's infrastructure.** What remains is the *loop*: diagnostics are on-demand (the model must ask) — the post-edit path (`diagnostics.ts`) is still syntax-only, so OpenCode-style automatic self-correction after edits is not yet wired.
2. **Native request-aware repo map** in Rust (`crates/rune-index/src/repo_map.rs`, ~850 lines, bridged via `rune-tools` and budgeted into context as `retrievedChunks`). Structural retrieval is now materially better than the static tracked-file tree the audit described. Full-text/semantic search (FTS5/embeddings) still absent.
3. **Sandbox capability honesty** (`sandbox-capability.ts` + permission-broker gate): intent ("sandbox on") is now distinguished from machine ability (seatbelt/bwrap actually present); bash auto-approval requires **both**, unknown capability fails safe to prompting, and `[sandbox] requireOs` can refuse degraded runs outright. **This implements the original P10 prescription almost exactly.**
4. **Reliability policy module** (`reliability-policy.ts`): every loop recovery bound centralized, per-model-family adjustments (budget/open-weight models get extra retries — their failures skew transient), user-tunable via `[reliability]` in config. A first, behavioral slice of the model-fit gap.
5. **Token-counter calibration**: heuristic counts now calibrate against real provider usage per model, and the context budget tracks the active model's true window (an 8k local model no longer risks being sent a 100k prompt).
6. **Built-in Playwright browser MCP** (`mcp/browser-server.ts` + doctrine): headless-browser verification of web work is productized, not just prompted.

**What did NOT change — the audit's core claims re-verified against the latest tree:**

- The compaction **summary-of-summary defect stands** (`compactWorkingSet` still re-summarizes the prior `[Earlier conversation summary]` message; no merge/template logic).
- The **circuit breaker still keys on exact `toolName:argsJson`** — trivially variant calls bypass it.
- The **eval suite is untouched since June** (~8 task families) while the harness gained six substantial subsystems. The measurement gap is now *worse* in relative terms: more unmeasured surface.
- `apply_patch`/model-format adaptation, session durability, plugin packaging, and the admin policy layer remain absent.

**Revised verdict.** Design maturity moves up (call it 8.5/10): the LSP tool now rivals Claude Code's plugin-gated code intelligence across four languages, and the sandbox-capability work is more honest than most of the field. The strategic position does not move: the three binding constraints (evals, model fit, distribution) are exactly where they were, and the pattern of this delta — six new harness subsystems, zero new eval tasks — is the diagnosis demonstrating itself. The prescription's Phase 0 ordering is unchanged and more urgent, with P4 and P10 re-scoped downward in `Rune-Prescription-Plan.md`.

---

### Sources (competitor state, July 2026)

- [Claude Code — Extend Claude Code (official docs)](https://code.claude.com/docs/en/features-overview)
- [Claude Code Features – 2026 Q2](https://wal.sh/research/2026-q2-claude-code-features/)
- [Claude Code Plugins Complete Guide](https://hidekazu-konishi.com/entry/claude_code_plugins_complete_guide.html)
- [The codex-rs Architecture: How OpenAI Rewrote Codex CLI in Rust](https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/)
- [OpenAI Codex CLI Architecture and Multi-Runtime Agent Patterns](https://zylos.ai/research/2026-03-26-openai-codex-cli-architecture-multi-runtime-patterns/)
- [How Codex is built — Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-codex-is-built)
- [OpenCode vs Claude Code (July 2026)](https://www.morphllm.com/comparisons/opencode-vs-claude-code)
- [OpenCode Developer Guide 2026](https://www.developersdigest.tech/blog/opencode-developer-guide-2026)
- [Composer: Building a fast frontier model with RL — Cursor](https://cursor.com/blog/composer)
- [Introducing Cursor 2.0 and Composer](https://cursor.com/blog/2-0)
- [Semantic & Agentic Search — Cursor Docs](https://cursor.com/docs/agent/tools/search)
- [Pi Coding Agent — overview](https://grokipedia.com/page/Pi_Coding_Agent)
- [pi-mono — minimalist coding agent](https://dev.to/wonderlab/one-open-source-project-a-day-no-53-pi-mono-minimalist-high-performance-ai-coding-agent-4d73)
