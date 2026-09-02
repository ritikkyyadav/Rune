# Gear Desktop — research + design contract (v1 draft, 2026-08-21)

**Ask (user, 2026-08-21):** the terminal is not a good enough surface for a usable product. Build Gear as a proper desktop application (macOS `.dmg`) on the _same harness_, in the `gear-customizer-v2.html` visual language, where — like the traceable open-source harness the user has seen — every chain is traceable: for every answer you can see which prompts, tools, permissions and system facts produced it. Before designing, understand why Claude Code's output feels mature and compelling, and carry that into the desktop UX.

This document is the written half of the contract; `docs/design/gear-desktop-v1.html` (alongside `docs/design/gear-customizer-v2.html`) is the interactive half. The CLI keeps the v2 terminal contract already shipped (`e6fb08f`); the desktop is the primary surface going forward.

---

## 1. Research A — why Claude Code's output feels the way it does

Sources: [How Claude Code is built (Pragmatic Engineer)](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built) · [Claude's thinking words / spinner verbs](https://agnamihira.medium.com/claudes-thinking-words-the-hidden-personality-behind-the-spinner-verbs-ed21384ec8ec) · [Customizing spinner verbs](https://www.alexandrasamuel.com/ai/customize-claude-code-spinner-verbs) · [Inside Claude Code: architecture](https://tapti-sippy.medium.com/inside-claude-code-a-deep-dive-into-the-architecture-of-an-ai-powered-terminal-ae9f508d3cb3) · [There's a React app running in your terminal](https://levelup.gitconnected.com/theres-a-react-app-running-in-your-terminal-right-now-31a22d8da2f6) · first-hand (the Claude Code surface itself).

**Stated principles (Boris Cherny / Anthropic):**

- _"We want people to feel the model as raw as possible"_ — UI scaffolding is kept minimal because scaffolding limits the model.
- _"With every design decision we almost always pick the simplest possible option."_
- _"Every time there's a new model release, we delete a bunch of code"_ — the harness shrinks as the model improves; the UI never tries to be smarter than the model.
- The model drives; the client defines the UI, exposes tools and hooks, then _gets out of the way_.
- The hardest UX component was **permissions** (allow once / session / deny); the **todo list** went through 20+ prototypes before it felt right.
- The tone is deliberate: warm, playful-but-earnest spinner verbs ("Pondering", "Percolating") — personality as a product decision, not decoration.

**The mechanics that make it feel "it knows, and it shows it knows" (observed):**

| #   | Mechanic                                                                                                                 | Why it builds trust                                               | Gear status                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | **Intent before action.** A sentence of narration, _then_ the tool call. You always know what it is about to do and why. | Predictability. Nothing happens un-announced.                     | CLI v2: Plan bullet + tool bullets ✓ · Desktop: same stream                  |
| 2   | **Every action is a visible bullet with collapsed evidence** (`⏺ Read file (42 lines)`), expandable on demand.           | Full audit at a glance; depth when you want it.                   | CLI ✓ · Desktop: bullets + Trace rail                                        |
| 3   | **One honest status line**: spinner · verb · elapsed · tokens · `esc to interrupt`. Never a fake progress bar.           | Time and cost are never hidden; interrupt is always one key away. | CLI ✓ (`⚙︎ Running tools… (4s · ↓1.8k)`) · Desktop: status row + trace timing |
| 4   | **The permission prompt names exactly what will run**, with the exact command/diff, and offers once / session / deny.    | Consent is specific, not a vague "allow tool?".                   | CLI ✓ (rail card) · Desktop: inline card (no modal)                          |
| 5   | **An explicit task list** with ✓/›/○ that updates as work proceeds.                                                      | You see the plan and progress without asking.                     | CLI ✓ · Desktop: Plan in stream + sidebar progress                           |
| 6   | **Diffs are shown, not described.** Edits always render their hunk.                                                      | Evidence over claims.                                             | CLI ✓ · Desktop: diff cards + Review tab                                     |
| 7   | **Receipts at the end**: duration, tokens, files changed, checks that ran.                                               | Closure; you know what it cost and what changed.                  | CLI ✓ · Desktop: summary strips + Trace totals                               |
| 8   | **Errors stay inline and honest** (no pretending, no silent retries).                                                    | You trust the good news because the bad news shows up too.        | CLI ✓ (✕ / fallback card)                                                    |
| 9   | **Depth on demand** (ctrl+o / ctrl+r full transcript; verbose mode).                                                     | Default is calm; nothing is lost.                                 | CLI ✓ (ctrl+r) · Desktop: **Trace rail + inspector**                         |
| 10  | **Stable layout**: pinned composer, no jumping; 60 fps redraw; streaming text with a cursor.                             | Feels alive, never janky.                                         | CLI ✓ · Desktop: native                                                      |
| 11  | **One accent, calm typography, no chrome**.                                                                              | Attention goes to the work, not the UI.                           | Customizer tokens ✓                                                          |
| 12  | **Consistent voice**: the system and the model speak the same way; no "AI assistant" theatre.                            | Maturity.                                                         | doctrine + UI copy ✓                                                         |

**What other agents get wrong** (and the desktop must not): chat-bubble layouts that hide tools; modals that interrupt the stream; progress bars that lie; "done!" without evidence; hiding the command that is about to run; walls of raw JSON; personality as sticker-on-top rather than consistent voice.

## 2. Research B — the traceable harness (DeepAgents + LangSmith) and what Gear adopts

The user's "deep six harness" is, as far as the web shows, LangChain's **DeepAgents** — [the batteries-included agent harness](https://github.com/langchain-ai/deepagents) (planning, filesystem/shell tools, sub-agents, built on LangGraph). Its headline property is native **LangSmith tracing**: [every run is a tree](https://docs.langchain.com/langsmith/trace-deep-agents) — parent run → child spans for each model call, each tool run (inputs/outputs), each sub-agent (tagged `lc_agent_name`), with latency, status/error, metadata, a "messages" view and filtering. (Adjacent: [Arize's coding-agent tracing](https://arize.com/blog/open-source-coding-agent-tracing/) inspects prompts, tool calls, retries, token usage per step across Claude Code/Codex/Cursor.)

**What Gear adopts — and pushes further, because Gear owns the harness:**

| LangSmith has                  | Gear Trace (desktop)                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run tree per invocation        | **Session → Turn → Span** tree, live while the turn runs (not after)                                                                                                                                       |
| Model-call spans with messages | Model spans show provider/model, the exact messages sent (system prompt, repo map, tool results), tokens in/out, latency, thinking time, **which provider actually served it** (fallback chain)            |
| Tool spans with inputs/outputs | Tool spans show args, result, duration, exit code, **sandbox posture** (sandboxed/host/network), **freshness hash** for edits, and the diff                                                                |
| Sub-agent spans                | Worker/task spans with ownership claims                                                                                                                                                                    |
| Status/error                   | + **permission decisions** (who allowed, which gear, classifier verdict + risk), **checkpoints** (v1, v2 …, `/rewind`), **compaction** (what was summarized), **verification** (checks run, pass/fail)     |
| Metadata/tags                  | + **policy in force** (org policy fingerprint, gear, sandbox on/off)                                                                                                                                       |
| Inspect, filter, query         | Inspect (click any span), filter by kind, **jump from an answer sentence to the evidence span** (evidence ledger), export the trace as signed JSON/HTML (session-export already hash-chains the audit log) |

The rail answers the three questions the user asked for: _for what answer → which tools → which system facts (prompt, policy, sandbox, model) were used._

## 3. Desktop design contract (interactive half: `docs/design/gear-desktop-v1.html`)

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
- **Transcript**: exactly the v2 stream grammar (task bar with turn/checkpoint receipt, summary line, Plan bullet, tool bullets with cmd tree / diff cards, status ladder, permission card _inline_ (never a modal), fallback card, compaction receipt, queued strip, headline+detail response, summary strips, composer with block cursor, footer with gear indicator + ctx meter + hints). Everything the CLI renders, the desktop renders the same way — same words, same tokens.
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
  id: string;
  turn: number;
  parentId?: string;
  kind:
    | "model"
    | "tool"
    | "permission"
    | "checkpoint"
    | "fallback"
    | "compaction"
    | "verification"
    | "subagent"
    | "interject"
    | "error"
    | "response";
  label: string; // "model call #2 · gemini-2.5-flash", "edit_file status.ts"
  startedAt: number;
  endedAt?: number;
  status: "running" | "ok" | "error" | "denied" | "skipped";
  tokens?: { in?: number; out?: number; thinkingMs?: number };
  provider?: { id: string; model: string; servedBy?: string }; // fallback-aware
  tool?: {
    name: string;
    args: unknown;
    result?: string;
    exitCode?: number;
    posture?: "sandboxed" | "host" | "network";
    diff?: string;
    hashGuarded?: boolean;
  };
  permission?: {
    decision: "allow_once" | "allow_session" | "deny" | "auto";
    gear: string;
    classifier?: { risk: string; tier: string; reason?: string };
  };
  checkpoint?: { version: number; runId: string };
  policy?: { gear: string; sandbox: boolean; orgPolicy?: string };
  children: TraceSpan[];
}
```

**Event → span mapping** (engine-host forwards every engine event on the `chat_event` stream, so v1 needs no protocol change):

| engine event                                       | span                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `text_delta` (first of a turn after tools)         | opens/extends the `response` span                                                       |
| `thinking_delta`                                   | accumulates `tokens.thinkingMs` on the open model span                                  |
| `tool_call_start` / `args_delta` / `tool_call_end` | `tool` span (running → ok/error) with args/result/duration; edit results carry the diff |
| `usage`                                            | closes the open `model` span with in/out tokens + context %                             |
| `fallback`                                         | `fallback` span + sets `provider.servedBy` on the next model span                       |
| `compaction`                                       | `compaction` span (before/after %, summarized count)                                    |
| `permission_request` stream + `respond_permission` | `permission` span (pending → decision) nested under the tool span                       |
| auto-approval notifier                             | `permission` span with `decision: "auto"` + classifier risk/tier                        |
| `checkpoint_saved`                                 | `checkpoint` span                                                                       |
| `verification_started/completed`                   | `verification` span                                                                     |
| `todo_updated` / `plan_*`                          | plan state (not a span; shown in the stream)                                            |
| `error`                                            | `error` span                                                                            |
| `turn_complete`                                    | closes the turn, computes totals                                                        |

Model spans: the host does not yet stream the exact request messages; v1 shows what the engine reports (model, tokens, timing, fallback) and v2 adds a `get_turn_context` host call returning the prompt assembly (system prompt, repo map, tool results) for the inspector — that is an engine-host/protocol change (coordinate with the Phase-0 session).

## 5. Build plan (apps/desktop — Tauri 2 + React 19 + Vite; engine via the `engine-host` bun sidecar)

Reuse: Tauri shell + Rust bridge (`lib.rs`: spawn host, 1:1 commands, stream → webview events), `useEngine` (invoke/listen), `useSession`, `gear desktop build|dev` launcher, the existing `.dmg` pipeline (`bundle/dmg` exists from June).

Replace: `global.css` (Codex's ChatGPT-clone skin) → `tokens.css` + `desktop.css` (the contract's classes); `App.tsx` shell → sidebar · transcript · trace rail; `MessageStream`/`ToolCard` → stream components in the v2 grammar; `PermissionModal` → inline `PermissionCard`; `Settings` → gear/sandbox/theme/model panels in the overlay grammar.

New: `TraceRail` + `TraceInspector` + `useTrace` (event→span reducer), `StatusLadder`, `Footer` (gear · ctx · hints), `ModelTree` overlay (providers → accounts → models, `d` = default), `ThemePicker`, `QueueStrip`, `FallbackCard`, `CompactionReceipt`.

Milestones: **M1** tokens + shell + stream + trace rail fed by live events (dev mode) · **M2** inline permission card, fallback/compaction/queue, overlays, gears footer · **M3** inspector detail (prompt assembly via host call), evidence links, export · **M4** `.dmg` build, icon, first-run, auto-update later.

Out of scope for v1: collaboration, cloud sync, Windows/Linux packaging.

## 5b. Status (2026-08-21, end of day)

**M1 is built** in `apps/desktop` (React 19 + Vite + Tauri 2, the existing engine-host sidecar):

- `src/lib/stream.ts` — transcript reducer (v2 grammar: task bar, ledger, Plan bullet, tool bullets with cmd tree / diff card, status ladder, permission / fallback / compaction cards, headline + detail answer, summary strips); `src/lib/trace.ts` — trace reducer (run tree: model calls → tools → permissions, checkpoints, fallbacks, compactions, verification, narration/response; totals); both pure, tested in `tests/unit/desktop/stream-trace.test.ts` (11 tests).
- `src/hooks/useTurns.ts` (one event stream → both views), `src/hooks/useEngine.ts` (raw `chat_event` passthrough, inline `permission_request` → `respond_permission`, `interject_chat`, `switch_model`, `list_providers`, `save_settings` for gears), `src/hooks/useSession.ts` (sessions list + resume → replayed into the transcript).
- Components: `Titlebar`, `Sidebar` (day-grouped sessions), `Transcript`, `Composer` (block caret, slash palette, queue strip, gears footer with ctx meter), `TraceRail` (+ inspector, filters, totals, export-as-JSON), `Overlays` (model tree picker, theme picker, gear picker, toast), `GearMark`; `App.tsx` wires keyboard (⌘N/⌘K/⌘T/⌘B/⌘,/Shift+Tab/y·a·n/Esc), steering vs queueing, demo mode.
- Styling: `src/styles/tokens.css` (generated from `packages/shared/src/design-tokens.ts`) + `src/styles/desktop.css` (the contract's rules). `main.tsx` applies the persisted theme before first paint.
- Browser preview (`gear desktop dev`, no engine) offers **Run the demo turn** — the recorded reference turn replayed through the real reducers — so the UI can be reviewed without a model.

Not yet (M2–M4): Review workspace (the old `ReviewWorkspace`/`EnvironmentPanel` are kept but unwired), prompt-assembly inspector for model spans (needs a host call), evidence ledger linking answer sentences to spans (v1 highlights the tool a span belongs to), signed trace export, Settings/keys panel in-app (keys stay in the CLI `/keys`), first-run, auto-update.

## 6. Open questions for the user

1. Trace rail default: open on every session, or open on demand (`⌘T`)? (Draft: open, collapsible.)
2. Keep the CLI in lock-step (same words/components) — yes by default; the contract is shared.
3. Should the desktop replace `gear` as the default `gear` command target, or stay `gear desktop`?

---

## 7. Running it (Phase 3 · P3.1)

Between 2026-08-21 and Phase 3 the app built green and could not start. Three
things were missing and all three are closed here.

**`gear desktop`** (alias `gear app`) writes `~/.gear/desktop.json` — the file
`lib.rs` reads to find the engine, which nothing in the repository had ever
written — and then opens the app. It prefers an installed bundle
(`/Applications/Gear.app`, `~/Applications/Gear.app`, the checkout's own
`target/release/bundle`) and falls back to `tauri dev` in a checkout that has
never been packaged. `gear desktop dev` runs the Vite preview instead: no
engine, but the recorded demo turn replays through the real reducers.

**`gear desktop --check`** is the headless proof, for CI and for a machine with
no window server. It writes the pointer, spawns the same sidecar the app
spawns — or connects to a running `gear serve` when `GEAR_SERVE_URL` is set —
completes the `ready` → `hello` handshake, reports the protocol version and the
command count, and exits 0 or 1. It opens no window, so it says nothing about
rendering; what it proves is that the app's engine is reachable.

**One bridge command.** `lib.rs` used to mirror seventeen host commands by
hand. That pattern drifted twice: `interject_chat` was never added, so mid-turn
steering threw and the webview reported a lost connection; `save_settings` grew
a `persist` field the Rust signature did not have, so serde dropped it and gear
persistence was a silent no-op. Both are fixed by construction — the bridge is
now `engine_call(cmd, args)` plus one event pipe, and the types live in
`@gear/protocol` on both sides. The six `*_system_memory` commands, which no
webview code ever called, are gone; `engine_call` reaches them if a surface
ever wants one. `engine_health` is the one addition: it distinguishes "no
engine configured on this machine" from "the engine dropped", which used to
look identical.

**Two transports, one bundle.** `apps/desktop/src/lib/transport.ts` decides:
`GearClient` over a WebSocket when a server is configured (the endpoint `gear
web` embeds in the page, `?server=&token=`, or one saved in the browser),
otherwise the Tauri passthrough inside the app, otherwise nothing at all — the
browser preview, which says so rather than pretending. Everything above that
file talks to six methods and never learns which transport it got. The only
asymmetry is the round-trips: the sidecar streams `{requestId, prompt}` and the
client answers by name, while the SDK holds a promise and answers for you, so
ws mode mints a local id and both present the same `(id, payload)` shape
upward.

---

## 8. One design system (Phase 3 · P3.3)

Three visual identities existed in this repository at once: the customizer's
five accents × two bases (ported into `bin/ui/themes.ts`), the desktop's own
2,074 lines of CSS, and the Savoir rebrand. A product cannot have three. Under
D2 the Savoir brand DNA is the one, and everything below derives from
`packages/shared/src/design-tokens.ts`.

**The palette.** Paper `#E7E8E3` and ink `#14161A` are the two grounds — cool
drafting paper, explicitly not cream. Graphite `#4A4F55` and `#7C8088` carry
secondary and tertiary text. Hairlines are `#C7CABF` on paper and `#2C3036` on
ink. There is ONE chromatic hue: the datum `#0E5E63`, which becomes the signal
`#17A0A8` on ink. Caution `#E2A23A` and negative `#9A4A3A` are status colours —
they signal state and never decorate.

**There is no green.** A green for "added lines" would be a second brand colour
arriving through the back door of a diff. An addition is a datum: the thing
that is now there. The on-ink negative is the brand's own brick lifted 30%
toward paper, because `#9A4A3A` is 2.2:1 on ink — fine as a rule, unreadable as
a word — and deriving it means changing `--negative` moves both.

**The rules, enforced rather than described.** Zero `box-shadow`: depth is a 1px
hairline. Every radius is 3px, with a pill and the 6px icon tile as the only
exceptions. Inter for voice, IBM Plex Mono for the record — labels, metadata,
paths, commands, diffs and every figure, with tabular numerals. Mono labels are
uppercase, 11px, tracked `+.04em`. A 28px graticule sits behind everything.
`tests/unit/shared/design-tokens-parity.test.ts` pins the values and the rules;
`tests/unit/brand-checklist.test.ts` re-checks the BUILT stylesheet, because a
shadow can arrive through a component or a dependency without ever touching a
token.

**Two generators, one source.** `scripts/generate-tokens-css.ts` emits
`tokens.css` for the desktop and the web client (the same bundle).
`scripts/generate-terminal-colors.ts` prints the TUI's table — exact 24-bit RGB
plus the ANSI-256 index a terminal without truecolor is given instead. It
prints rather than writes: `bin/ui/themes.ts` already derives from the token
module, and a second checked-in copy would be a third place to drift. What it
gives you is a reviewable form — swatches in a terminal, not a diff of hexes.

**The picker is gone.** Light, dark, auto, on both surfaces. `[data-accent]`
survives with one value as the undocumented `[ui] accent` override, because a
seam that says "this was a choice, and the choice is one" is more honest than
deleting it. Every retired accent id still resolves: `gear-violet-dark` in
`~/.gear/theme.json` opens the dark mode rather than erroring, and so does
`flow`, the dark palette that used to be the default.

**The mark, pending D2.** The founder has not supplied a Gear mark or ruled on
"Gear" versus "Savoir Gear". Until then the mark is the word, set in the Savoir
lockup construction: bold tight-tracked sans terminated by the block cursor, a
true rectangle sized in `em` so the proportion cannot drift. The nine-tooth cog
survives only as the working indicator — a spinning gear is a state, and the
brand does not spin.

---

## 9. M2–M4 (Phase 3 · P3.4)

Everything added here obeys one rule from §3: the agent stops for you INSIDE the
stream, never over it. A modal takes the transcript away at the moment you most
need to read it, and the browser smoke asserts that no `[role=dialog]` is on
screen while a permission card is up.

**The round-trips, all of them.** The permission card was already inline. The
`ask_user` card and the read-back card are new to this surface, and until Phase
2 they could not exist — the host wired one of five, so `ask_user` answered "No
interactive user is available" for every desktop run. Both say what happens if
nobody answers, because the host's unattended policy is stated in
`docs/protocol.md` and a card that hides it is inviting a surprise.

**Held steps, with exact-grant semantics.** The panel is the desktop half of
Auto's contract: an outward step it declined to take unattended is recorded, and
approving one runs EXACTLY that call — the host holds the arguments and the
client sends an id, so nothing broader is granted and raw arguments never cross
the wire. Keys are the terminal's: `Enter` runs the selection, a digit picks and
runs, `s` leaves one, `Esc` closes and leaves the rest in the ledger. The state
machine is ported from `bin/ui/held.ts` and tested in the same shape, so the two
surfaces cannot drift on what a key means.

**Auto chips carry their authority.** Each chip names the tool, the containment
kind, and the classifier's risk and tier. "Approved automatically" with nothing
after it is not a statement anyone can audit.

**The fleet reads events, not prose.** One row per sub-agent in DISPATCH order —
arrival order is whichever worker happened to speak first, which makes the panel
reorder itself while you read it. The reducer consumes `tool_progress.child`,
the typed child event P2.6 added, so a worker's retries, checks and handoffs are
events here rather than a parsed heartbeat. A silent child event keeps the row's
last real line rather than overwriting it with a shrug.

**The inspector answers the actual question.** `get_turn_context` is a new host
command backed by `Engine.getTurnContext()`: the EXACT system prompt that was
sent, with its pieces named — doctrine, environment, project memory, system
memory, notebook, skills — and whether a repo map was admitted. Characters, not
tokens, and it says so: the provider reports tokens exactly in `usage`, and a
tokenizer here would be a second estimate of a known number. `null` before the
session has run a turn, rendered as "no turn yet" rather than as an empty
assembly pretending to be real.

**Export is signed, and is the same artifact.** `export_trace` calls
`session-export.ts` — the exporter `gear export --sign` uses — so a trace
exported from the desktop verifies with the same key as one exported from the
terminal. What it replaces was a client-side JSON dump of the rail: a picture of
the screen, verifiable by nobody who was not watching it.

**Settings own the keys.** The provider list shows auth status and where each
credential came from, and a key can be pasted and is written to
`~/.gear/secrets.json` at 0600 and applied live. The OAuth half is honest rather
than complete: the flow is `gear login`, which opens a browser and catches a
loopback redirect, and the panel prints that exact command for the providers
that need it instead of offering a button that does nothing. Moving it in-app is
one host command away and is logged in `docs/program/backlog.md`.

**First run.** Three steps, no tour: connect a model, confirm the folder, give
it a task — with "replay a recorded turn" for someone who has not connected
anything yet. Copy in the Savoir voice: declarative, specific, and it names what
Gear declines (no cloud, no account) because a boundary reads as confidence.
