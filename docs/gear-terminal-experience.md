# Gear terminal experience

Gear is a calm coding workbench, not a feed of agent internals. The supplied
`docs/design/gear-customizer.html` is the authoritative visual map for the terminal's
hierarchy, spacing, palette, typography, activity ledger, diff treatment, and
interaction language. The browser navigation, theme controls, sage page canvas,
demo copy, version, model, paths, and fabricated session data are customizer
scaffolding; the CLI renders the terminal surface with live Gear state.

The interface keeps three questions answered:

1. What did I ask for?
2. What is Gear doing now?
3. What remains under my control?

## Visual system

The theme picker exposes the customizer's five accents on both bases, plus an
Auto mode that leaves the host terminal profile untouched.

| Accent           | Light     | Dark      |
| ---------------- | --------- | --------- |
| Electric Cobalt  | `#0038FF` | `#3875FF` |
| Cyber Orange     | `#FF5500` | `#FF6E26` |
| Hyper Violet     | `#7C3AED` | `#A78BFA` |
| Emerald Matrix   | `#059669` | `#10B981` |
| Stark Monochrome | `#1A1917` | `#FFFFFF` |

The terminal surface itself uses warm ivory (`#FAF9F6`) in light mode and
near-black (`#080809`) in dark mode. The customizer's sage browser canvas is not
part of the production terminal. Red, ochre, and green retain semantic error, caution, and success
meaning. Exact accents paint the Gear mark, cursor, and active controls. Where
an exact decorative color is not readable enough as small light-mode text,
paths and labels use a deeper accessible derivative while the brand pigment
stays exact.

`/theme dark` and `/theme light` retain the current accent. A bare accent such
as `/theme violet` retains the current light/dark surface. OSC foreground,
background, and cursor changes recolor the whole terminal; ANSI-256 fallbacks
cover Terminal.app and Auto covers terminals that should keep their own colors.

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
  ▸▸ guided mode    shift+tab to cycle · esc to interrupt · ← sessions · ? shortcuts
```

- `Shift+Tab` cycles guided, Autonomy I/II/III, and auto-review modes.
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
Autonomy and sandbox changes are announced in the transcript because they alter
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
