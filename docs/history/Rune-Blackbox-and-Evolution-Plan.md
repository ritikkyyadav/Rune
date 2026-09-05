# RUNE — FEATURE PLAN: BLACK BOX (F1) & EVOLUTION LOOP (F2)

**Scope:** Rune CLI first. Desktop/engine-host wiring is a follow-on note, not in scope here.
**Status:** F1 core (P1+P2) and F2 notebook v1 **BUILT 2026-07-04** — see *Implementation Status* at the end of this doc. Originally grounded in the tree at `ea68d01` (all cited seams verified to exist).
**Cost reframe (2026-07-04, per user):** the evolution loop must never meaningfully spend the user's tokens. v1 learning is 100% rule-based (zero model calls); the only recurring cost is the injection block (≤600 tokens ≈ 0.06% of a 1M-token session); any future model-assisted distillation is gated by a `CostGovernor` hard-capped at ≤2% of session spend (cheapest/local tier only). Real-time self-modification of Rune's own source is explicitly out of scope.
**Relation to Blueprint v2:** F1 supersedes and absorbs gap **G10 (telemetry stub)** and becomes the wild-usage complement to **G1 (eval compass)** — evals measure the lab, the black box measures the field. F2 extends **R2.4 (discoveries ledger)** and the existing system-memory "dreaming" machinery. These two features become the top lanes; v2's R-phases keep their exit criteria but re-sequence beneath them.
**F3 (graphical terminal reports):** parked, by request. One design constraint is honored now so F3 stays cheap later: everything F1/F2 stores is structured and queryable (SQLite), never prose-only.

---

## 0. THE CORE INSIGHT: ONE LOOP, NOT TWO FEATURES

F1 and F2 are halves of a single control loop:

```
        ┌──────────────────────────────────────────────────────┐
        │                                                      │
        ▼                                                      │
   RUN (agent works on real codebases)                         │
        │                                                      │
        ▼                                                      │
   F1 CAPTURE — every break, struggle, recovery, success       │
   (incidents + outcomes, structured, crash-safe)              │
        │                                                      │
        ├──► DEVELOPER LOOP: incidents → eval tasks → fixes    │
        │    (how the CODEBASE evolves between versions)       │
        │                                                      │
        ▼                                                      │
   F2 DISTILL — facts, lessons, skills, policies               │
   (how the AGENT evolves between sessions)                    │
        │                                                      │
        ▼                                                      │
   SELECT — outcomes + eval A/B promote or retire what was     │
   learned (no measurement → no mutation)                      │
        │                                                      │
        └──────────────────────────────────────────────────────┘
```

- **F1 without F2** is a filing cabinet — data nobody acts on.
- **F2 without F1** is a superstition machine — it would "learn" from noise with no way to know if a lesson helped.
- The **eval harness is the selection pressure**. "Self-evolving, not a cyborg" means exactly this: variation (candidate lessons/skills), selection (measured outcomes), heredity (promoted artifacts persist across sessions and versions). The agent never mutates its binary or source — it mutates **data artifacts** under provenance, gates, and rollback.

---

# FEATURE 1 — THE BLACK BOX (flight recorder + incident intelligence)

## 1.1 Principles (non-negotiable)

1. **The recorder never harms the flight.** Every capture path is wrapped; a recorder failure degrades to a last-resort plain-text log, never an exception into the agent loop. Overhead budget: <1ms per event on the hot path.
2. **Small errors count.** A retry that succeeded, a malformed tool-JSON that was salvaged, a provider fallback — all recorded at `debug`/`warn` severity. Fingerprint-deduped so frequency becomes signal, not spam.
3. **Every incident answers five questions:** *where* (component + code site), *what* (class + message + stack), *when* (session/turn/seq/timestamp/version), *why* (context: model, provider, tokens, tool, retries, config), *what Rune did* (the trail of events leading in — and what happened next).
4. **Struggles ≠ exceptions.** Thrash, abandonment, user corrections, and edit churn are first-class incidents even when no error was thrown. This is where "Rune breaks on varied codebases" actually lives.
5. **Redact by default.** No secrets, no env values, no file contents beyond snippets, opt-in for content capture. One scrubber chokepoint, property-tested.
6. **Version-stamped everything** — so "did v0.4 fix the top v0.3 failure?" is a query, not a feeling.

## 1.2 Failure taxonomy

Extend, don't invent: `packages/orchestrator/src/errors.ts` already has `ErrorClass` (8 classes) and `classifyError()`. Promote it into a shared hierarchical `IncidentClass` in `packages/shared` (the recorder lives below orchestrator, so shared owns the type):

| Family | Classes (initial set) | Existing seam that already sees it |
| --- | --- | --- |
| `provider.*` | rate_limit, auth, timeout, stream_drop, http_5xx, model_retired, fallback_triggered, malformed_tool_json_salvaged, malformed_tool_json_fatal | `gateway.ts` retry/fallback paths + `failureReason()`; `shared/json.ts parseToolArguments` (salvage = the debug-severity capture point) |
| `tool.*` | exec_failure, invalid_input, timeout, sandbox_denial, path_violation, mcp_server_crash, mcp_protocol_error, background_shell_lost | tool-registry execute wrapper; MCP client error paths; `rune-tools` exit codes + stderr via `rust-bridge.ts` |
| `loop.*` | breaker_trip, stuck_nudge, evidence_gate_refusal, verification_failed, max_turns, user_abort | `agent-loop.ts` — every one of these already exists as a code path (breaker, evidence gate, verifier, nudge) |
| `context.*` | forced_compaction, budget_overflow, freshness_mismatch, result_truncated | `context-engine.ts` budget pass; FileFreshness injection |
| `edit.*` | match_not_found, stale_hash, apply_conflict | edit tool results (success=false with reason) |
| `struggle.*` | thrash_reads, thrash_edits, rephrase, correction, abandoned_midtask, todo_unfinished, interrupt_burst | **new detectors** (§1.5) |
| `crash.*` | uncaught_exception, unhandled_rejection, dirty_exit, rust_tool_panic, tui_render_error | **new process guards** (§1.4) |

Severity: `debug` (recovered invisibly) / `warn` (degraded, recovered) / `error` (turn or tool hard-failed) / `critical` (crash, session loss, data risk).

## 1.3 The incident record

Stored in `~/.alan/blackbox.db` (SQLite, WAL — same engine as sessions). Two tables: `incidents` (every occurrence) and `fingerprints` (aggregates: `count`, `first_seen`, `last_seen`, `versions_seen`, `status: open|fixed|regressed`).

```ts
interface IncidentRecord {
  id: string;                    // uuidv7
  ts: string;
  version: string;               // app version + commit — regression tracking
  sessionId: string | null;      // null for pre-session crashes
  turn: number | null;
  seq: number | null;            // position in the session event log
  class: IncidentClass;
  severity: "debug" | "warn" | "error" | "critical";
  component: string;             // "gateway" | "agent-loop" | "tool:edit_file" | "mcp:<server>" | "tui" | "rust:bash" | ...
  where: string;                 // module#function code site
  what: { message: string; stack?: string; raw?: string };   // post-redaction
  why: {                         // machine context, all cheap to collect
    provider?: string; model?: string; tier?: string;
    tokensIn?: number; tokensOut?: number;
    tool?: string; argsHash?: string;
    retries?: number; breakerState?: string;
    permissionMode?: string; sandbox?: boolean; ui?: "tui" | "classic";
  };
  trail: TrailEntry[];           // last ~30 compact events: {seq, type, oneLineSummary}
  outcome: "pending" | "recovered" | "fallback" | "turn_failed"
         | "user_interrupted" | "abandoned" | "crash";       // resolved async, §1.5
  fingerprint: string;           // hash(class + component + normalized(message))
}
```

Two details that make this *reliable* rather than nice-to-have:

- **The trail is embedded, compact, and self-sufficient.** Incidents must stay meaningful after the session is deleted — trail entries are one-line summaries (the `ui/activity.ts` renderer already knows how to one-line every event type; reuse that logic, don't re-derive).
- **`outcome` is written twice.** Captured as `pending`, then a resolver (§1.5) watches the next K events / next startup and finalizes it. "Provider 429" is noise if recovered, signal if it killed the turn — outcome is what separates them.

## 1.4 Capture architecture

Grow `packages/telemetry` into the real thing (the `TelemetrySink` interface already exists there; keep the package, rename the surface):

```
packages/telemetry/src/
  recorder.ts        // Recorder: record(), trail ring buffer, flush policy
  taxonomy → (types in @rune/shared)
  redact.ts          // the single scrubber chokepoint
  store.ts           // blackbox.db (WAL), fingerprints, rotation
  sentinel.ts        // crash sentinel + spool recovery
  resolver.ts        // outcome resolution
  sinks.ts           // BlackboxSink (always-on local), later: opt-in remote
```

**Four tap types cover everything — not thirty call sites:**

1. **Tool middleware (one chokepoint).** The tool-registry execute wrapper sees every tool call and result (`success=false` → incident; nonzero bash exit → incident; sandbox denial parsed from `rune-tools` stderr → incident). This single tap covers the entire `tool.*` family, including MCP and background shells.
2. **Gateway tap (one chokepoint).** The gateway already centralizes retries, fallback (`failureReason()` at `gateway.ts:319`), and stream errors. Emit incidents at: retry exhausted, fallback triggered (warn, with reason), salvage performed (`parseToolArguments` gets an optional `onSalvage` callback — debug severity), terminal provider errors.
3. **Named loop sites (~8 explicit `record()` calls).** `agent-loop.ts`: breaker trip, evidence-gate refusal, verification failure, stuck nudge, max-turns, abort. `context-engine.ts`: forced compaction, budget overflow, freshness mismatch. These are deliberate — each is a named, load-bearing reliability event that deserves its own class, not a generic wrapper.
4. **Process guards.** `uncaughtException` / `unhandledRejection` handlers (flush + TUI-teardown-safe: restore terminal *then* write); signal handlers flush the spool; a **crash sentinel** file created at startup and removed on clean exit — if present at next startup, synthesize a `crash.dirty_exit` incident from the last spooled trail. Rust side: a panic hook in `rune-tools` that emits a JSON panic line on stderr, which the bridge middleware converts to `crash.rust_tool_panic`.

**Write path (crash-safe by construction):** hot path appends to an in-memory queue; a writer flushes to SQLite with severity policy — `debug/warn` batched (≤2s), `error/critical` synchronous with fsync before the call returns. Trail ring buffer spooled to disk every few seconds so `dirty_exit` incidents have context. Rotation: raw incidents pruned by age/size (configurable, default 30 days / 50MB); `fingerprints` aggregates kept forever (they're tiny and they're the longitudinal signal).

**Recorder self-protection:** every public recorder function catches internally; on internal failure it writes one line to `~/.alan/blackbox.last-resort.log` and disables the failing sink for the run. `rune doctor` reports recorder health — the black box must never be the thing that silently broke.

## 1.5 Struggle detection (the half that finds "Rune struggles with varied codebases")

A `StruggleDetector` running post-tool-call and post-turn (rule-based, zero LLM cost, all thresholds config-tunable):

| Detector | Rule (initial) | Emits |
| --- | --- | --- |
| Read thrash | same file read ≥3× in a turn without an intervening edit | `struggle.thrash_reads` |
| Edit churn | same file edited ≥4× in a turn, or edit→revert→edit of the same range | `struggle.thrash_edits` |
| Grep loop | same pattern searched ≥3× (loop breaker already trips on exact repeats — this catches near-misses that today just burn tokens) | `struggle.thrash_reads` |
| Rephrase | consecutive user messages with high token overlap (normalized similarity > threshold) — the user asked again because the answer failed | `struggle.rephrase` |
| Correction | user message opens with a negation/correction pattern ("no", "that's wrong", "you broke", …) — regex list first, cheap classifier later | `struggle.correction` (high-signal for F2) |
| Interrupt burst | ≥2 ESC aborts within a turn window | `struggle.interrupt_burst` |
| Unfinished todos | turn ends with todo items still pending and no handoff sentence | `struggle.todo_unfinished` |
| Abandonment | resolver-side: session ended mid-task (pending todos / unanswered ask_user) and never resumed by next startup sweep | `struggle.abandoned_midtask` |

**Outcome resolver:** runs (a) at turn end — pending incidents in that turn get `recovered`/`turn_failed`/`user_interrupted`; (b) at startup — a sweep resolves stale `pending` to `abandoned`/`crash` using the sentinel and session status. Cheap, deterministic, no model calls.

## 1.6 Triage narratives (where "why" becomes a story)

Raw incidents answer *what happened*; the developer fixing v-next needs *why*. Post-session, if the session contained ≥1 `error`+ incident or ≥2 struggles, queue a **triage job**: the light routing tier (already exists: heavy/standard/light) writes a structured `IncidentReport`:

- what the user was trying to do (from first user msg + todos)
- what went wrong, in causal order (from trail + incidents)
- root-cause hypothesis, named component, confidence
- suggested fix category: `prompt | loop-logic | tool | provider-handling | context | eval-gap`
- `reproHint`: the minimal ingredients to rebuild it as an eval task (task prompt, repo shape, tool sequence)

Budget-capped (skip silently when no cheap model is available — local Ollama qualifies), stored beside the incident, never blocks anything. This reuses the exact pattern the system-memory "dream" already uses (opportunistic, cheapest model, cadence-gated).

## 1.7 Surfacing — user, developer, and the version loop

- **`rune doctor`** — health snapshot: recorder status, crash sentinel, last 7 days incident counts by class/severity, top 5 fingerprints, provider fallback rates, sandbox status.
- **`rune incidents [list|show <id>|top|export]`** — browse and inspect; `show` renders the trail; `top` ranks fingerprints; `export` writes a **redacted** bundle (JSONL + reports) for filing an issue — this is how a user reports reliably without knowing what matters.
- **`/bug` in-session** — user-initiated capture: current trail + last turn + a user note, flagged `user_reported`. The highest-value labeled data there is; costs one keystroke at the exact moment of frustration.
- **Version-over-version:** `rune incidents top --by-version` diffs fingerprints across versions: *new in this version / fixed since last / regressed*. This is the sentence the user asked for — "so that with updated versions the system could be updated with required refinements" — made into a query.
- **Incident → eval task converter (`tests/eval/from-incident.ts`):** takes an incident id, scaffolds an eval task from the triage `reproHint` (fixture + prompt + expected checks) for a human to finish. **Rule of the loop: every `critical` and every top-5 weekly fingerprint gets an eval task before its fix lands.** That welds F1 to the eval compass (Blueprint v2 R1) permanently.
- **Remote sink:** explicitly *not* in v1. The `TelemetrySink` seam stays, so an opt-in aggregate uploader (per Blueprint v2 D6.3) is a later drop-in, not a rewrite.

## 1.8 Testing the recorder (the reliability system must be the most reliable thing)

- **Unit:** fingerprint stability, severity policy, rotation, resolver state machine; **property tests on the scrubber** — generated secrets (sk-…, ghp_…, AKIA…, env dumps, home paths) must never survive redaction.
- **Chaos harness (`tests/integration/blackbox-chaos.test.ts`):** injected failures at each tap — fake 500/429 storms, tool exit 1, malformed tool JSON, MCP server kill, engine-host stdio cut — assert an incident exists with correct class, component, trail, and eventual outcome.
- **PTY crash tests:** `kill -9` the CLI mid-turn (PTY harness exists) → restart → assert `crash.dirty_exit` with a non-empty trail; TUI mode asserts terminal restored *and* incident written.
- **Overhead guard:** micro-bench in `bench/` — record() p99 < 1ms, zero incidents lost under a 1k-event burst.

**F1 exit criteria:** all four tap types live; chaos suite green on mac+linux CI; `rune doctor`/`incidents`/`/bug` shipped; a real dogfood week where every observed misbehavior (however small) is findable in `rune incidents` afterwards — that last one is the actual acceptance test, run deliberately.

---

# FEATURE 2 — THE EVOLUTION LOOP (self-evolving agent)

## 2.1 Stance

Rune evolves the way you meant it: **an evolving system, not a cyborg.** Concretely:

- It mutates **data, never code**: facts, lessons, skills, policy values. All human-readable, inspectable, deletable.
- Every artifact carries **provenance** (which sessions/incidents birthed it), **scope** (repo / provider / global), **lifecycle status**, and **outcome stats**.
- **Nothing self-promotes without measurement.** Live outcome signals (from F1) promote repo-scoped artifacts; anything global must additionally win an offline eval A/B. No measurement → no mutation. This is what keeps "self-evolving" from becoming "self-deluding".
- **`--pristine`** runs the agent with zero learned artifacts — the control group. It makes evolution *measurable*: run the eval suite pristine vs. evolved and publish the delta ("evolution lift"). No competitor publishes that number; it's an honest-marketing asset in the same family as the audit chain.

## 2.2 What evolves — four substrate layers

Ordered by power; each layer ships separately and must prove value before the next unlocks.

**Layer 1 — FACTS (repo memory).** "This repo tests with `bun test`, not npm." "CI is turbo." "Auth lives in services/auth." Objective, verifiable, low-risk. **Builds directly on what exists:** `memory/episodic.ts` already has `EpisodicFact` + `extractFactsFromSummary()`, and Blueprint v2 R2.4 already specifies the `discovery` session event. This layer = wiring those into a per-repo store + injection: `~/.alan/evolution/repos/<repo-hash>/facts.db`, injected into the session-memory context tier, token-budgeted, each fact stamped with `(source: seq/incident, verifiedAt, staleAfter)`. Facts invalidate on freshness mismatch (the FileFreshness machinery already detects exactly this).

**Layer 2 — LESSONS (behavioral heuristics).** "In this repo, edit matches fail on tabs — read wider context before editing." "Provider X mangles parallel tool calls above 4 — cap fan-out." Structured, trigger-matched:

```ts
interface Lesson {
  id: string;
  scope: { kind: "repo" | "provider" | "tool" | "global"; key?: string };
  trigger: { kind: "tool_about_to_run" | "incident_class" | "task_kind" | "always"; match?: string };
  advice: string;                                  // ≤ 2 sentences, imperative
  provenance: { incidents: string[]; sessions: string[] };
  status: "candidate" | "trial" | "active" | "retired";
  stats: { fired: number; winRate: number; lastFired: string };
}
```

Injection is **selective, not cumulative**: only lessons whose trigger matches the current moment (about to edit / just saw incident class X / provider Y active), global token budget ≤ ~600, ranked by confidence × recency. Injected inside a fenced block labeled *"Learned notes (heuristics from past sessions — may be wrong, verify against reality)"* — the agent is told to treat them as hints, never orders.

**Layer 3 — SKILLS (procedural memory).** When reflection detects the agent performed essentially the same ≥5-step procedure successfully in ≥2 sessions (e.g., this repo's release dance, its e2e setup), it drafts a skill. **Reuses the existing skills loader and progressive disclosure wholesale** — self-authored skills live in `~/.alan/evolution/skills-learned/<name>/`, namespaced `learned:*`, visible in `/skills`. **Consent gate:** a learned skill is inert until the user approves it once (a permission-card moment: "Rune drafted a skill from sessions X, Y — review & enable?"). Skills can direct multi-step behavior, so a human stays in the activation loop. That's the "self-mutating but consent-gated" balance.

**Layer 4 — POLICIES (bounded numeric knobs).** The only layer that changes *mechanics* rather than context. Start with exactly three knobs the loop already consults: model-tier choice per task class, parallel fan-out width, verification strictness. Each: hard min/max bounds, per-repo/provider value, success-rate-weighted update (a bandit in spirit, a clamped moving average in practice), instant reset to defaults via kill switch. No knob touches permissions or sandbox — structurally (the permission broker never reads the evolution store).

## 2.3 When it learns

- **In-session (reflex):** freshness mismatch → fact invalidated; user correction (F1's `struggle.correction`) → candidate lesson tagged high-signal; verified discovery → fact. Zero extra model calls — these ride events that already fire.
- **Post-session reflection ("dreaming v2"):** extends the existing system-memory dream machinery (cadence config, cheapest-model, opportunistic-at-startup — all built). Trigger: sessions with incidents, corrections, or notable success (long task passing the evidence gate). Output: fact updates + candidate lessons + (rarely) a skill draft. Same cost posture as today's dreaming: default manual/daily, never surprise spend.
- **Distillation (weekly):** over fingerprint aggregates + lesson stats: merge near-duplicate lessons, promote/retire per lifecycle rules, compress fact stores, expire stale scopes. Pure bookkeeping + one cheap model pass.

## 2.4 Selection — the honesty machinery

The failure mode of every "self-improving agent" is drift into superstition. The gates:

1. **Lifecycle:** `candidate` (stored, never injected) → `trial` (injected; every firing logs `(lessonId, sessionId, outcome)`) → `active` (fired ≥ N_min times with win-rate ≥ baseline + margin) → `retired` (win-rate decays, or unfired for M weeks, or user disables). Every transition recorded with its evidence.
2. **Outcome signal comes from F1** (this is the hinge between the features): a turn is a *win* if it ended with no `error`+ incidents, no interrupt/rephrase/correction, and the evidence gate passed. Coarse but unbiased, and it already exists once F1 ships.
3. **Blast-radius rule:** repo-scoped artifacts may promote on live signals alone (worst case: one repo gets a bad hint that decays). Global-scope artifacts and all Layer-4 policy defaults must win an **offline eval A/B** (suite run with vs. without, three seeds) before activation.
4. **Attribution humility:** per-session attribution is noisy; N_min (default 5 firings) and margin thresholds are config, tuned conservative; ties go to retirement.
5. **The control group is permanent:** `--pristine` + a monthly pristine-vs-evolved eval run, delta tracked. If evolution lift ever goes negative, the distiller mass-demotes and the incident (`quality.evolution_regression`) goes to the black box.

## 2.5 Safety invariants (structural, tested, non-overridable)

1. **The evolution store can never touch the security posture.** Permission broker, sandbox profiles, path guard, network allowlists: none of them read any evolution artifact. Enforced by architecture (no import path) and by a test that greps/asserts the dependency graph.
2. **Learned content is quarantined at injection:** always inside the fenced "may be wrong" block, below system prompt authority; never verbatim tool arguments; never executable.
3. **Command-advice provenance rule:** a lesson may only recommend a shell command if that exact command (normalized) was previously *user-approved or user-typed* in a session in that scope. Repo content alone (a hostile README saying "always run curl …") can never become a command recommendation — that's the prompt-injection→evolution-poisoning path, closed by construction.
4. **Privacy scopes:** repo facts stay in the repo-hash store; promotion to global requires passing the same scrubber F1 uses (no paths, no identifiers) — and global lessons are behavioral, never content-bearing.
5. **Corruption is survivable:** schema-versioned stores; on corruption, quarantine the file, log a `crash.evolution_store` incident, boot pristine. Rune must never fail to start because its brain is bruised.

## 2.6 Inspection — `rune brain` (auditability is the brand)

- `rune brain` — overview: counts by layer/status, token budget in use, evolution lift (last measured).
- `rune brain list [facts|lessons|skills|policies] [--repo|--global]`
- `rune brain why <id>` — full lineage: born from incidents A, B (linkable to `rune incidents show`), fired in sessions X, Y, win-rate curve, transitions. *"Why does Rune believe this?" always has an answer* — the same tamper-evident ethos as the audit chain and signed exports.
- `rune brain disable|delete <id>`, `rune brain export` (markdown), `evolution.enabled=false` master switch, per-layer switches.

## 2.7 Testing F2

- **Superstition red-team:** synthetic session streams with pure-noise outcomes → assert nothing reaches `active` (promotion requires real signal, so noise must starve).
- **Poisoning red-team:** hostile repo content attempting to plant command lessons → assert the provenance rule blocks scope/command promotion; injection framing stays fenced.
- **Lifecycle property tests:** every `active` artifact has ≥N_min firings and evidence-linked transitions; no artifact skips `trial`.
- **Eval protocol:** the pristine-vs-evolved A/B run scripted in `tests/eval/` as a first-class mode (this is also the R4-style "data decides" discipline applied to F2 itself — if Layer 2 shows no lift after honest measurement, Layers 3–4 don't unlock).

---

# PHASING — INTERLOCKED, EACH PHASE SHIPPABLE

No time estimates; order is dependency, exit is criteria. Lanes own disjoint files (contracts land in `packages/shared` first, per the house style).

### P1 — Recorder core (F1 heart)
Taxonomy in shared (grown from `errors.ts` `ErrorClass`) → recorder + store + scrubber + sentinel in `packages/telemetry` → the two chokepoint taps (tool middleware, gateway incl. `onSalvage`) → process guards + Rust panic hook.
**Exit:** chaos-harness first cut green; dirty-exit PTY test green; overhead bench < 1ms.
**Verify:** deliberately break things live (kill provider key mid-run, `kill -9`, feed malformed JSON) and read them back via sqlite.

### P2 — Struggles, outcomes, surfaces
Named loop sites + StruggleDetector + outcome resolver + `rune doctor` / `rune incidents` / `/bug`.
**Exit:** the dogfood-week acceptance test — every misbehavior observed while using Rune on real work is findable in `rune incidents`.
**Verify:** scripted PTY scenarios for each detector + one week of real use with a daily check.

### P3 — Triage + the version loop
Light-tier triage reports; `--by-version` fingerprint diffing; `tests/eval/from-incident.ts` converter; rotation/pruning.
**Exit:** one real incident carried end-to-end: captured → triaged → converted to an eval task → fixed → fingerprint shows `fixed` in the next version.
**Verify:** that end-to-end walk, done once for real, documented.

### P4 — Facts layer + brain viewer (F2 opens; can start parallel to P2)
Per-repo facts store wiring `EpisodicMemory` + R2.4 discovery events; budgeted injection; freshness invalidation; `rune brain` (read-only first).
**Exit:** second session on a known repo measurably cheaper (repeat-task eval: token cost ↓, discovery reads ↓) — the first evolution-lift datum.
**Verify:** repeat-task eval protocol, plus live: ask the same question twice across sessions, watch the second skip discovery.

### P5 — Lessons + lifecycle + pristine (needs P2's outcome signal)
Lesson store, trigger-matched injection, lifecycle engine, `--pristine`, brain management commands, superstition/poisoning red-team suites.
**Exit:** first lesson honestly promoted to `active` on live win-rate; pristine-vs-evolved eval delta ≥ 0 (no harm proven before value claimed); red-team suites green.
**Verify:** `rune brain why` on the promoted lesson tells a true, complete story.

### P6 — Reflection cadence, skills, policies (each unlocks only if the prior layer showed lift)
Dream-v2 candidate generation from incident clusters → consent-gated learned skills → the three policy knobs with eval-gated defaults.
**Exit:** measured positive evolution lift on the eval suite with all enabled layers; every safety invariant test green; kill switches verified live.
**Verify:** monthly pristine-vs-evolved run becomes routine; lift published in docs.

### Lane ownership (parallel-safe)
- **Lane A (recorder/F1 core):** `packages/telemetry/**`, `packages/shared` (types, `onSalvage` seam), gateway tap, tool-middleware tap, `rune-tools` panic hook.
- **Lane B (detectors + CLI surfaces):** `orchestrator/src/struggle-detector.ts` (new), named loop-site calls, `commands.ts` additions (`doctor`, `incidents`, `/bug`).
- **Lane C (evolution):** `orchestrator/src/evolution/**` (new), `memory/**` extensions, brain commands, learned-skills dir loader hook.
- **Lane D (proof):** chaos harness, PTY crash tests, red-team suites, repeat-task + pristine-A/B eval protocols in `tests/eval/`.
Contracts before fan-out: `IncidentClass`, `IncidentRecord`, `Outcome`, `Lesson`, `LearnedArtifact` in `packages/shared`.

---

# RISKS SPECIFIC TO F1/F2

| Risk | Mitigation |
| --- | --- |
| Recorder becomes the crash | Self-protection wrapper, last-resort log, overhead bench in CI, `rune doctor` self-report |
| Secrets leak into incidents/exports | Single scrubber chokepoint, property-tested; content capture opt-in; export always re-scrubbed |
| Superstition (learning noise) | Lifecycle gates, N_min firings, pristine control, negative-lift auto-demotion |
| Evolution poisoning via hostile repo content | Command-provenance rule, fenced injection, scope promotion scrub, red-team suite |
| Prompt bloat from accumulated lessons | Hard token budget, trigger-matching (inject only what's relevant *now*), decay |
| Attribution noise → wrong promotions | Coarse outcomes only, conservative thresholds, eval A/B gate for anything global |
| Disk growth | Severity-based rotation, aggregates-forever/raw-pruned split |
| Dual-writing sessions + incidents drift apart | Incidents reference session seq; trail embedded so incidents stand alone |

---

# FIRST THREE MOVES (today-sized, disjoint)

1. **Types + taxonomy in `packages/shared`** — `IncidentClass` (grown from `errors.ts`), `IncidentRecord`, `Outcome`, severity policy. Pure types + the fingerprint function with tests. Unblocks every lane.
2. **Recorder + store + sentinel in `packages/telemetry`** — replace the 28-line stub with the real pipeline against a temp DB, with the crash-sentinel PTY test. No integration yet; provable standalone.
3. **Gateway tap** — incidents from the fallback path (`failureReason` already computes the *why* string) + the `onSalvage` callback in `shared/json.ts`. Smallest real integration, immediately starts recording the most common real-world failure family (provider flakiness).

*End of plan. The measure of F1 is a week of dogfood where nothing that went wrong is unexplained; the measure of F2 is a published pristine-vs-evolved delta. Everything else is scaffolding for those two sentences.*

---

# IMPLEMENTATION STATUS — 2026-07-04

**Shipped (769 unit tests + workspace typecheck + 25/25 mock eval green; live-proven with a real provider 401 flowing gateway→recorder→store with resolved outcome):**

- **Contracts** (`packages/shared/incident.ts`): full taxonomy (41 classes, 7 families), `IncidentRecord`, fingerprinting with volatile-part normalization, salvage listener seam in `json.ts`.
- **Recorder** (`packages/telemetry`): synchronous WAL SQLite store (`~/.alan/blackbox.db`), fingerprint aggregates kept forever, severity model, property-tested redaction chokepoint, trail ring buffer + disk spool, crash sentinel (arm/disarm/consume → `crash.dirty_exit` with spooled trail), never-throws self-protection with last-resort log + self-disable.
- **Taps:** gateway (fallback + terminal, survives rebuilds), agent-loop named sites (rate-wait, stream errors, consecutive-errors, truncation, verification-failed, evidence-gate, stuck-nudge, infinite-loop, breaker-refusal, max-turns), engine tool chokepoint with text-based failure classifier (incl. rust-panic + sandbox-denial detection), salvage events, process guards (uncaught/unhandled → `recordFatal`), per-run outcome resolution (recovered / turn_failed / user_interrupted) + startup sweep (>2h pending → abandoned).
- **Struggle detectors** (rule-based, zero tokens): read/edit/search thrash, rephrase (token-Jaccard), correction openers, interrupt burst, unfinished todos — one incident per pattern per run.
- **Surfaces:** `rune doctor`, `rune incidents [list|show|top [--by-version]|export]` (engine-free, instant), `/bug` in classic + TUI.
- **F2 notebook v1** (`orchestrator/src/notebook/`): scoped store (repo/stack/global, converging upserts, uses/wins, decay), deterministic stack fingerprinting (`bun+rust+ts+turbo`-style keys for cross-project transfer), rule-based capture (verified test/build/typecheck/lint commands; failed→succeeded command-variant tactics — the "figured it out on the 7th try" scenario; monorepo layout), budgeted fenced injection cached per session for prompt-cache stability, win attribution on clean runs, `CostGovernor` (≤2% + floor, contract-tested), `rune notebook` + `/notebook`, `--pristine` flag, `[diagnostics]`/`[notebook]` config sections, engine-host (desktop) enabled too.

**Deliberately deferred (next passes):** triage narratives on the light tier (P3 — governor is ready for it), incident→eval-task converter (P3), a real PTY `kill -9` crash drill (sentinel logic is unit-tested; the live drill needs a real terminal), abandonment resolution keyed to session-resume state, weekly distillation pass, pristine-vs-evolved eval protocol run.
