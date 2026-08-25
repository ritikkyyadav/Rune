---
name: frontend-design
description: Build web pages, app screens, landing pages, and HTML reports that look designed, not generated. Trigger on "build me a website/page/app/UI", "make a landing page", "create an HTML report", "make this look good", or any task whose deliverable is something a person looks at in a browser.
argument-hint: "<what to build, plus any brand/style constraints>"
---

# Frontend design — pages that look designed, not generated

The bar for anything a person looks at: "a senior product designer built this."
"Looks generic" is a bug with the same severity as a failing test. This skill is
the working method; the doctrine's "# Building interfaces" section is the law.

**Scope — this skill styles screens, it never shrinks an app into a page.**
If the ask is an APPLICATION (behavior, state, a core loop — "clone X", an
app/tool/game), the doctrine's "Greenfield builds" section governs first:
scaffold the real runnable project, make the core loop work, THEN apply this
skill to its UI. Satisfying an application request with a static page is a
failed task no matter how designed the page looks.

## 1. Commit to ONE art direction before writing markup

Pick one and execute it to the last pixel — never average two:

- **Calm instrument panel** — near-black ground (#0b0c0e-ish), one accent, hairline
  borders (1px, ~12% white), muted grays, tabular numerals. For dashboards, tools,
  dev products.
- **Warm editorial** — cream/paper ground, a serif display face, mono microlabels,
  generous measure (~65ch), rules not boxes. For content, reports, reading.
- **Brutalist print** — stark white, giant type, numbered sections, thick rules,
  zero decoration. For portfolios, manifestos, single-message pages.
- **Soft product light** — off-white ground, one saturated accent, large radii used
  CONSISTENTLY, real shadows (one elevation system, not soup). For consumer apps.

If the project already has a design system or brand, match it exactly instead.

## 2. Structure does the design

- **Type scale**: one display size that dominates (clamp(2.5rem, 6vw, 4rem) class),
  a quiet body (16-18px/1.6), and 10-11px uppercase letter-spaced (0.08em) labels.
  Three sizes used consistently beat seven used once.
- **Spacing grid**: every margin/padding from one scale (4/8/12/16/24/32/48/64/96).
  Section rhythm: big gaps between sections (64-96px), small inside (8-16px).
- **One accent color** on a neutral ground. Status colors (green/red/amber) mean
  status only. Grays carry the hierarchy: 3-4 steps, not 8 colors.
- **One corner-radius family** (e.g. 6px inputs, 10px cards — related, consistent).
- **Real copy**: never lorem ipsum; write plausible product copy. Units on every
  number. Tabular numerals (font-variant-numeric: tabular-nums) wherever numbers align.
- **Icons are inline SVG** (stroke 1.5-2, currentColor) — never emoji.

## 3. Charts, when the page has data

- Honest forms only: line/area = trend · bar = comparison · hbar = ranking ·
  stacked bar = composition over time · scatter = correlation · doughnut = share
  of a whole with ≤5 slices and a center total. **Never 3D, never dual axes,
  never a pie for 6+ categories** — use a horizontal bar ranking instead.
- ≤4 series per chart, short labels, one accent + grays for the rest.
- Plot REAL numbers from the task. A beautiful chart of invented data is a
  failed task — gather the data first or say what's missing.

## 4. Self-contained and finished

- No CDNs, no web fonts, no external images unless the project already uses
  them. System font stacks are excellent: `-apple-system, "SF Pro", Inter,
system-ui, sans-serif` / serif: `"Iowan Old Style", Georgia, serif`.
- Design the empty, hover, and loading states you ship. A composed page, not a
  filled one: generous whitespace is content.
- Responsive: max-width container (65-72rem), fluid type, grid that collapses.

## 5. Banned slop (remove on sight)

Purple-blue gradient washes · drop-shadow soup · mixed corner radii · emoji as
icons or in headings · 8-color palettes · rainbow charts · centered walls of
text · ALL-CAPS paragraphs · decoration that carries no information · "Lorem
ipsum" · `<marquee>` energy of any kind.

## 6. The review pass (non-negotiable)

After writing the page:

1. Open it (`open <path>` on macOS, `xdg-open` on Linux) or serve it and curl it.
2. Re-read the rendered structure top-to-bottom as a REVIEWER: does one thing
   dominate? Is there exactly one accent? Do the numbers align? Is any banned
   slop present? Does it read as one art direction?
3. Fix the worst thing you find. Once. Then stop polishing and report.

A page you never looked at is unreviewed work — say so honestly if you could
not open it.
