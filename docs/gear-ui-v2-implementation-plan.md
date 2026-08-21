# Gear UI v2 — Implementation Plan

**Contract:** `docs/design/gear-customizer-v2.html` · **Repo state audited:** 2026-08-20 · **Target:** Gear v0.2.x → v0.3.0

The customizer HTML is already treated as the product contract — `packages/orchestrator/src/bin/ui/themes.ts` says so explicitly and ports its exact pigments. This plan upgrades that contract to v2 and closes the gap on two surfaces, in order: the terminal TUI first (primary product surface), the Tauri desktop app second. It is a gap-closure plan, not a greenfield build: the audit below shows most of the v1 mockup already exists in the TUI.

---

## 1. What the v2 contract adds over v1

| Change | Why |
|---|---|
| Content aligned to real v0.2.0 | Real slash commands, real autonomy ladder (Confirm → I → II → III → Auto), real providers/models (Gemini 2.5 Flash default, OpenRouter free, Ollama local), real paths (`~/Projects/Alan`), real theme ids (`gear`, `gear-<accent>[-dark]`). The prototype now doubles as a spec. |
| Permission card | Command preview, risk row (workspace writes / egress / runtime / rate-limit), `y` allow once · `a` allow for session · `n` deny, audit-trail note. |
| Auto-review chip | Classifier-approved action inline chip (Auto mode): two-stage reviewer, injection probe, audit log. |
| Provider-fallback banner | Gateway 429 → retry/backoff → fallback chain, "turn continues, nothing lost". |
| Context meter + compaction | Footer meter (normal / warn ≥70% / hot ≥90%) and an inline compaction event (82% → 51%, −31k tokens). |
| Queued input | Messages typed mid-turn queue and drain in order when the turn completes. |
| Interrupted / denied end-states | Esc interrupt keeps checkpoint; deny produces an honest "stopped before shell" response. |
| Turn metadata | Task bar shows turn number + checkpoint id; summary strip advertises `/rewind`. |
| Mechanics | Single `<symbol>` gear icon (was 3 inline copies), working block cursor (mirror overlay — `caret-shape` is unsupported in Chromium), live-filtered palette, sessions tabs (Active/Archived) + empty state + day grouping, OS-scheme detection, reduced-motion + focus-visible + aria-live, responsive ≤720px. |
| States menu (`?`) | Design-review injector for every state. Prototype-only — **not** a product surface. |

## 2. Current-state audit (what already exists)

**Terminal TUI** — `packages/orchestrator/src/bin/` (alan-cli.ts ~3.1k lines + `ui/` ~9.5k lines):

| Area | File(s) | Status vs v2 |
|---|---|---|
| Themes: 5 accents × light/dark, ids `gear[-accent][-dark]` | `ui/themes.ts` (709), `ui/theme.ts`, `ui/theme-store.ts` | **Done** — pigments already copied from v1 HTML; OSC terminal recolour works |
| Pinned composer (default), `--classic` fallback | `ui/composer.ts` (961), `ui/tui.ts` (3,654) | Done |
| Slash palette with live filter + selection | `ui/tui.ts` (slashSel), `ui/composer.ts` | Done — copy/tags need sync with v2 list |
| Sessions manager: search, active/archived, two-step delete | `ui/tui.ts` (sessions mode) | Done — day-grouped timeline + checkpoint metadata are gaps |
| Permission cards | `ui/permission-preview.ts` (412), `permissions.ts` | Partial — risk row + key hints per v2 spec |
| Turn stream: plan/tool/diff rendering | `ui/turn.ts` (907), `ui/workspace-diff.ts`, `bin/diff-render.ts` | Done — summary-strip additions are gaps |
| Spinner / status | `bin/spinner.ts`, `ui/status.ts` (107), `ui/activity.ts` | Partial — state-ladder copy + ctx meter are gaps |
| Fallback events | `@alan/llm-gateway` emits internally | **Not surfaced in UI** |
| Context meter / compaction indicator | `context-engine.ts` has the budget | **Not surfaced in UI** |
| Queued input | composer queue behavior | Verify; render strip if missing |

**Desktop** — `apps/desktop` (React 19 + Tauri 2 + Vite; ~5.9k lines): 13 components incl. Composer (263), MessageStream (325), PermissionModal (251), SessionList (153), Settings (640), ToolCard (252), DiffViewer, PlanPane, ReviewWorkspace, EnvironmentPanel; `styles/global.css` (2,427) with hand-written values; engine IPC via `bin/engine-host.ts` (669) + `host-client.ts`. No token pipeline, no gear theme parity.

## 3. Phase 0 — One token source (est. 1–2 days)

The pigments currently live in three places by hand: the HTML, `themes.ts`, and `global.css`. That is drift waiting to happen.

1. Add `packages/shared/src/design-tokens.ts`: bases (light/dark), 5 accents, semantic slots (text-main/sub/muted/faint, bar, hairline, code, diff, green/red/ochre + bgs, accent + glow/bg/bd), spacing/type scale constants. Pure data, no deps.
2. Generators: (a) `themes.ts` builds its 10 `gear*` themes from the tokens instead of literals; (b) a small script emits `apps/desktop/src/styles/tokens.css` (CSS custom properties per `[data-theme-base][data-accent]`, same attribute API as the prototype).
3. Parity test in `tests/unit/`: tokens ↔ the hex values in `docs/design/gear-customizer-v2.html` (regex-extract), so the contract can't silently diverge again.

**Acceptance:** one edit to a pigment propagates to CLI + desktop + test; `bun run typecheck` and unit suite green.

## 4. Phase 1 — Terminal TUI gap closure (est. 8–12 working days)

Terminal reality first: no shadows, waves, or block-cursor emulation — the terminal's native cursor and the theme system already carry the identity. Tokens map through `ui/terminal-colors.ts` to 24-bit ANSI with the existing 256-color fallback. The `--classic` readline path must keep working untouched.

| # | Work item | Files | Size | Acceptance |
|---|---|---|---|---|
| T1 | Status ladder copy parity: Thinking… / Running tools… / Waiting on approval… (ochre) / Synthesizing… / ✓ Complete / Interrupted, with `(Ns · ↓ tokens · thought for …)` meta | `ui/status.ts`, `ui/activity.ts`, `ui/turn.ts` | S | Each engine phase renders the v2 label + color; snapshot test on stripped-ANSI output |
| T2 | Context meter in footer + compaction event line: `ctx ▮▮▮ 41%`, warn ≥70, hot ≥90; on compaction print `⟲ compacting … 82% → 51% · −31k tokens` | `context-engine.ts` (expose budget event), `ui/events.ts`, `ui/tui.ts` footer | M | Meter tracks real budget in a long session; compaction line appears exactly once per compaction |
| T3 | Provider-fallback surfaced: banner on 429/timeout with chain + backoff + resumed-on line; per-tool-call fallback badge | `@alan/llm-gateway` (emit typed event), `ui/turn.ts`, `ui/events.ts` | M | Kill a provider key mid-turn → banner renders, turn completes on fallback; unit test with mock gateway |
| T4 | Permission card parity: command block, risk row (workspace writes / egress / est. runtime / per-tool rate-limit count), `y`/`a`/`n` keys, audit-trail footnote; Auto mode renders the ⛨ auto-approved chip instead | `ui/permission-preview.ts`, `permissions.ts` (expose risk facts — mostly already computed) | M | All three keys work; denied shell yields the honest "stopped before…" response, not a fake success |
| T5 | Queued-input strip: verify composer queue; render `QUEUED · sends when this turn completes` list with remove; drain in order | `ui/composer.ts`, `ui/tui.ts` | S–M | Two messages typed mid-turn run sequentially after completion |
| T6 | Model picker parity: provider tag + `free`/`local` badges from the registry, current marker, gateway-fallback footnote | `ui/tui.ts` picker, `provider-registry.ts` | S | `/model` shows live registry with tags; selection updates header line |
| T7 | Sessions manager polish: day-grouped timeline (Today / Yesterday / Past 7 days), checkpoint + token metadata per row, Active/Archived tabs (exists — align visuals), empty-search state | `ui/tui.ts` sessions mode, `@alan/shared` sessions | M | Grouping correct across midnight; search + tabs compose; two-step delete unchanged |
| T8 | Turn summary strip: files changed, +/−, checkpoint id, `/rewind to undo` hint; task bar gains `turn N · checkpoint <id>` | `ui/turn.ts`, `git-undo.ts` / checkpoints in `@alan/shared` | S | Strip renders from real checkpoint data after every applied edit |

Test approach: extend the existing `bun test tests/unit/` snapshot style — render to string, strip ANSI, assert structure. No new frameworks.

## 5. Phase 2 — Desktop parity (est. 10–15 working days)

The v2 HTML maps almost 1:1 onto the existing component set; this phase is a re-skin plus four new components, not a rewrite.

| v2 element | Existing component | Work |
|---|---|---|
| Card / header / task bar | `App.tsx` shell | Re-skin from `tokens.css`; add turn/checkpoint metadata |
| Stream (plan, tool, diff, response) | `MessageStream`, `ToolCard`, `DiffViewer` | Re-skin; add summary strip |
| Permission card | `PermissionModal` | Convert modal → inline card per v2; risk row; y/a/n |
| Composer + palette | `Composer` | Live-filtered palette from the shared command list; queued strip |
| Sessions view | `SessionList` | Tabs, day grouping, search, empty state |
| Theme switcher | `Settings` | 10 gear ids shared with CLI config (`~/.alan/config.toml`) |
| Fallback banner / ctx meter / compaction / auto-chip | — new | Small components fed by engine-host events |

Wiring: the engine already streams events through `bin/engine-host.ts` → `host-client.ts`; extend the shared protocol in `@alan/shared` with the Phase-1 event types (fallback, budget, compaction, queue) so both surfaces consume the same stream. Keyboard parity (Esc, Shift+Tab, `/`, ←) via one key-map module. Waves/shadows/block caret DO apply here — lift them from the prototype directly.

**Acceptance:** side-by-side with the prototype in both bases × 5 accents shows no visual drift; all Phase-1 states reproducible against a live engine; `bun run typecheck` green; Tauri build passes on macOS.

## 6. Sequencing, effort, realism

| Phase | Est. (solo, focused) | Calendar (solo, alongside other work) |
|---|---|---|
| 0 — tokens | 1–2 d | ~0.5 wk |
| 1 — TUI | 8–12 d | 2–3 wk |
| 2 — desktop | 10–15 d | 3–4 wk |
| **Total** | **19–29 d** | **~6–8 wk** |

Realistic read: this is 4–6 weeks of full-time solo work; as a side-stream it is a quarter. If time-boxed, cut from the bottom — Phase 2 whole, then T7. Do not cut Phase 0: it is the cheapest item and the only thing preventing three-way drift. Nothing here blocks engine work; every item is presentation-layer plus typed events.

Not now / later: MCP-server wrapper UI (no surface yet), research-mode UI redesign (separate contract — current `ui/research.ts` stays), onboarding/first-run, web surface. In a 2-year frame, the token pipeline is also what makes a web or VS Code surface cheap; the ladder/permission/fallback vocabulary is the durable part, the pigments are not.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Token drift returns | Phase 0 parity test fails CI on any divergence |
| Terminal variance (Apple Terminal 256-color, no OSC recolour) | Existing fallback in `terminal-colors.ts`; test matrix: iTerm2, Ghostty, Apple Terminal, VS Code term |
| TUI regressions in a 3.6k-line `tui.ts` | Snapshot tests per work item before refactor; `--classic` path as escape hatch |
| Desktop IPC drift | Event types live once in `@alan/shared` protocol |
| Prototype scope creep (States menu, waves in TUI) | States menu is explicitly design-review-only; terminal identity = themes + typography, nothing else |
| Fake-success on denied shell | T4 acceptance explicitly requires the honest denied response |

## 8. Done means

All Phase-1 acceptance rows pass on a live session; pigment edit propagates in one place; both surfaces render the five accents in both bases from shared tokens; permission, fallback, compaction, queue, and interrupt states are all reachable in the real product — not only in the prototype.
