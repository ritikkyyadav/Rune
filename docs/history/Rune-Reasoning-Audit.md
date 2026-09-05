# Rune Reasoning Audit — why it rushes, goes shallow, and dies mid-task

**Date:** 2026-07-16 · **Trigger:** side-by-side comparison with Claude Code (Opus 4.8, xhigh effort) on a macOS battery-drain diagnosis. Claude Code ran parallel diagnostics, formed a hypothesis, confirmed it before summarizing, then traced a wedged `syspolicyd` to its ExecPolicy SQLite WAL. Rune, on the user's recent tasks, rushed, fabricated, and stopped.
**Method:** forensic replay of Rune's own `~/.alan/alan.db` (session events) and `~/.alan/blackbox.db` (433 incidents), plus a source audit of the system prompt, gateway, security guard, and agent loop.

**Verification:** full suite **1062 pass / 0 fail** (12 pre-existing skips), workspace typecheck 11/11. The 37 initially-failing tests were sandbox loopback-bind blocks in the audit environment, not code failures.

---

## Headline finding

The battery task never reached Rune's engine — there are **zero session events after 2026-07-16T12:06Z** and no battery/pmset/syspolicyd content in any session. What the user experienced as "Rune failed and stopped" is the provider cascade death (R2 below) that killed the sessions they DID run. The shallowness they see on tasks that do run is a compound of R1 (research physically blocked), R3 (no investigation doctrine), and R4 (reasoning effort pinned at medium).

## Failure register

### R1 — Egress guard blocked the entire internet by default — **FIXED**
- **Evidence (blackbox):** `Egress blocked: https://savoir.services` (the site the user asked Rune to replicate), 12× `Egress blocked: https://upload.wikimedia.org/...Chess_*.svg` (the chess pieces it was asked to match), and `Egress blocked: http://127.0.0.1:3000` (its own dev server, which doctrine tells it to curl for verification).
- **Root cause:** `createEgressGuard()` in `packages/orchestrator/src/security.ts` fell back to a 6-host allowlist (npm/GitHub/PyPI/crates/jsDelivr) when no allowlist was configured — and nothing ever configured one. Its sibling `isAllowedEgress` documents the intended semantics: empty = unrestricted. So every default session ran with `web_fetch` dead for ~the whole web and even loopback. The model tries to investigate, gets blocked, and in-context learns to fabricate from memory — the exact shallow behavior under complaint.
- **Fix:** no allowlist = no restriction (matching `isAllowedEgress`); loopback always allowed even under an explicit allowlist; injection scanning untouched. Egress limits remain available as opt-in hardening (org policy / engine config).

### R2 — Fallback chain rot + cascade death spiral — **FIXED**
- **Evidence (blackbox):** 5× identical cascades in 3 minutes on 2026-07-16 (`codex 429 "usage limit has been reached" → openrouter qwen/qwen3-coder:free → error → google …`) until the user aborted; on 2026-07-15, `run failed after 13 consecutive errors: 410 "qwen3-coder:480b was retired at 2026-07-15"` with `struggle.todo_unfinished: 5/6 todos unfinished`.
- **Root causes:**
  1. `PROVIDER_DEFAULT_MODELS` in `gateway.ts` hardcoded fallback models that had been retired upstream (`qwen/qwen3-coder:free`, `qwen3-coder:480b` — both died 2026-07-15).
  2. A 410/404 "model gone" error was classified as retryable, so the agent loop re-ran the identical doomed chain until the consecutive-error breaker killed the run mid-task.
  3. A subscription usage-cap 429 ("usage limit has been reached") was treated like a per-minute throttle: re-tried at the top of every turn, spamming fallback notices.
- **Fixes:** (a) model-gone errors (404/410/"retired"/"not found") prune the provider for the session and fall through to the next one — sole-provider case yields ONE terminal, non-retryable error telling the user to run `/model`; (b) rate/usage-cap 429s put the provider in a cooldown (Retry-After-aware; 15 min for plan caps, 60 s for throttles, 60 min max) so subsequent turns skip it instantly, with an honest "Skipping X — retrying in ~Nm" notice instead of a silent swap; when everything is unusable the primary is still attempted so recovery is automatic once the limit resets; (c) usage-cap 429s no longer get the sole-provider short retry; (d) defaults refreshed (`openrouter → deepseek/deepseek-v4-flash:free`, `ollama-turbo → qwen3-coder-next`, `codex → gpt-5.6-terra`) with a rot warning — pruning is the safety net when these rot again. Introspection via `getProviderHealth()`.

### R3 — The doctrine had no investigation layer — **FIXED (doctrine v3)**
- **Evidence (session replay):**
  - Asked to build "like this provided image", Rune ran `sips` for dimensions and a palette extraction that returned **empty**, marked the todo "Inspect the supplied reference image" **completed**, and restyled from imagination (it has no vision — R5 — and papered over it).
  - Asked to "finish what you actually started" after a rate-limit stall on market research, it shipped a dashboard **about the missing data** ("evidence-status report", "data-integrity matrix") instead of redoing the research.
  - The research itself concluded "no verified July 16 closes" at 11:46 UTC — **US markets had not yet opened**; a one-step timing inference turns "data unavailable" into "markets haven't closed yet — want yesterday's close or a live intraday view?".
- **Root cause:** `AGENT_DOCTRINE` framed everything as codebase work ("read the files, search the codebase"). Nothing covered: investigating unknowns before acting, diagnosis as evidence→hypothesis→confirmation, explaining missing data, todo completion requiring evidence, capability honesty, blocked-call escalation, or resuming (vs downgrading) after interruptions. Meanwhile "# Tone and style" pushed unqualified brevity — a model under "be concise" pressure trims the investigation, not just the prose.
- **Fix — seven doctrine additions in `prompts.ts`, each anchoring an observed incident, each pinned by a regression test:**
  1. New `# Investigate before you act` section (placed right after `# Agency`): unknown territory → find out FIRST; memory is "a hypothesis to check, not a source to cite".
  2. Diagnosis doctrine: "WHY" questions deserve a VERIFIED explanation — parallel evidence, one hypothesis that explains all of it, one targeted probe to CONFIRM before writing the diagnosis (the Claude Code battery pattern).
  3. "Missing data is a finding to explain, not a wall" — check timing/timezone/path/permissions before reporting unavailable (the market-close incident, verbatim).
  4. Tone counterweight: "Brevity applies to your PROSE, never to your work."
  5. Todo evidence gate: "Completed" requires evidence from THIS session; empty/failed output ⇒ not done (the sips-palette incident).
  6. Honesty: never fabricate an observation you could not make (image/URL/system you can't reach) — and blocked harness calls ("Egress blocked") escalate honestly instead of quietly shipping without the data.
  7. Steering: after ANY interruption, resume the ORIGINAL task from the last verified todo — "never quietly downgrade the deliverable" (the status-report cop-out).

### R4 — Reasoning effort pinned at medium — **FIXED**
- **Evidence:** Claude Code ran the same class of task at xhigh effort. Rune's OpenAI-compatible adapter hardcoded `reasoning_effort: "medium"`; nothing anywhere could raise it.
- **Fix:** `thinking.effort` added to `InferenceRequest`; the agent loop sends it on every request, **default "high"** (override with `thinkingEffort` in loop config); the OpenAI adapter honors it. Codex-transport note: gpt-5.6 sol/terra/luna encode effort in the model NAME and reject an effort param — for depth on the codex path, pick the deeper variant in `/model`.

### R5 — No vision — **OPEN (documented)**
The engine cannot see images (known: "vision NOT built"). The doctrine now forbids faking it (R3.6), so Rune will say "I can't view images" instead of pretending via `sips`. Building real multimodal input (Read-image → provider image blocks; codex/anthropic/google all support it) is the single biggest remaining capability gap for daily-driver parity.

### R6 — ask_user erred in an interactive session — **BY DESIGN, watch it**
`tool:ask_user → "No interactive user is available"` fired at 09:19 during a session where the user was present. That is the hands-free withholding from autonomy doctrine v2 (no QuestionHandler registered). If it fires outside Hands-Free mode, that's a wiring bug worth a look; nothing in this audit changed it.

## What "efficient AND deep" means after this audit

Claude Code's depth is not slowness — it is: (1) freedom to fetch/probe (Rune's was silently revoked by R1), (2) high reasoning effort (R4), (3) a doctrine that says investigation IS the task (R3), and (4) a harness that doesn't kill the run when a provider wobbles (R2). All four are now in place; efficiency stays (parallel tool batching, fast fallback, concise prose are all untouched).

## Deploy notes

- Changes live on branch `claude/agent-reasoning-audit-64405d` (worktree). Files: `packages/orchestrator/src/prompts.ts`, `packages/orchestrator/src/security.ts`, `packages/llm-gateway/src/gateway.ts`, `packages/llm-gateway/src/types.ts`, `packages/llm-gateway/src/providers/openai.ts`, `packages/orchestrator/src/agent-loop.ts` + tests.
- The main checkout sits on `feat/reliability-and-tooling` with UNCOMMITTED work (BYOP auth, config tool, codex/copilot transports). `prompts.ts`, `security.ts`, `gateway.ts` are untouched there (clean merge); small overlaps possible in `types.ts`/`openai.ts`/`agent-loop.ts` (distinct regions, trivial resolution).
- The live binary `~/.alan/bin/berne-compiled` is compiled FROM that checkout — merge this branch there, then **recompile in place** (never `cp` — AMFI kills copied bun binaries on Apple Silicon). Open berne tabs need a restart to pick it up.
