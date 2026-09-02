# The web product — visual direction

**Phase 9 · written before the code · the contract the screenshots are judged against**

Gear is one URL-based web application, served by the engine on loopback and opened in a
browser. Same bytes on Linux, Windows and macOS. This document fixes the visual system
that application is built in, so the decisions are reviewable as a list rather than
archaeology through a stylesheet.

The old Savoir identity — petrol teal `#0E5E63`, drafting paper `#E7E8E3`, IBM Plex Mono,
the block-cursor wordmark, the 28px graticule — is gone. It was applied in Phase 3.3 to an
identity the founder had already ditched. Nothing below descends from it.

---

## 1. The mark

A solid electric-blue eight-tooth gear: rounded tooth tips, a round centre hole, no
gradient, no outline, no shadow, one colour.

| Property        | Value                                                    |
| --------------- | -------------------------------------------------------- |
| Teeth           | 8, evenly spaced                                          |
| Outer radius    | 1.00 (tooth tip)                                          |
| Root radius     | 0.80 (the body between teeth)                             |
| Hole radius     | 0.36                                                      |
| Tooth tip width | 0.30 of the pitch (45°), so 13.5° of arc at the tip       |
| Corner radius   | 0.06, on all four corners of every tooth                  |
| Fill            | `--accent` (`#1B3FE4` light, `#5B79FF` dark)              |
| Fill rule       | `evenodd` — the hole is a subpath, not a second element   |

It is generated, not drawn: `scripts/generate-gear-mark.ts` emits
`apps/web/branding/gear-mark.svg` from exactly those numbers. Changing a number is a
one-line edit with a reviewable diff. When the founder supplies the original vector it
replaces the file byte-for-byte and the generator becomes a record of what it replaced.

The mark appears in four places and nowhere else: the browser tab, the sidebar head, the
empty state, and the app icon. It never spins. A spinning cog is a state, and the identity
is not a state.

## 2. Tokens

Every value below lives in `packages/shared/src/design-tokens.ts` and reaches CSS through
`scripts/generate-tokens-css.ts`. Nothing else in the repository introduces a pigment.

### Colour

| Token             | Light     | Dark      | Role                                            |
| ----------------- | --------- | --------- | ----------------------------------------------- |
| `--ground`        | `#FAFAF8` | `#0F1114` | The page. Never pure white, never pure black.    |
| `--surface`       | `#FFFFFF` | `#15181D` | Cards, the composer, the sidebar head.           |
| `--sunk`          | `#F3F3F1` | `#0B0D10` | Code, diffs, the sidebar body, inset wells.      |
| `--ink`           | `#111318` | `#E8E9EC` | Body and prose.                                  |
| `--ink-2`         | `#5B6070` | `#A2A7B3` | Secondary: labels, sublines, inactive tabs.      |
| `--ink-3`         | `#8B909C` | `#6C717D` | Tertiary: timestamps, ids, counts.               |
| `--hairline`      | `#E6E6E2` | `#232730` | Every border in the product. One weight: 1px.    |
| `--accent`        | `#1B3FE4` | `#5B79FF` | The mark, the primary button, focus, live, rail. |
| `--accent-hover`  | `#1735C0` | `#758EFF` | Derived: 16% toward black (light) / white (dark).|
| `--accent-quiet`  | derived   | derived   | 8% / 14% accent over the ground. Fills only.     |
| `--raised`        | `#F1F1F1` | `#222529` | Derived: the surface, 6% toward the ink. Hover.  |
| `--ok`            | `#1D874B` | `#1F9D55` | Success. State only.                             |
| `--caution`       | `#9D6D1A` | `#C98A1A` | Caution. State only.                             |
| `--danger`        | `#D2453B` | `#D55950` | Failure, refusal, removal. State only.           |

Nineteen literal hexes; every other value is a function of them.

The status trio is **published** as `#1F9D55` / `#C98A1A` / `#D2453B`, and each ground gets
the readable variant by one rule rather than a second hand-picked set: step the published
colour toward that ground's ink in 2% increments until it clears 4.5:1 as text on that
ground's surface (`readableOn`). On paper that darkens — `#C98A1A` on white is 2.9:1, a
swatch and not a sentence — and on ink it lightens. The hue does not move, and changing a
published status colour moves both grounds by construction. `--accent-hover`,
`--accent-quiet`, `--raised`, `--ink-faint` and `--hairline-strong` are derived the same way.

Measured contrast on the surface each is used on: ink 18.7 / 14.8, secondary 6.0 / 7.5,
tertiary 3.1 / 3.7 (meta only, never prose), accent 7.0 / 5.1, text on the accent button 7.3
/ 5.2. Body, secondary, the accent and all three status colours clear WCAG AA; tertiary
clears AA-large and is used for nothing a person has to read.

### Type

Geist for the interface and prose, Geist Mono for code, paths, ids and figures. Both from
Google Fonts with `display=swap` and a real fallback each, because a font that never
arrives must degrade to something chosen.

```
--sans: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif
--mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace
```

| Step      | Size / line     | Tracking  | Where                                     |
| --------- | --------------- | --------- | ----------------------------------------- |
| display   | 22px / 1.25     | −0.02em   | Empty state, the one heading on a screen  |
| title     | 17px / 1.35     | −0.015em  | Session title, panel heads                |
| prose     | 15.5px / 1.65   | 0         | Assistant text in the transcript          |
| body      | 15px / 1.55     | 0         | Everything else                           |
| small     | 13px / 1.5      | 0         | Card bodies, sublines, buttons            |
| label     | 12px / 1.4      | +0.02em   | Field labels, tab names, group heads      |
| micro     | 11px / 1.35     | +0.02em   | Mono: ids, counts, durations              |

No uppercase anywhere. `font-variant-numeric: tabular-nums` on every element that carries a
number a person compares — costs, durations, token counts, line numbers, context percent.

### Shape, depth, motion, density

- **Radii: 6, 8, 10 and nothing else.** 6px chips and inline tags; 8px cards, fields,
  buttons and panels; 10px the composer, the one element that should read as the softest
  thing on the page. Circles (`50%`) for status dots — a dot is a circle, not a corner.
- **Depth is a hairline.** One 1px border colour, one level of surface tint above the
  ground. Exactly one shadow token exists and it is only legal on floating overlays — the
  ⌘K palette, dropdown menus, the toast. A shadow on a content surface is a test failure.
- **Motion: 160ms for state, 220ms for panels,** `cubic-bezier(0.2, 0, 0, 1)`. No entrance
  choreography, no bounce, no stagger. `prefers-reduced-motion: reduce` drops every
  duration to 0ms except the streaming caret, which becomes a static block.
- **8px grid.** Row height 32, control height 32, composer minimum 44. Sidebar 264px.
  Reading column max 760px, centered, `--pad-x: 24px`.
- **Icons: Lucide geometry, 16px, 1.5px stroke, `currentColor`.** Drawn inline as paths in
  `Icons.tsx`; no icon font, no sprite sheet, no dependency.

## 3. Layout

Three regions. The sidebar and the rail are chrome; only the reading column scrolls.

```
┌────────────────────┬──────────────────────────────────────────────┬──────────────────┐
│  ▪ Gear      ⌄     │  Session   Files   Review        ⌘K   ⌘T      │  Trace       ✕   │
│  gear-workspace    │ ─────────────────────────────────────────────  │ ─────────────────│
│                    │                                               │  turn 3   ⌄      │
│  ＋ New session ⌘N │        ┌───────────────────────────┐          │  ├ model  1.2s   │
│  ⌕ Search      ⌘K │        │  reading column · 760px   │          │  ├ bash   0.4s   │
│  ▤ Files           │        │                           │          │  │  ⊘ permission │
│  ⚯ Connect         │        │  ▸ plan ledger (quiet)    │          │  └ edit   0.1s   │
│  ⚙ Settings        │        │                           │          │ ─────────────────│
│ ───────────────────│        │  you ────────────────     │          │  inspector       │
│  Today             │        │  the prompt as typed      │          │  args / result   │
│   ▪ Fix the parser │        │                           │          │  prompt bytes    │
│   ▫ Rename tokens  │        │  gear ───────────────     │          │  policy          │
│  Yesterday         │        │  prose, 15.5/1.65         │          │                  │
│   ▫ Web product    │        │  ▸ 4 tools · 2.1s         │          │                  │
│  Past 7 days       │        │  ┌ diff · src/app.ts ─┐   │          │                  │
│   ▫ Protocol       │        │  └────────────────────┘   │          │                  │
│                    │        │  ┌ permission ─────────┐  │          │                  │
│ ───────────────────│        │  │ inline. never modal │  │          │                  │
│  3rd gear · $0.42  │        │  └─────────────────────┘  │          │                  │
│  v0.3.0            │        └───────────────────────────┘          │                  │
│                    │  ┌──────────────────────────────────────────┐ │                  │
│                    │  │ 📎  Ask Gear to do something…            │ │                  │
│                    │  │                     custom/fake ⌄  3rd ⌄ │ │                  │
│                    │  └──────────────────────────────────────────┘ │                  │
└────────────────────┴──────────────────────────────────────────────┴──────────────────┘
   264px, collapsible ⌘B            flex, max 760px reading column      380px, ⌘T, off by default
```

- **Sidebar (264px, ⌘B).** Workspace switcher at the top (folder name + chevron). Five
  nav items. Sessions grouped Today / Yesterday / Past 7 days / month, each row a title, a
  short id and a status dot. Footer: gear, cost today, version.
- **Main.** One tab strip (Session · Files · Review), then the reading column, then the
  composer pinned to the bottom. The column is `max-width: 760px`, which at 15.5px Geist
  is 72–78 characters — under the 80 the feel checklist asks for.
- **Trace rail (380px, ⌘T).** Off by default. Slides in from the right in 220ms. The span
  tree and the inspector, unchanged in substance.

## 4. Component inventory

**Keep, restyled only** — the reducers and the shapes are right, the pigment was not:
`lib/stream.ts`, `lib/trace.ts`, `lib/fleet.ts`, `lib/markdown.tsx`, `lib/gears.ts`,
`hooks/useEngine.ts`, `hooks/useSession.ts`, `hooks/useTurns.ts`, `components/Transcript.tsx`,
`components/DiffViewer.tsx`, `components/TraceRail.tsx`, `components/Review.tsx`,
`components/Cards.tsx`, `components/Icons.tsx`.

**Rework** — same job, new structure:

| Component      | What changes                                                                     |
| -------------- | -------------------------------------------------------------------------------- |
| `Sidebar`      | Workspace switcher, five nav items, day groups with status dots, quiet footer.    |
| `Composer`     | 10px field, 44px minimum, grows to 8 lines, model picker + gear picker on the right, draft persisted per session. |
| `Settings`     | Sections, not a dialog: appearance (light/dark/system), model defaults, gear default, telemetry. |
| `Overlays`     | One popover primitive. The ⌘K palette is built on it; so are the two pickers.     |
| `GearMark`     | The new eight-tooth geometry, imported from the generated SVG's path data.        |
| `theme.ts`     | `data-theme` on `<html>`, three states, system default, no accent override.       |

**New**: `Shell.tsx` (the three-region frame and the tab strip), `Palette.tsx` (⌘K over
sessions, files and commands), `Files.tsx` (tree + preview), `Connect.tsx` (providers and
connectors with status), `PlanLedger.tsx` (the plan as a quiet checklist).

**Delete**: `Titlebar.tsx` (a title bar is a native-window idea; the tab strip replaces it),
`Wordmark.tsx` (the block-cursor lockup is the ditched identity), `src-tauri/` entirely,
the Tauri transport branch, `styles/desktop.css` (rewritten as `styles/web.css`),
`branding/gear-logo-source.jpeg` and `branding/gear-app-icon.svg` (both the old identity).

## 5. Ten decisions, concretely

Ten sentences on what "ahead of its time, minimal, comfortable for hours" means as numbers
rather than adjectives.

1. **Ink is `#111318` and the ground is `#FAFAF8`,** never `#000` on `#FFF`, because pure
   black on pure white at 18:1 is the contrast that makes eyes ache by hour two, while
   18.7:1 between two slightly-off values reads as crisp without glare.
2. **Every border in the product is 1px of a single hairline colour** and there is exactly
   one shadow token, legal only on things that float — depth by tint and rule is what
   separates an instrument from a card-shuffling dashboard.
3. **The reading column stops at 760px** so a line of 15.5px Geist lands at 72–78
   characters, which is the width prose has been read at for four hundred years and the
   single largest determinant of whether someone can sit with it.
4. **Prose is 15.5px on a 1.65 line** and interface text is 15px on 1.55: the transcript
   gets the looser leading because it is read, and the chrome gets the tighter one because
   it is scanned.
5. **The accent covers under 5% of any screen** — the mark, the send button, the focus
   ring, the live dot and the selected-row rail, and nothing else; blue that appears
   everywhere stops meaning anything and starts being decoration.
6. **The accent never carries body text.** It is a fill and an edge. Text on the accent is
   white at 7.3:1; text in the accent does not exist.
7. **State changes take 160ms and panels take 220ms,** on one easing curve, with nothing
   staggered and nothing bouncing — the only motion on screen should be the work happening,
   so a person can tell at a glance whether anything is running.
8. **Density is an 8px grid with 32px rows** and 24px of gutter on the reading column:
   generous enough that nothing collides, tight enough that a session with forty turns does
   not become a scroll marathon.
9. **No modal ever holds a decision.** Permissions, held steps, briefs and questions are
   cards inline in the transcript, because a modal takes the stream away at the moment you
   most need to read it in order to decide.
10. **Nothing blinks, nothing counts, nothing badges.** There is no notification dot, no
    unread count and no attention-seeking animation anywhere; the product's claim on your
    attention is the work you asked for and nothing else.

## 6. What the tests hold

`tests/unit/brand-checklist.test.ts` reads the **built** stylesheet (`apps/web/dist/assets/*.css`)
and fails on: a second chromatic hue outside the three status colours; a `box-shadow` on any
selector that is not something that floats; a `border-radius` outside {6px, 8px, 10px, 50%,
0}; a near-white the token system does not define; a missing Geist or Geist Mono declaration
or a stack without its generic fallback; a token defined only inside a media query; and any
occurrence of `0E5E63`, `E7E8E3`, `IBM Plex`, `Savoir`, `graticule` or `datum`. It refuses a
**stale** build as well as a missing one — `dist/` is gitignored, so a directory built before
the rebrand survives every checkout, and a checklist that audits those bytes is green on a
broken tree and red on a correct one.

`tests/unit/shared/design-tokens-parity.test.ts` pins the twelve literal values above, the
derivations, the radius set, the font stacks and the measured contrast floors.
