# Rune on a Frontier Model: Model-Normalized Competitive Audit

**Date:** 2026-07-14 · **Question asked:** *If Rune runs the same frontier models the leaders run (Claude Opus 4.8, Fable 5, GPT-5.5, GPT-5.6 Sol), how competitive is the harness against Claude Code and Codex — and against the open-source field?*
**Method:** independent read of the current engine source (`main` @ v0.2.0, ~48k LOC) — agent loop, per-model tool advertisement, compaction, sandbox, eval suite — plus verification of the July-2026 model and competitor landscape from public sources. This is the model-normalized cut; the general product assessment is in `Rune-Competitive-Assessment.md`.

---

## 0. The one-number answer

Hold the model constant and Rune's harness lands at **rough parity with the strongest open-source harnesses (OpenCode tier)** and **~5–15 points of real-repo task completion behind the co-trained leaders (Claude Code on Claude models, Codex on GPT models).** That gap is almost entirely **co-training and measurement, not engineering.** On raw loop mechanics Rune is already in the top third of everything that isn't Claude Code / Codex / Cursor, and on a few axes (execution-evidence gating, ownership-enforced parallel writers, capability-honest sandbox, signed audit) it is at or ahead of the mainstream.

The framing to internalize: **the harness is no longer a neutral layer.** Independent tests in 2026 measure a ~15–16 point swing in task success from the harness *alone* on an identical model (one widely-cited run: Claude Opus at 77% in one harness vs 93% in another on the same tasks). So "give it a frontier model" is a fair question with a real answer — but part of that 15-point band is reserved for the harness the model was *trained against*, and a third party cannot mint that part.

---

## 1. Why the model no longer settles it

Frontier coding models are near the ceiling of the standard benchmark and are post-trained on a specific harness's exact wire format:

| Model (Jul 2026) | SWE-bench Verified | Co-trained harness | Rune edit-format fit |
|---|---|---|---|
| Claude Mythos 5 | ~95.5% | Claude Code | good (string-replace `edit_file` — what Claude is trained on) |
| Claude Fable 5 | ~95% | Claude Code | good |
| Claude Opus 4.8 | ~88.6% | Claude Code | good |
| GPT-5.5 | ~88.7% | Codex | **now correct** (`apply_patch` envelope, gated to the GPT/o-series/Codex lineage) |
| GPT-5.6 Sol | coding SOTA (AA Coding Index ~80) | Codex | now correct |

Two consequences for the normalized question:

1. **The model does more of the work than it did in 2024.** At 88–95% on SWE-bench Verified, a capable model plus a *competent* harness closes most everyday tasks. This compresses the field: the floor for "usable agent" is low, so Rune clears it trivially on any of these models. Rune's own internal suite already shows this — 94.7% clean on a mid-tier open-weight coding model (qwen3-coder-next); comprehension, bug-fix, and multi-file-refactor families are effectively solved end-to-end. On a frontier model those numbers go up, not down.

2. **The remaining spread is harness-decided, and the top of it is co-training.** Where models are this good, the differences that remain — did it edit the right lines without corrupting the file, did it verify, did it recover from a bad tool call, did it retrieve the right context in a 2k-file repo — are exactly the harness's job. Rune is strong here. But Claude Code and Codex get a structural bonus: the model was RL-trained to emit *their* tool calls in *their* format. Rune can match the format (and now does, per family) but not the training signal.

---

## 2. Model-normalized comparison

Ranked by expected real-repo task completion on a *fixed* frontier model — i.e. the harness contribution only. Distribution/stars deliberately excluded here (they're in the product assessment); this table is engineering-only.

| Dimension (model held constant) | Rune v0.2 | Claude Code | Codex | Cursor | OpenCode | Aider | Cline | pi |
|---|---|---|---|---|---|---|---|---|
| **Edit-format fit to the model** | Per-family: `edit_file` for Claude, `apply_patch` for GPT/Codex | Co-trained (Claude) | Co-trained (GPT) | Co-trained (Composer) + strong on frontier | Per-family incl. apply_patch | String-diff, generic | Generic | Generic |
| **Verification loop** | **Execution-evidence gate + verifier re-prompt (ahead of most)** | LSP + hooks | Diagnostics RPC | Full IDE diagnostics | Full LSP loop (signature edge) | Test-run + auto-commit | IDE diagnostics | None |
| **Retrieval** | Rust repo-map + FTS5/BM25 symbol search | Agentic + LSP | Agentic | **Semantic embedding index (edge on huge repos)** | Agentic + LSP | Repo map | Agentic | Agentic |
| **Context / compaction** | Pair-safe, real-usage-driven, cache-stable, STATE-aware | Mature (context editing/memory API) | Auto-compact | Model-side large window | Auto-compact | Manual | Simple | Manual |
| **Loop hardening** | **Very strong** (breaker, loop-nudge, truncation/empty-completion/overflow/rate-limit recovery) | Strong | Strong | Strong | Strong | Modest | Modest | Minimal |
| **Parallelism** | Read-concurrency + **ownership-enforced parallel writers** | Subagents + fleet view | Multi-runtime | ≤8 cloud bg agents | Scout + bg subagents | None | None | None |
| **Sandbox** | Seatbelt/bwrap, **capability-honest gating** | Sandbox + modes | Kernel, default-on, Windows | Cloud VM | App-layer | None | None | None |
| **Measurement flywheel** | Internal suite + **incident-fed regressions**; no external anchor | Massive internal + public | Massive | RL on own harness | Community-scale | Community | Community | Community |
| **Provenance / audit** | **Ed25519 signed policy + signed export + black box (ahead)** | Managed policy | Enterprise | Enterprise | Some | None | Approval UX | None |

Read horizontally: Rune is **at or above the OSS field on almost every engineering axis except retrieval depth and measurement**, and trades blows with Claude Code / Codex on mechanics while losing the co-training and eval-scale rows that decide the last few points.

---

## 3. Where Rune actually wins on a fixed model

These are verified in the current source and are genuine, not marketing:

- **Execution-evidence gate** (`agent-loop.ts`): the loop *mechanically* refuses the first "done" when files were written but nothing was ever executed, and re-prompts for real output. Deterministic and model-independent — it disciplines a weak model and a frontier model identically. Most harnesses trust the model's claim. This is a real edge, especially on models that over-report success.
- **Ownership-enforced parallel write workers**: parallel writers with mechanically disjoint file ownership, so concurrency can't corrupt state. Mainstream parallelism is read-only or cloud-VM-isolated; this is finer-grained.
- **Capability-honest sandbox**: auto-approval requires the OS sandbox to *actually be present* (seatbelt/bwrap probed, not assumed); unknown capability fails safe to prompting. More honest than most of the field.
- **Model-fit adaptation already shipped**: `apply_patch` for the Codex lineage (the exact move OpenCode made), per-family reliability bounds, per-model token-window calibration. This is the single most important item for your question and it is done, not planned.
- **Loop scar tissue**: no tool execution from a `max_tokens`-truncated response, bounded waits through all-provider rate limits, forced compaction on context overflow, empty-completion retry. This is production-grade defensiveness usually only earned through scale traffic.
- **Provenance**: signed org policy enforced before permission shortcuts, Ed25519 signed session export, black-box incident recorder. No mainstream leader leads with this.

On a frontier model, these translate to **fewer silent failures and less corruption**, which is exactly the failure surface that remains once the model is smart enough.

---

## 4. The two caps that a frontier model does not lift

**Cap 1 — Co-training (structural, uncloseable by you).** Claude Code and Codex ship the model post-trained on their harness. Third-party harnesses running the same model measurably underperform the native one — the ~15-point harness band exists precisely because of this, and the top slice belongs to whoever trained the model. Rune matching the *format* per family (which it now does) recovers most of the avoidable loss; it cannot recover the trained-in part. **Net on a fixed model: expect Rune to trail the model's native harness by a few points regardless of engineering quality.**

**Cap 2 — Measurement (closeable, half-done, highest leverage).** You now have an internal suite and, importantly, an incident-fed regression path (`tests/eval/from-incidents/`) — the flywheel that was missing in the June baseline. But there is still **no external anchor (SWE-bench Verified / Terminal-Bench) and no frontier-model ceiling run** (blocked on API credits). Consequence: you cannot see the very 5–15 points this whole question is about. Every leader's core 2026 activity is eval-driven harness tuning against exactly these benchmarks. Until Rune scores itself on the same target, "how competitive on a frontier model" is unmeasured on your side — the honest answer is *inferred from architecture, not observed.* Terminal-Bench specifically is the harness-sensitive benchmark and the one to run; it isolates the agent, not the model.

Secondary, non-blocking: retrieval is lexical (FTS5/BM25 + repo map), not semantic — Cursor's embedding index is its edge on very large repos; and there is no usage-scale evidence (single author vs 40k–100k-star funded projects). Neither is fixed by swapping in a better model.

---

## 5. Realistic timelines

**Now.** On any of the four models, Rune is a competent daily driver whose harness is engineering-competitive with OpenCode and ahead of Aider/Cline/pi on agentic loop depth. Against Claude Code/Codex it is close on mechanics and behind on co-training + measurement — a few points of task completion you currently can't quantify. Honest positioning today: "an auditable, local-first harness that runs any frontier model competently," **not** "beats Claude Code."

**2 years.** The closeable gap is measurement. Anchor on Terminal-Bench + SWE-bench Verified, wire the incident flywheel to auto-generate regression tasks, and get one frontier ceiling run — then harness changes stop flying blind and the OSS-parity claim becomes provable. Co-training stays out of reach: the leaders' advantage compounds, and the gap on *their* model with *their* harness will not shrink. Rune's defensible ground is the trust layer (local, sandboxed, signed, policy-gated) where the big three are structurally uninterested — that niche is real and widening. Head-on "general-purpose Claude Code replacement" remains not winnable.

**10+ years.** Harnesses commoditize into model-native agent runtimes; the model vendors absorb the generic loop. Independent harness value concentrates entirely in the trust/provenance/isolation layer — which is the most original part of this codebase and the correct long bet. The near-term framing ("compete with Claude Code on general coding") is the wrong fight; the long-term framing embedded in the audit primitives is right.

---

## 6. Bottom line

Give Rune a frontier model and the harness does not embarrass itself — it is at parity with the best open-source agents and within a few points of the co-trained leaders on mechanics, with a genuine edge in verification discipline and auditability. The two things a better model will **not** fix are the ones that decide the top of the range: you cannot out-engineer the model-vendor's co-training, and you cannot currently *measure* where you stand because there's no external benchmark anchor or frontier ceiling run. Fix measurement (it's weeks, and it's the only way to turn this document's inferences into numbers); treat co-training as a permanent few-point tax and stop optimizing for the head-on fight; and press the audit/local/provenance advantage, which is the one part of the stack a frontier model makes *more* valuable, not less.

---

### Sources (model + competitor state, July 2026)

- [SWE-bench Verified leaderboard — BenchLM (Jul 2026)](https://benchlm.ai/benchmarks/sweVerified)
- [AI model benchmarks Jul 2026 — GPT-5.5 / Opus / Gemini 3 / Grok 4](https://lmcouncil.ai/benchmarks)
- [SWE-bench Pro leaderboard 2026 (GPT-5.6 added)](https://codingfleet.com/blog/swe-bench-pro-leaderboard-2026/)
- [Previewing GPT-5.6 Sol — OpenAI](https://openai.com/index/previewing-gpt-5-6-sol/)
- [OpenAI launches GPT-5.6 family — TechCrunch](https://techcrunch.com/2026/07/09/openai-launches-its-new-family-of-models-with-gpt-5-6/)
- [The harness problem: same model, different harness — Can.ac](https://blog.can.ac/2026/02/12/the-harness-problem/)
- [Model-Harness-Fit — Nicolas Bustamante](https://nicolasbustamante.com/blog/model-harness-fit)
- [Skill Issue: Harness Engineering for Coding Agents — HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [Codex vs Claude Code head-to-head (2026) — Nimbalyst](https://nimbalyst.com/blog/codex-vs-claude-code-workflow-harness/)
- [Open-source AI coding agents 2026 — comparison](https://wetheflywheel.com/en/guides/open-source-ai-coding-agents-2026/)
- [Best open-source AI coding assistants 2026](https://www.opensourcealternatives.to/blog/best-open-source-ai-coding-assistants)
- [Best AI coding agent (2026), ranked by Terminal-Bench — Morph](https://www.morphllm.com/ai-coding-agent)
