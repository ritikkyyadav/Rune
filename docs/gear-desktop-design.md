# Gear Desktop — research + design contract (v1 draft, 2026-08-21)

**Ask (user, 2026-08-21):** the terminal is not a good enough surface for a usable product. Build Gear as a proper desktop application (macOS `.dmg`) on the *same harness*, in the `gear-customizer-v2.html` visual language, where — like the traceable open-source harness the user has seen — every chain is traceable: for every answer you can see which prompts, tools, permissions and system facts produced it. Before designing, understand why Claude Code's output feels mature and compelling, and carry that into the desktop UX.

This document is the written half of the contract; `docs/design/gear-desktop-v1.html` (alongside `docs/design/gear-customizer-v2.html`) is the interactive half. The CLI keeps the v2 terminal contract already shipped (`e6fb08f`); the desktop is the primary surface going forward.

---

## 1. Research A — why Claude Code's output feels the way it does

Sources: [How Claude Code is built (Pragmatic Engineer)](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built) · [Claude's thinking words / spinner verbs](https://agnamihira.medium.com/claudes-thinking-words-the-hidden-personality-behind-the-spinner-verbs-ed21384ec8ec) · [Customizing spinner verbs](https://www.alexandrasamuel.com/ai/customize-claude-code-spinner-verbs) · [Inside Claude Code: architecture](https://tapti-sippy.medium.com/inside-claude-code-a-deep-dive-into-the-architecture-of-an-ai-powered-terminal-ae9f508d3cb3) · [There's a React app running in your terminal](https://levelup.gitconnected.com/theres-a-react-app-running-in-your-terminal-right-now-31a22d8da2f6) · first-hand (the Claude Code surface itself).

**Stated principles (Boris Cherny / Anthropic):**
- *"We want people to feel the model as raw as possible"* — UI scaffolding is kept minimal because scaffolding limits the model.
- *"With every design decision we almost always pick the simplest possible option."*
- *"Every time there's a new model release, we delete a bunch of code"* — the harness shrinks as the model improves; the UI never tries to be smarter than the model.
- The model drives; the client defines the UI, exposes tools and hooks, then *gets out of the way*.
- The hardest UX component was **permissions** (allow once / session / deny); the **todo list** went through 20+ prototypes before it felt right.
- The tone is deliberate: warm, playful-but-earnest spinner verbs ("Pondering", "Percolating") — personality as a product decision, not decoration.

**The mechanics that make it feel "it knows, and it shows it knows" (observed):**

| # | Mechanic | Why it builds trust | Gear status |
|---|---|---|---|
| 1 | **Intent before action.** A sentence of narration, *then* the tool call. You always know what it is about to do and why. | Predictability. Nothing happens un-announced. | CLI v2: Plan bullet + tool bullets ✓ · Desktop: same stream |
| 2 | **Every action is a visible bullet with collapsed evidence** (`⏺ Read file (42 lines)`), expandable on demand. | Full audit at a glance; depth when you want it. | CLI ✓ · Desktop: bullets + Trace rail |
| 3 | **One honest status line**: spinner · verb · elapsed · tokens · `esc to interrupt`. Never a fake progress bar. | Time and cost are never hidden; interrupt is always one key away. | CLI ✓ (`⚙︎ Running tools… (4s · ↓1.8k)`) · Desktop: status row + trace timing |
| 4 | **The permission prompt names exactly what will run**, with the exact command/diff, and offers once / session / deny. | Consent is specific, not a vague "allow tool?". | CLI ✓ (rail card) · Desktop: inline card (no modal) |
| 5 | **An explicit task list** with ✓/›/○ that updates as work proceeds. | You see the plan and progress without asking. | CLI ✓ · Desktop: Plan in stream + sidebar progress |
| 6 | **Diffs are shown, not described.** Edits always render their hunk. | Evidence over claims. | CLI ✓ · Desktop: diff cards + Review tab |
| 7 | **Receipts at the end**: duration, tokens, files changed, checks that ran. | Closure; you know what it cost and what changed. | CLI ✓ · Desktop: summary strips + Trace totals |
| 8 | **Errors stay inline and honest** (no pretending, no silent retries). | You trust the good news because the bad news shows up too. | CLI ✓ (✕ / fallback card) |
| 9 | **Depth on demand** (ctrl+o / ctrl+r full transcript; verbose mode). | Default is calm; nothing is lost. | CLI ✓ (ctrl+r) · Desktop: **Trace rail + inspector** |
| 10 | **Stable layout**: pinned composer, no jumping; 60 fps redraw; streaming text with a cursor. | Feels alive, never janky. | CLI ✓ · Desktop: native |
| 11 | **One accent, calm typography, no chrome**. | Attention goes to the work, not the UI. | Customizer tokens ✓ |
| 12 | **Consistent voice**: the system and the model speak the same way; no "AI assistant" theatre. | Maturity. | doctrine + UI copy ✓ |

**What other agents get wrong** (and the desktop must not): chat-bubble layouts that hide tools; modals that interrupt the stream; progress bars that lie; "done!" without evidence; hiding the command that is about to run; walls of raw JSON; personality as sticker-on-top rather than consistent voice.

## 2. Research B — the traceable harness (DeepAgents + LangSmith) and what Gear adopts

The user's "deep six harness" is, as far as the web shows, LangChain's **DeepAgents** — [the batteries-included agent harness](https://github.com/langchain-ai/deepagents) (planning, filesystem/shell tools, sub-agents, built on LangGraph). Its headline property is native **LangSmith tracing**: [every run is a tree](https://docs.langchain.com/langsmith/trace-deep-agents) — parent run → child spans for each model call, each tool run (inputs/outputs), each sub-agent (tagged `lc_agent_name`), with latency, status/error, metadata, a "messages" view and filtering. (Adjacent: [Arize's coding-agent tracing](https://arize.com/blog/open-source-coding-agent-tracing/) inspects prompts, tool calls, retries, token usage per step across Claude Code/Codex/Cursor.)

**What Gear adopts — and pushes further, because Gear owns the harness:**

| LangSmith has | Gear Trace (desktop) |
|---|---|
| Run tree per invocation | **Session → Turn → Span** tree, live while the turn runs (not after) |
| Model-call spans with messages | Model spans show provider/model, the exact messages sent (system prompt, repo map, tool results), tokens in/out, latency, thinking time, **which provider actually served it** (fallback chain) |
| Tool spans with inputs/outputs | Tool spans show args, result, duration, exit code, **sandbox posture** (sandboxed/host/network), **freshness hash** for edits, and the diff |
| Sub-agent spans | Worker/task spans with ownership claims |
| Status/error | + **permission decisions** (who allowed, which gear, classifier verdict + risk), **checkpoints** (v1, v2 …, `/rewind`), **compaction** (what was summarized), **verification** (checks run, pass/fail) |
| Metadata/tags | + **policy in force** (org policy fingerprint, gear, sandbox on/off) |
| Inspect, filter, query | Inspect (click any span), filter by kind, **jump from an answer sentence to the evidence span** (evidence ledger), export the trace as signed JSON/HTML (session-export already hash-chains the audit log) |

The rail answers the three questions the user asked for: *for what answer → which tools → which system facts (prompt, policy, sandbox, model) were used.*

## 3. Desktop design contract (interactive half: `gear-desktop-v1.html`)

**Window**: one card-less canvas (the customizer's card becomes the window). Three regions, all resizable/collapsible:

```
┌ sidebar (260) ┬────────── transcript (flex) ──────────┬ trace rail (360) ┐
│ ⚙︎ Gear  v0.2  │ ⌄ task · turn 3 · checkpoint v2        │ TRACE · turn 3    │
│ + New task ⌘N │ ● Plan: …                              │ ▸ model call #1   │
│ Search ⌘K     │ ● Searching src/bin/ui/ · grep          │   ▸ grep 12ms     │
│ TODAY         │   └ $ grep -rn "renderStatus" …         │ ▸ model call #2   │
│ ● Wire the…   │ ● Editing status.ts · hash-guarded      │   ▸ edit_file     │
│ ○ Surface…    │   [diff card]                           │     ◆ permission  │
│ YESTERDAY     │ ● Verifying tests/unit/ · bash · sandbox│   ▸ bash 1.2s     │
│ ○ Tighten…    │ ✓ Complete. (11s · ↓6.1k · thought 2.3s)│ ▸ checkpoint v3   │
│               │ The footer now shows a live meter…      │ ▸ response        │
│ Review (2)    │ [✓ 214 tests pass] [✓ typecheck clean]  │ ────────────────  │
│ Settings ⌘,   │ ─────────────────────────────────────── │ inspector         │
│ sandbox on    │ › Give Gear a coding task…          ▌   │ (selected span)   │
│ MCP · 2       │ ▸▸ 2nd gear · ctx ▮▮▯▯▯ 41% · hints    │                   │
└───────────────┴─────────────────────────────────────────┴───────────────────┘
```

- **Sidebar**: brand lockup (gear mark + Gear + version), New task, search, day-grouped sessions (id chip · title · status pill · path · model · tokens), Review changes (count), Settings, environment badges (sandbox, MCP, gear).
- **Transcript**: exactly the v2 stream grammar (task bar with turn/checkpoint receipt, summary line, Plan bullet, tool bullets with cmd tree / diff cards, status ladder, permission card *inline* (never a modal), fallback card, compaction receipt, queued strip, headline+detail response, summary strips, composer with block cursor, footer with gear indicator + ctx meter + hints). Everything the CLI renders, the desktop renders the same way — same words, same tokens.
- **Trace rail**: the run tree for the selected turn (default: current). Rows: kind glyph · label · duration · tokens · status; nested children; the **inspector** below (or as a drawer) shows the selected span's full record (prompt messages, args, result, diff, permission record, policy). Filters: model / tools / permissions / checkpoints / errors. Footer: totals (turns · model calls · tools · tokens in/out · cost · wall time) and **Export trace**.
- **Evidence links**: hovering a sentence in a response highlights the spans it came from (v1: the turn's tool spans; v2: the evidence ledger binds claims to proof).
- **Overlays** (slash palette, /model tree, /theme): same overlay grammar as the customizer; keyboard-first (`/`, `⌘K`, `esc`, `shift+tab` shifts gear).
- **States**: thinking · running tools · waiting on approval (card inline, rail shows the pending span in ochre) · provider fallback · compaction · queued input · interrupted · denied · error · empty session.
- **Theme**: `apps/desktop/src/styles/tokens.css` generated from `packages/shared/src/design-tokens.ts` (`[data-theme-base][data-accent]`), five accents × light/dark, parity-tested against the customizer.
- **Motion**: the gear mark rotates while working (the CSS spinner from the contract); slideUp for new cards; nothing else.
- **Voice & honesty rules** (inherited from the CLI): posture from live state, tallies only from real output, never invented tokens/claims; every number on screen has a source span in the trace.

## 4. Trace data model

```ts
interface TraceSpan {
  id: string; turn: number; parentId?: string;
  kind: "model" | "tool" | "permission" | "checkpoint" | "fallback" | "compaction"
      | "verification" | "subagent" | "interject" | "error" | "response";
  label: string;              // "model call #2 · gemini-2.5-flash", "edit_file status.ts"
  startedAt: number; endedAt?: number; status: "running" | "ok" | "error" | "denied" | "skipped";
  tokens?: { in?: number; out?: number; thinkingMs?: number };
  provider?: { id: string; model: string; servedBy?: string };   // fallback-aware
  tool?: { name: string; args: unknown; result?: string; exitCode?: number; posture?: "sandboxed"|"host"|"network"; diff?: string; hashGuarded?: boolean };
  permission?: { decision: "allow_once"|"allow_session"|"deny"|"auto"; gear: string; classifier?: { risk: string; tier: string; reason?: string } };
  checkpoint?: { version: number; runId: string };
  policy?: { gear: string; sandbox: boolean; orgPolicy?: string };
  children: TraceSpan[];
}
```

**Event → span mapping** (engine-host forwards every engine event on the `chat_event` stream, so v1 needs no protocol change):

| engine event | span |
|---|---|
| `text_delta` (first of a turn after tools) | opens/extends the `response` span |
| `thinking_delta` | accumulates `tokens.thinkingMs` on the open model span |
| `tool_call_start` / `args_delta` / `tool_call_end` | `tool` span (running → ok/error) with args/result/duration; edit results carry the diff |
| `usage` | closes the open `model` span with in/out tokens + context % |
| `fallback` | `fallback` span + sets `provider.servedBy` on the next model span |
| `compaction` | `compaction` span (before/after %, summarized count) |
| `permission_request` stream + `respond_permission` | `permission` span (pending → decision) nested under the tool span |
| auto-approval notifier | `permission` span with `decision: "auto"` + classifier risk/tier |
| `checkpoint_saved` | `checkpoint` span |
| `verification_started/completed` | `verification` span |
| `todo_updated` / `plan_*` | plan state (not a span; shown in the stream) |
| `error` | `error` span |
| `turn_complete` | closes the turn, computes totals |

Model spans: the host does not yet stream the exact request messages; v1 shows what the engine reports (model, tokens, timing, fallback) and v2 adds a `get_turn_context` host call returning the prompt assembly (system prompt, repo map, tool results) for the inspector — that is an engine-host/protocol change (coordinate with the Phase-0 session).

## 5. Build plan (apps/desktop — Tauri 2 + React 19 + Vite; engine via the `engine-host` bun sidecar)

Reuse: Tauri shell + Rust bridge (`lib.rs`: spawn host, 1:1 commands, stream → webview events), `useEngine` (invoke/listen), `useSession`, `gear desktop build|dev` launcher, the existing `.dmg` pipeline (`bundle/dmg` exists from June).

Replace: `global.css` (Codex's ChatGPT-clone skin) → `tokens.css` + `desktop.css` (the contract's classes); `App.tsx` shell → sidebar · transcript · trace rail; `MessageStream`/`ToolCard` → stream components in the v2 grammar; `PermissionModal` → inline `PermissionCard`; `Settings` → gear/sandbox/theme/model panels in the overlay grammar.

New: `TraceRail` + `TraceInspector` + `useTrace` (event→span reducer), `StatusLadder`, `Footer` (gear · ctx · hints), `ModelTree` overlay (providers → accounts → models, `d` = default), `ThemePicker`, `QueueStrip`, `FallbackCard`, `CompactionReceipt`.

Milestones: **M1** tokens + shell + stream + trace rail fed by live events (dev mode) · **M2** inline permission card, fallback/compaction/queue, overlays, gears footer · **M3** inspector detail (prompt assembly via host call), evidence links, export · **M4** `.dmg` build, icon, first-run, auto-update later.

Out of scope for v1: collaboration, cloud sync, Windows/Linux packaging.

## 6. Open questions for the user
1. Trace rail default: open on every session, or open on demand (`⌘T`)? (Draft: open, collapsible.)
2. Keep the CLI in lock-step (same words/components) — yes by default; the contract is shared.
3. Should the desktop replace `gear` as the default `gear` command target, or stay `gear desktop`?
