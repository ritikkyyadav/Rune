# Gear terminal experience

> **FROZEN — the terminal is the console (Phase 3 · P3.7, 2026-09-02).**
>
> This surface is finished. It gets correctness fixes, and nothing else.
>
> **What is frozen.** The whole surface is the transcript, the composer, the
> held-steps panel, the fleet rows and the footer. No new panels. No new
> dialects — every row goes through `flowRow`, and `tests/unit/orchestrator/
> ui-grammar.test.ts` is the enforcement, not this paragraph. No new colours:
> six semantic roles, two grounds, one accent, from
> `packages/shared/src/design-tokens.ts`.
>
> **What may still change.** A bug. A word that is wrong. A rendering fault at
> a width nobody tested. An event the engine started emitting that the
> transcript would otherwise drop. Anything that makes what is already here
> correct.
>
> **Why.** This terminal has been through ten UI programs — the v2 contract,
> fixed chrome, chambers and folds, the transcript overhaul, one grammar, the
> held-step surface, the fleet panel, turn collapse, read-back — and the
> founder still reads it as "stuck in between". That is a medium ceiling, not
> a polish gap: a terminal cannot show a diff and its trace at once, cannot
> keep a permission card in view while the stream moves under it, and cannot
> put the evidence for an answer beside the answer. The eleventh program would
> not fix it either. UX investment goes to the desktop and the web client,
> which are one bundle (`docs/gear-desktop-design.md`), and this surface stays
> exactly what it is good at: fast, minimal, always the same.
>
> **What changed in P3.3 and stops changing now.** The five-accent picker is
> gone. `/theme` is `light | dark | auto`, derived from the Savoir brand DNA
> like every other surface. Every retired accent id still resolves to the
> ground it was saved on, so nothing anyone saved errors.

Gear is a calm coding workbench, not a feed of agent internals. The pigments
come from `packages/shared/src/design-tokens.ts` — the Savoir brand DNA, shared
with the desktop and the web client. The hierarchy, spacing, activity ledger,
diff treatment and interaction language are described below and enforced by
`tests/unit/orchestrator/ui-grammar.test.ts`.

(`docs/design/gear-customizer.html` and `gear-customizer-v2.html` were the
visual contract until Phase 3. They are kept as history and are no longer
authoritative for anything: the five accents they specify were removed from
both surfaces, and the token parity test is bound to the DNA now.)

The interface keeps three questions answered:

1. What did I ask for?
2. What is Gear doing now?
3. What remains under my control?

## Visual system

Two grounds and one accent, from the Savoir brand DNA
(`packages/shared/src/design-tokens.ts`) — the same source the desktop and the
web client read, so the three surfaces cannot drift.

| Role     | Light (paper) | Dark (ink) | Carries                                  |
| -------- | ------------- | ---------- | ---------------------------------------- |
| ground   | `#E7E8E3`     | `#14161A`  | the surface                              |
| body     | `#14161A`     | `#E7E8E3`  | prose, tool names, the thing you read    |
| dim      | `#7C8088`     | `#7C8088`  | arguments, metrics, context lines        |
| accent   | `#0E5E63`     | `#17A0A8`  | identity, paths, branches, option keys   |
| ok       | `#0E5E63`     | `#17A0A8`  | added lines, passes — an addition is a datum |
| warn     | `#E2A23A`     | `#E2A23A`  | approval prompts, caution                |
| danger   | `#9A4A3A`     | `#B1796D`  | removed lines, failures, errors          |

Six closed roles: the budget is on MEANINGS, not on pigments. There is no
green — a second hue for "added" would be a second brand colour arriving
through a diff, so an addition is a datum. On ink the negative is the brand's
own brick lifted toward paper, because `#9A4A3A` is 2.2:1 on ink: fine as a
rule, unreadable as a word.

`/theme` is `light | dark | auto`. Auto leaves the host terminal's own profile
untouched. Every retired accent id (`gear-violet-dark`, `orange`, `flow`, …)
still resolves to the ground it was saved on rather than erroring. Pigments are
emitted as exact 24-bit RGB with a derived ANSI-256 fallback, so the product
looks like itself wherever it runs and degrades on purpose rather than by
accident; `bun run scripts/generate-terminal-colors.ts` prints the table.

The terminal never claims the host's foreground or background (OSC 10/11). They
sit behind and beneath everything, including the person's other programs.

## Frame 1 — arrive

The four-row, nine-tooth Gear avatar, actual version, active model/provider, current
working directory, and branch establish identity and context without spending
half a 24-row terminal on a logo.

```text
   ⣴⣦⣽⣯⣴⣦    Gear  v0.2.0
  ⣶⣾⡿⠋⠙⢿⣷⣶   claude-sonnet-4-6 · anthropic · /model to change
  ⢠⣿⣷⣄⣠⣾⣿⡄   ~/Projects/sample-app · feat/reliability-and-tooling
  ⠈⠉⢿⡟⢻⡿⠉⠁

  ──────────────────────────────────────────────────────────────
  › Give Gear a coding task (or type / for commands)…
  ▸▸ guided mode · claude-sonnet-4-6 · ~/Projects/sample-app
```

The first frame is sparse. It does not advertise features before the person
has a task. Narrow terminals collapse to a one-line `⚙︎ Gear` lockup while
retaining model and workspace context.

## Frame 2 — compose and navigate

The input is an open writing surface with one hairline, not a heavy card. The
footer makes the control posture explicit and keeps the reference shortcuts:

```text
  ▸▸ 1st gear    shift+tab to shift up · esc to interrupt · ← sessions · ? shortcuts
```

- `Shift+Tab` shifts up through the five gears (1st → 4th, then Auto review).
- Left arrow from an empty composer opens sessions.
- `?` or `/` opens the live command palette.
- Keys `1`–`9` quick-select the first nine visible model or theme choices.

The command palette leads with the five reference actions: `/theme`, `/model`,
`/sessions`, `/mode`, and `/diff`. It then exposes the wider Gear command set,
with type-to-filter, keyboard navigation, short tags, and a selected-row fill.

## Frame 3 — understand

After submission, the request becomes the neutral full-width landmark from the
reference. Routine tool bursts collapse into a factual activity ledger while
representative commands, searches, and edits remain visible.

```text
  ⌄ Make the onboarding flow calmer and easier to scan

  Read 6 files, ran 2 searches, and ran 2 shell commands

  ● Plan: Trace the current onboarding path, then simplify its hierarchy.
```

The activity ledger is concise by default. Full routine tool detail remains
inspectable through `Ctrl+R` without overwhelming the main transcript.

## Frame 4 — plan and build

The transcript follows the same chronological structure as the reference:
plain-English plan, file/search activity, command evidence, edit/diff evidence,
then verification. Only the first planning statement receives the `Plan:` label.

```text
  ● Searching src/onboarding
     ╰ $ grep -rn "Welcome|onboarding" src/onboarding/  # 8 matches

  ● Editing src/onboarding/Welcome.tsx
     src/onboarding/Welcome.tsx                     lines 42–48
     42 - const density = "busy";
     42 + const density = "calm";
```

## Frame 5 — permission

A permission request replaces the composer so there is one decision on screen.
It names the human action first, preserves the exact command or target, previews
file changes when available, and states that no action has happened yet.
Gear and sandbox changes are announced in the transcript because they alter
the contract, not merely a preference.

## Frame 6 — inspect and check

Verification is first-class transcript evidence, not a spinner suffix. A
failure records what needs attention and the subsequent repair activity;
success is reported only after passing evidence.

`/diff` is a read-only workspace surface. It inspects staged and unstaged Git
changes plus the untracked-file inventory, shows changed files and `+/-` totals,
and uses quiet green/red row fills from the active theme. It never stages,
restores, or writes files.

## Frame 7 — handoff

The handoff mirrors the reference order: completion, result, then evidence:

```text
  ✓ Complete. (38s · 12 actions)

  The onboarding flow now opens with one clear decision…

  ✓ 12 checks passed   ✓ typecheck clean
  3 files changed  ·  +34 -18
```

Failures become “Needs attention,” interrupted work becomes “Stopped,” and
changed code without observed checks explicitly says “verification not
observed.”

## Sessions

The sessions surface is a searchable timeline rather than a flat picker. It
groups history by Today, Yesterday, Past 7 days, and month; each two-row card
shows short id, title, active/saved state, workspace, model/event metadata, and
time. `Ctrl+N` starts a clean session, `Ctrl+D` uses two-step deletion, Tab moves
between active and archived views, and `/` filters locally.

## Responsive and accessibility rules

- Every live line stays inside the terminal-cell width, including narrow views.
- The composer never reaches the rightmost cell, preventing auto-wrap/repaint corruption.
- Long pickers, command lists, diffs, and sessions are viewport-bounded.
- Text-bearing tokens meet WCAG AA contrast on explicit Gear surfaces.
- `NO_COLOR` removes cosmetic ANSI output without removing content or state.
- Auto mode preserves unknown host colors instead of guessing an unsafe foreground.

## Implementation map

- `packages/orchestrator/src/bin/ui/themes.ts` — ten customizer palettes and aliases.
- `packages/orchestrator/src/bin/ui/theme.ts` — live theme, surface fills, OSC/ANSI fallback.
- `packages/orchestrator/src/bin/ui/banner.ts` — four-row, nine-tooth Gear avatar and live metadata.
- `packages/orchestrator/src/bin/ui/composer.ts` — composer, popovers, pickers, sessions.
- `packages/orchestrator/src/bin/ui/turn.ts` — task landmark, activity ledger, diffs, and handoff.
- `packages/orchestrator/src/bin/ui/workspace-diff.ts` — read-only staged/unstaged diff surface.
- `packages/orchestrator/src/bin/ui/tui.ts` — centered reading column, raw-mode interactions, and session controls.
