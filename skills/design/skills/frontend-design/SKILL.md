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

## 1. Decide the art direction WITH the user, before any markup

The failure this replaces: the agent announces "I'll handle the design" and
produces its house style — one accent on a neutral ground — for a lab, a poem,
and a music festival alike. Deciding silently is the defect. Four steps, in
order, and none of them is optional for a user-facing deliverable.

**1. Name the subject and its genre, in one line.**
"This is a comparative-genomics lab: an instrument, read by scientists, whose
authority comes from rigour." Not "a website".

**2. Look up how that genre actually looks NOW.**
One `web_search` round on the subject's design conventions, plus a `web_fetch`
of one or two real examples in that space. What you remember is a hypothesis;
current practice moves. Say in one line what the references had in common.

**3. Offer the user two or three directions — then WAIT.**
Open `art-directions.md` (beside this file), take the candidate row for the
subject, and put them to the user with `ask_user`. Each option must be concrete
enough to picture:

> "Swiss / International — white ground, strict visible grid, Helvetica-class
> type in three sizes, red as the only accent, zero decoration. Reads as an
> instrument."
> "Editorial — cream paper, serif display, 65ch measure, rules instead of
> boxes, marginal notes. Reads as a published study."
> "Minimal dark — near-black, one cyan accent, hairline borders, tabular
> numerals. Reads as a live console."

Never "minimal or modern?" — those are not choices, they are adjectives. Name
the ground, the type, and the one signature move for each.

**4. Commit, and write the tokens first.**
On the answer, write the token block — ground, surfaces, ink, one accent,
semantic colours, type scale, spacing scale, radius family — as the FIRST thing
in the stylesheet. Everything after is composed from those tokens. Never a
literal colour outside the token block.

**When to skip the ask (and only these):**
- The project already has a design system, brand, or token file → match it.
- The user already pinned a direction, a reference image, or a brand.
- You are editing an existing screen's behaviour, not establishing its look.
- `ask_user` is unavailable (4th gear with no user present) → then state the
  direction and WHY it fits the genre in one line, and build that.

**Scale the ceremony, not the care.** A single poem still gets a direction —
Handwritten on paper texture with a marker underline, say — chosen deliberately
and named in one line. Small does not mean default.

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
