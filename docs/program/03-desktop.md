# Phase 3 — The flagship surface

> **Superseded in part (2026-09-02).** The native Tauri shell and the Savoir tokens are replaced by [09-web-product.md](09-web-product.md); the web serving, transport seam, reducers and components built here carry forward.

**Lane B · 15–20 days · needs Phase 2**

## Goal

Gear Desktop is the thing people download. The same UI runs in a browser as `gear web`. Both consume `@gear/protocol`. One visual identity, derived from the Savoir brand DNA, covers desktop, web and terminal. The terminal is frozen as the console.

## Evidence (2026-09-02)

- `apps/desktop`: Tauri 2 + React 19 + Vite, 8,386 lines TS/TSX/CSS + 451 Rust, builds green in 367 ms, `tsc` clean, 11/11 tests, CI job `ci.yml:176-197`. Bundle id `com.savoirstudio.gear`. Last real desktop commit `d3509eb` 2026-08-21 (M1 of the design contract in `docs/gear-desktop-design.md`); nothing desktop-specific since.
- The expensive parts are reusable: `src/lib/stream.ts` (892) and `src/lib/trace.ts` (633) are pure reducers from events to transcript turns and a span tree; `TraceRail.tsx` (449) is the surface no rival has; `useEngine.ts` isolates every Tauri touchpoint behind `isTauriRuntime()`; `src/lib/demo.ts` replays a recorded turn without an engine.
- Defects, all verified: `interject_chat` is implemented in the host (`engine-host.ts:441`) and called by `useEngine.ts` but absent from `lib.rs`'s `invoke_handler!`, so mid-turn steering throws and fakes a connection error. `persist` is passed by `useEngine.setGear` and dropped by the Rust `save_settings` signature, so gear persistence is a permanent no-op. Four live events (`retry`, `tool_progress`, `step_check`, `handoff`) fall through `stream.ts:869` and vanish; five declared `plan_*` events are never emitted. Six Rust commands (`*_system_memory`) are never called. `lib.rs` reads `~/.gear/desktop.json` to find the engine; nothing writes it; there is no `gear desktop` subcommand; this machine's file points at a path that does not exist.
- The Rust bridge is a hand-typed 1:1 mirror of 17 host commands. It has drifted twice in the two ways this pattern always drifts (a missing command, a dropped field), invisible to CI because nothing type-checks across the seam.
- Three visual identities exist: `docs/design/gear-customizer-v2.html` (five accents × two bases, ported into `bin/ui/themes.ts`), `apps/desktop/src/styles/desktop.css` (2,074 hand-written lines) + generated `tokens.css`, and the Savoir rebrand. `packages/shared/src/design-tokens.ts` + `scripts/generate-tokens-css.ts` already form a one-source token pipeline; the parity test binds it to the customizer HTML.
- The terminal has been through ten UI programs (v2 contract, fixed chrome, chambers and folds, transcript overhaul, one grammar, held-step surface, fleet panel, turn collapse, read-back) and the founder still reads it as "stuck in between." That is a medium ceiling, not a polish gap.
- Release assets do not include the desktop (`README.md:120-122`, "developer preview").

## Work items

### P3.1 Revive (2 days)

- `gear desktop` (and `gear app` alias) subcommand: writes `~/.gear/desktop.json` with the resolved engine path and launches the app; `gear desktop dev` for the Vite preview.
- Collapse `lib.rs`'s 17 commands into one `engine_call(cmd: String, args: Value) -> Value` passthrough and one event pipe. Keep spawn, `resolve_host()` with `~/.alan` back-compat, the reader loop and pending-map correlation. Delete the six dead memory commands. `interject_chat` and `persist` are fixed by construction.
- The app also connects to a running `gear serve` over WS (P2.4) when `GEAR_SERVE_URL` or a saved server is configured; the transport is chosen in `useEngine`, nothing else changes.
- `stream.ts`/`trace.ts` cover all 22 events (the exhaustiveness test from P2.1 enforces it); drop the dead `plan_*` cases.

### P3.2 `gear web` (1.5 days)

`gear serve --web` (or `gear web`) serves the Vite bundle from the same process with the token embedded in the first page load; `useEngine` uses WS when not in Tauri. Works from a phone on the LAN with `--host`. Playwright smoke in CI.

### P3.3 One design system (3 days, needs D2)

- Replace the token source: `packages/shared/src/design-tokens.ts` derives from the Savoir DNA. Ground `#E7E8E3` paper / `#14161A` ink; one accent, the datum `#0E5E63` (light) and signal `#17A0A8` (on ink); status amber `#E2A23A` and brick `#9a4a3a` for state only; hairlines `#C7CABF` / `#2c3036`; radius 3px; Inter (Söhne if licensed) for voice, IBM Plex Mono (Berkeley Mono if licensed) for labels, metadata and all data; uppercase tracked mono labels; tabular numerals; 28px graticule ground; no shadows anywhere.
- Generators: `tokens.css` for desktop/web; `bin/ui/terminal-colors.ts` for the TUI (24-bit + 256 fallback). Light and dark are the two states; the five-accent picker is removed from both surfaces (keep a hidden `[ui] accent` override for the customizer's sake). `/theme` becomes `light | dark | auto`.
- Parity test rebinds to the Savoir tokens; add a brand checklist test on the built CSS: zero `box-shadow`, one chromatic hue outside status colors, all radii 3px except pills and the icon tile.
- Wordmark and product mark per D2. Until then the app titlebar sets "Gear" in the Savoir lockup construction.

### P3.4 Finish the design contract, M2–M4 (5–6 days)

From `docs/gear-desktop-design.md` §3–§5 and the desktop reducers already in place:

- Inline permission card (never a modal), ask_user card, brief/mission card, held-steps panel with exact-grant semantics (`held.ts` logic ported, keys `Enter`/digit/`s`/`Esc`), auto-approval chips with classifier source and risk, fallback banner, compaction receipt, context meter, queued-input strip.
- Fleet view from real child events (P2.6): one row per sub-agent, `queued/running/done/failed`, dispatch order.
- Model tree overlay with provider auth status (from `list_providers`), `d` for default; settings panel that owns keys and OAuth through the credential store (move `/keys` and `gear login` flows into the app: OAuth for Anthropic/Codex/OpenRouter, device flow for Copilot, key paste).
- Inspector: prompt assembly for model spans via a `get_turn_context` host command (system prompt, repo map, tool results, tokens); evidence links from answer sentences to spans (v1: the turn's spans); signed trace export (reuse `session-export.ts`).
- First run: connect a provider in under two minutes, pick a folder, run the demo turn, then a real prompt. Copy in the Savoir voice.

### P3.5 Workspace (2 days)

Review tab: `git diff` of the run with per-file accept/revert (hooks into `git-undo.ts` paths only); file tree; "open in editor"; a "run checks" button that invokes the verifier and shows the result as evidence.

### P3.6 Packaging and updater (2–3 days)

- CI matrix builds: macOS `.dmg` (arm64 + x64, signed and notarized), Windows `.msi` (signed if a certificate exists), Linux `.AppImage` + `.deb`. Sidecar = the compiled `gear` binary running `serve` (no Bun on the user's machine). `tauri-plugin-updater` with a signed manifest published by `release.yml`. Bundle target under 30 MB.
- Download page copy per D2 story; the README leads with the desktop for non-terminal users and the one-liner for terminal users.

### P3.7 The console (1 day)

Declare the terminal contract frozen: no new panels, no new dialects; the transcript, composer, held-steps panel, fleet rows and footer are the whole surface. Delete the accent picker. Where cheap, route the TUI through the same transcript reducer as web (stretch). `ui-grammar.test.ts` stays the enforcement.

## Gate

```bash
bun run --cwd apps/desktop build && bun test tests/unit/desktop tests/unit/brand-checklist.test.ts
gear desktop            # launches on this machine, connects, runs the demo turn
gear web --port 7788    # Playwright: first-run → connect mock provider → prompt → permission card → answer → trace rail shows spans → export
# on macOS, Windows, Linux (Linux via gear web is acceptable for v0.4.0):
#   the first-time-user script: install → connect a provider → run a task in a sample repo → approve a held step → read the trace → export
grep -c "box-shadow" apps/desktop/dist/assets/*.css      # 0
```

Done means: a person who has never opened a terminal can install Gear, connect the model they already pay for, run a task, decide a held step, and see exactly why the answer is what it is.
