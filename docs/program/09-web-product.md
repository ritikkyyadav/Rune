# Phase 9 — The web product

> **Withdrawn 2026-09-03.** The founder decided the product is the terminal interface only, and the
> web app was removed the same day (`apps/web`, the embedded bundle, `rune web`, `rune open`, the
> VS Code webview, the Playwright suite). This file is kept as the record of what was built and why;
> nothing in it describes the product.

**One agent · after all program PRs are merged · supersedes the native-desktop parts of Phase 3**

## Correction that created this phase

The founder, 2026-09-02, after reviewing Phase 3: the native desktop app is not the product. The product is **one URL-based web application** that runs identically on Linux, Windows and macOS, served locally by the engine and opened in the browser, in the model of Claude Science (`localhost:8765/projects/<id>`). One universal product to maintain. The CLI is not the product interface; it stays a console for SSH and CI. The Savoir visual system applied in Phase 3.3 is the **old** Savoir identity, ditched long ago; it must be replaced by the current identity: a solid electric-blue eight-tooth rune on a near-white ground.

What Phase 3 built that survives: `rune serve --web` (the engine serving the React bundle with the token embedded), the transport seam in `apps/desktop/src/lib/transport.ts`, the stream and trace reducers, every card and panel component, the Playwright smoke, `rune desktop --check`'s headless handshake. What goes: the Tauri shell as the product, the Savoir tokens, the "desktop" name.

## Goal

A person on any OS installs Rune, types `rune`, and a browser tab opens on a local URL where they run sessions for hours without wanting to close it. The interface reads as built ahead of its time: modern, minimal, quiet, precise. Nothing chunky, nothing decorative, nothing that shouts.

## Structure (reference: the Claude Science screenshot, structure only, not visuals)

- **Left sidebar, 264px, collapsible.** Top: workspace switcher (the current project folder, chevron; switch or open another folder). Items: New session (⌘N), Search (⌘K), Files, Connect (connectors and providers), Settings. Below: sessions grouped by Today / Yesterday / Past 7 days / month, each row title + short id + status dot. Bottom: gear indicator (1st–4th, Auto), cost today, version.
- **Main column.** A reading column, max 760px, centered. Tabs at the top of a session: Session · Files · Review. The transcript is the existing stream grammar rendered in the new system: user turns as plain blocks, assistant text as prose, tool bursts collapsed to one quiet line expandable in place, diffs as banded hunks, checks as evidence lines, permission and held-step decisions as inline cards that never modal.
- **Composer, pinned bottom.** One rounded field, 44px minimum, grows to 8 lines; left: attach; right: model picker (provider + model, auth status), gear picker, send. Slash palette on `/`. Draft persists per session.
- **Trace rail, ⌘T.** Off by default; slides in on the right; the existing span tree and inspector.
- **Empty state.** Calm: the mark, "No sessions yet", one sentence, the composer ready.

## Visual system (new identity)

- **Mark.** The attached logo: an eight-tooth gear, rounded tooth tips, round centre hole, solid accent blue. Recreate as SVG in `apps/web/branding/rune-mark.svg` (path generated from geometry: outer radius 1.0, root radius 0.80, hole radius 0.36, tooth width at tip 0.30 of pitch, corner radius 0.06) and use it for favicon, sidebar mark, empty state, and the app icon. If the founder supplies the original vector, replace the recreation byte-for-byte and keep the file name.
- **Color.** One accent, the logo blue: light `--accent: #1B3FE4`, dark `--accent: #5B79FF`; hover/pressed one step darker or lighter; accent covers under 5% of any screen: the mark, the primary button, focus rings, the live/streaming indicator, selected-row rail. Ground light `#FAFAF8`, surface `#FFFFFF`, sunk `#F3F3F1`; ink `#111318`, secondary `#5B6070`, tertiary `#8B909C`; hairline `#E6E6E2`. Dark: ground `#0F1114`, surface `#15181D`, sunk `#0B0D10`, text `#E8E9EC` / `#A2A7B3` / `#6C717D`, hairline `#232730`. Status only: success `#1F9D55`, caution `#C98A1A`, danger `#D2453B`. These are sampled from the logo; replace with the brand's exact values if the founder supplies them, keeping the roles.
- **Type.** Geist (Google Fonts) for UI and prose, Geist Mono for code, paths, ids and figures; fallbacks Inter / ui-monospace. Body 15px / 1.55, prose in the transcript 15.5px, labels 12px with +0.02em tracking, no uppercase shouting. Tabular numerals everywhere numbers align.
- **Shape and depth.** Radius 8px for fields and cards, 6px for chips, 10px for the composer. Depth by 1px hairlines and one level of surface tint; a single soft shadow only on floating overlays (palette, menus). Never a shadow on content.
- **Motion.** 160ms ease-out for state changes, 220ms for panels; a calm streaming caret; no bounces, no entrance choreography; `prefers-reduced-motion` honored.
- **Density.** 8px grid; generous but not empty; the reading column breathes; nothing blinks; no badges counting things nobody asked about.
- **Icons.** Lucide, 16px, 1.5px stroke, monochrome.
- **Feel checklist.** Someone can read it for two hours: contrast is high but not harsh (ink is not pure black, ground is not pure white), the accent never carries text, line lengths stay under 80 characters, the only motion is the work happening.

## Work items

**P9.1 Rename and remove.** `apps/desktop` → `apps/web` (package `@rune/web`); delete `src-tauri`, the Tauri dependencies, `rune desktop`/`rune app` and the desktop CI and release jobs; keep the transport seam with a single WebSocket transport; keep the Playwright smoke. `docs/program/03-desktop.md` gets a superseded note pointing here; `docs/release-desktop.md` is removed; README's desktop section becomes the web section.

**P9.2 The entry.** `rune` with no arguments starts `rune serve --web` if not running and opens the browser on `http://127.0.0.1:<port>/` with the token in the URL fragment; `rune --console` (or `rune tui`) starts the terminal console instead; `rune open` opens the tab again. The port is stable per user (`~/.rune/serve.json`), the page reconnects on server restart, and one server hosts many sessions and many workspaces. Windows: same, via `start`. Linux: `xdg-open`.

**P9.3 Tokens and mark.** Replace `packages/shared/src/design-tokens.ts` with the system above (light + dark); `tokens.css` regenerated; the terminal console maps the same tokens (accent and status only); the brand-checklist test rebound: one accent hue, no content shadows, radii from the set, fonts from the set. Add the SVG mark and derive favicon.ico, apple-touch-icon and a 1024px PNG.

**P9.4 The shell.** Sidebar, workspace switcher, day-grouped sessions, search palette (⌘K: sessions, files, commands), Files tab (tree + preview), Connect (providers with `rune login` flows in-page where the OAuth loopback allows, connectors from `rune mcp` with status), Settings (rune defaults, theme light/dark/system, model defaults, telemetry). Keyboard-first throughout.

**P9.5 The session.** Rework every existing card and the transcript typography into the new system; the composer with model and rune pickers; inline permission, ask_user, brief and held-step cards; the plan ledger as a quiet checklist at the top of the session; the trace rail on ⌘T; review tab from Phase 3.5.

**P9.6 Proof.** Playwright: first run → connect a provider (mock) → prompt → permission card → trace rail → review tab → reload keeps the session; the same run in dark mode; a screenshot set at 1440×900 and 1280×800, light and dark, committed under `docs/design/web/` for the founder to judge. `bun run --cwd apps/web build`, unit tests, brand-checklist test, typecheck, lint, format:check, unsandboxed unit suite.

## Gate

```bash
rune                    # opens the browser on the local URL within 3 s; same on a Linux VM and a Windows VM
bun run --cwd apps/web build && bun test tests/unit/web tests/unit/brand-checklist.test.ts
bun run test:e2e        # Playwright, light and dark
ls docs/design/web/     # four screenshots the founder reviews
grep -rc "0E5E63\|E7E8E3\|IBM Plex" apps/web/src packages/shared/src/design-tokens.ts   # 0: no Savoir residue
bun run typecheck && bun test tests/unit/ && bun run lint && bun run format:check
```

Done means: one product, one URL, three operating systems, the new identity, and a founder who opens it and does not want to close it.
