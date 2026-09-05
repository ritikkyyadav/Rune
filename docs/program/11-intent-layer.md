# Phase 11 — The intent layer

> **Withdrawn 2026-09-03 (P11.2, P11.3).** The founder decided the product is the terminal interface
> only; the primitives, the projection schema, the composer and the planned shell were removed with
> the web app. P11.1 — the task state model, the narrative events and the Decision Record — is engine
> work and stays. This file is kept as the record of the direction and its reasoning.

**One agent at a time · after Phase 10 · supersedes the chat-centred parts of Phase 9**

## The correction that created this phase

After using the Phase 9 web app the founder said it is "one of the simplest chat interfaces" and not what was asked for. What was asked for, in the founder's words and the essay they attached ("Intent Operating Layer"):

- **The only static chrome is a left control deck**: spawn a new session; a catalog of named **projects** plus a personal workspace; the **session** history; the applications a person has connected (not to be called "plugins" or "connectors"; this brief uses **Apps** until the founder names it); and a top entry for **Settings** (providers, teams, the rest).
- **The core is an intent strip.** Rune starts almost empty: a high-quality animated strip that asks what the person wants done. Below it, two lists: **Active work** with progress, and **Needs you**, an inbox of decisions across all sessions. Everything else appears only when a task needs it.
- **The workspace is the agent's playground, but never free-form.** The agent composes the task surface from a closed catalogue of trusted primitives through a small set of projection personas; the model emits a validated projection, never HTML, so a small model cannot break the interface.
- **The purpose is understanding.** The person must feel what is being built and learn from the work. Show the experimentation while it runs (the hypotheses tried), fold the branches that turned out wrong, and end every task in one clean artifact that a person reads top to bottom and understands how the decision was reached. Chat is the input; the interface is the output.

Non-goals: modes or workspaces named by category ("coding mode"); tabs for research, code, data; a transcript as the primary surface; model-generated markup; a system-wide ⌘Space layer (later, on the same task state).

## Architecture

```
   language / voice
         │
         ▼
   Intent Interpreter          one call: objective, task kind, constraints, the project
         │
         ▼
   Task Graph                  sessions, sub-agents, workflows (exists: engine, team bus, rune workflow)
         │
   ┌─────┴──────┐
   │            │
Harness      Runtime           reasoning and execution (exist, unchanged)
   │            │
   └─────┬──────┘
         ▼
   Task State Model            objective · kind · state · constraints · agents · artifacts ·
                               evidence · narrative (hypotheses, branches, decisions) ·
                               actions · permissions · pending decisions   (mostly exists: the plan ledger)
         │
         ▼
   Interface Composer          Task State → Projection (JSON, validated against a schema)
         │
         ▼
   Primitives                  ~30 React components with strict prop schemas, both themes
```

The task state is the source of truth, not the screen. A projection binds primitives to state paths, so the surface updates live as events arrive without re-composing.

## The three states (wireframes)

**Empty.** The deck on the left is the only chrome. Nothing else until there is work.

```
┌─────────────┬──────────────────────────────────────────────────────────┐
│ ⚙ Rune    ⚙ │                                                          │
│             │                                                          │
│ + New       │              What do you want to get done?               │
│             │        ┌────────────────────────────────────────┐        │
│ Projects    │        │                                        │        │
│  · Rune     │        └────────────────────────────────────────┘        │
│  · Personal │                                                          │
│             │   Active work                                            │
│ Sessions    │   ──────────────────────────────────────────────         │
│  today ·    │   ● API latency investigation                 61%        │
│  yesterday  │   ● Supplier research                     waiting        │
│             │   ✓ Auth refactor                        completed       │
│ Apps        │                                                          │
│  Notion ●   │   Needs you                                        2     │
│  GitHub ●   │   ──────────────────────────────────────────────         │
│             │   Database migration  48,219 rows          [Review]      │
│             │   AWS permission      s3:PutObject         [Approve]     │
└─────────────┴──────────────────────────────────────────────────────────┘
```

**Working.** The task surface is a projection chosen for the task kind. Hypotheses are visible while they are being tested; a refuted one folds to one line with its reason.

```
┌─────────────┬──────────────────────────────────────────────────────────┐
│ deck        │ API latency investigation            investigating · 4m  │
│             │ ──────────────────────────────────────────────────────── │
│             │ Deployment    v2.18.4 → v2.18.5     Latency  182 → 487 ms│
│             │                                                          │
│             │ Hypotheses                                               │
│             │ ▸ cache eviction on deploy          refuted · TTL same   │
│             │ ▸ connection pool exhaustion        refuted · pool 40/200│
│             │ ● query regression in orders.ts     testing              │
│             │   src/database/orders.ts   - old query / + new query     │
│             │   explain analyze: seq scan on orders (1.2M rows)        │
│             │                                                          │
│             │ [Timeline] [Metrics] [Changes] [Logs]                    │
│             │                                                          │
│             │ Needs you: none · 2 agents working · $0.14               │
└─────────────┴──────────────────────────────────────────────────────────┘
```

**Done.** The Decision Record: the one artifact a person reads from top to bottom. Every claim links to its evidence; the folded branches stay folded but present.

```
┌─────────────┬──────────────────────────────────────────────────────────┐
│ deck        │ API latency investigation                  done · 11 min │
│             │ ──────────────────────────────────────────────────────── │
│             │ Objective   Why did API latency rise after v2.18.5?      │
│             │ Decision    The new orders query lost its index; fixed   │
│             │             by restoring the (customer_id, created_at)   │
│             │             index. Latency 487 → 176 ms.        evidence │
│             │ How we got here                                          │
│             │  1 cache eviction        refuted  TTL unchanged   evidence│
│             │  2 pool exhaustion       refuted  pool at 20%     evidence│
│             │  3 query regression      confirmed seq scan       evidence│
│             │ What changed   migrations/0042_orders_index.sql   [diff]  │
│             │ Checks         12 tests · typecheck · p95 176 ms  [logs]  │
│             │ What remains   backfill on replica (held for approval)    │
│             │                                                          │
│             │ [Open transcript]  [Export]  [Start follow-up]           │
└─────────────┴──────────────────────────────────────────────────────────┘
```

## The Task State Model (what exists, what is added)

Exists in `packages/orchestrator/src/task-state.ts` and the events: `goal`, `priorGoals`, `todos` with `StepEvidence`, `handoff`, `log`, held steps and `auto_deferrals`, `safety_decision`, cost rows, `tool_progress` with typed child events, verification events, checkpoints.

Added:

- `kind`: `investigate | build | analyze | research | operate | write` (the Intent Interpreter sets it; the model may revise it once).
- `narrative`: hypotheses `{id, text, status: proposed|testing|refuted|confirmed, evidence: EvidenceRef[], reason?}`; `decisions` (revive the dead `decisions` field with a recorder: `{id, text, basedOn: EvidenceRef[], at}`); `artifacts` `{id, kind: file|diff|report|chart|table|preview, ref}`.
- `pendingDecisions`: one list unifying held steps, `ask_user` questions, approvals and reviews, each with a deadline and a resolution; the inbox reads this.
- `progress`: a number derived from the ledger (steps with evidence over steps), never guessed.

Events added to `@rune/protocol`: `hypothesis`, `hypothesis_updated`, `decision`, `artifact`, `projection` (the composer's output for a task, and updates), `pending_decision` and `decision_resolved`. The model reports its experiments structurally through two small tools, `note_hypothesis` and `record_decision`, extending the existing `record_evidence` seam; the harness also infers hypotheses from plan steps that a verification refutes.

## Primitives (the closed catalogue)

Thirty, each a React component with a zod prop schema, empty, loading and error states, light and dark, keyboard access, and a gallery page at `/gallery` that renders every primitive in every state so a reviewer can judge the whole vocabulary on one screen:

Text · Heading · Metric · Table · Chart (line, bar) · Timeline · Diff · File · Tree · Terminal (command and output) · Source (a citation with locator) · Evidence (a claim bound to its sources) · Hypothesis (an experiment card with status) · Decision · Checklist (the plan) · Progress · Approval (a held step with exact grant) · Choice (an `ask_user` question) · Form · Comparison · Relationship (a small graph) · Artifact · Preview (image or sandboxed HTML) · Log (a fold of raw output) · Transcript (a fold of the conversation) · Agent (a fleet row) · Cost · Warning · Link · Divider.

No primitive accepts raw HTML except Preview, which renders in a sandboxed iframe.

## Projection and composer

- **Projection schema**: `{ taskId, persona, regions: { header, primary, side?, actions }, blocks: [{ id, type, props, bind?: statePath, foldWhen?: predicate }] }`, validated with zod on both sides. Blocks bind to state paths so live updates need no recomposition.
- **Composer**: deterministic rules per task kind produce the default projection (investigate → hypotheses + evidence + timeline; build → checklist + diff + terminal + checks + approval; analyze → metric + chart + comparison + table + sources; research → claims + sources + evidence; operate → approvals + logs + timeline; write → artifact + outline + sources). The model may call `compose_view` with a persona and an emphasis list from a whitelist; an invalid call is logged and the default stands. Nothing the model says can add a block type that is not in the catalogue.
- **Folding**: a hypothesis with status `refuted` folds to one line with its reason; folds are reversible; the Decision Record keeps them present.
- **The Decision Record**: generated deterministically from state at task end (objective, decision with evidence, how we got here, what changed, checks, what remains); rendered from primitives; exportable as Markdown and as the signed trace; also rendered as text by `rune audit`.

## The deck

New (⌘N; opens the intent strip in the current project). Projects: a catalog of named projects (a folder plus settings, sessions and apps scoped to it) and a personal workspace that is a project without a repository. Sessions: grouped by day, searchable (⌘K), each row showing kind, progress and whether it needs you. Apps: what the person connected, with status and a one-click connect flow (the `rune mcp` and `rune login` flows in-page). Settings at the top: providers and models, teams (the founder to define: multi-instance team bus, or people), gears, theme, telemetry.

## Work items

**P11.1 Task State Model and the narrative (engine, protocol).** Add `kind`, `narrative`, `artifacts`, `pendingDecisions`, `progress`; the events; the `note_hypothesis` and `record_decision` tools; the refutation inference from failed verifications; the Decision Record generator with a text rendering in `rune audit`; persistence and replay. Deterministic mock eval: a three-hypothesis bug hunt whose record must list two refuted branches with reasons, one confirmed with evidence, and a decision linked to that evidence.

**P11.2 Primitives and the composer (web).** The thirty primitives with schemas and the `/gallery` page; the projection schema; the deterministic composer per task kind; `compose_view` with the persona whitelist and fallback; brand-checklist coverage of every primitive.

**P11.3 The shell.** The deck (New, Projects, Sessions, Apps, Settings), the intent strip with its empty state, Active work and Needs you fed by the state model across sessions, and the task surface rendering projections. The transcript becomes the Transcript primitive, folded by default. Rename "Connect" to the founder's name for Apps.

**P11.4 The narrative in motion.** Live hypotheses with folding; the Decision Record surface with evidence links and export; the follow-up action; the "read it top to bottom" eval from P11.1 driven through the real page in Playwright.

**P11.5 Proof.** Screenshots of the three states in both themes at 1440×900 and 1024×768; Playwright for the empty state, an investigate task and a build task; the packaged smoke unchanged.

Each item is one agent, one PR, the local gate plus its own evidence; the rules of docs/program/00-program.md §0 and the additions from Phase 10 apply. GitHub Actions is blocked at the account level until the founder fixes billing; the local gate is the proof.

## What the founder is asked

1. Confirm the three wireframes, or mark them up.
2. Name the connected applications ("Apps" is the placeholder).
3. Say what "teams" means in Settings: the multi-instance team bus, or people and organisations.
4. The mark: the current geometric rune is provisional; supply the vector, or ask for a new mark to be designed.
