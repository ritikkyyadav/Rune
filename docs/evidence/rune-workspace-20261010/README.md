# Rune workspace review — 10 October 2026

Open [preview.html](preview.html) for the visual comparison. The implementation
decision and detailed validation are in the [refinement plan](../../program/rune-workspace-refinement-20261010.md).

## What each capture proves

- `work-before.png` and `work-after.png`: the same deterministic event sequence
  through the real renderer, at 80 columns. The test result shown inside this
  fixture is sample content, not a task-completion claim.
- `commands.png` and `settings.png`: real source-CLI pseudo-terminal captures
  at 80×24, with an isolated profile and scratch workspace. No prompt was sent
  to a provider. The surrounding Rune frame is unchanged.
- `agent-work.png` and `agent-work-expanded.png`: real source CLI at 120×40,
  driven by an existing loopback mock. Actual file edits and Node tests ran in
  a scratch project. The second image opens the most recent tool output with
  Ctrl+O. This checks UI interaction with scripted responses, not model ability.
- `terminal/`: text captures of the actual panels, expansion, work review, and
  resize sequence. `result.json` records the mock run's completion checks.

Captures were made from the working tree based on commit
`2dabdb2`, including this refinement and the user's pre-existing changes.
The user subsequently requested installation. The refined executable is now
installed and verified; see [installation.json](installation.json) and the
installation section of the plan. Private session replays are not included;
only their aggregate density measurements appear in the plan.

## Reproduce the current UI

Run from the repository root with its dependencies installed. Each capture
uses its own scratch root and excludes the user's provider credentials.

```sh
env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor \
  CAPTURE_ROOT=/tmp/rune-workspace-panels \
  python3 scripts/tui-capture/capture-workspace-panels.py /tmp/rune-workspace-panels-out

env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor \
  CAPTURE_ROOT=/tmp/rune-workspace-run \
  python3 scripts/tui-capture/capture-workspace-run.py /tmp/rune-workspace-run-out

TERM=xterm-256color bun scripts/tui-capture/workspace-refinement.ts /tmp/rune-workspace-fixture
```

The Python scripts produce terminal HTML and text. The TypeScript fixture
produces ANSI and text. Saved screenshots in this folder were rendered from
those terminal HTML captures using installed Chrome; screenshot generation
does not contact a provider.

## Validation

- Final UI suite: **958 passed, 0 failed** across 53 files.
- Final workspace typecheck: **15 tasks passed**.
- Final full unit suite: **7,462 passed, 4 skipped, 0 failed** across 482 files,
  including the final work-review changes.
- Glyph, palette, header, footer and composer rendering were preserved.
- Historical rows still retain their original wrapping during terminal resize;
  the 80-column resize capture shows the existing clipping behaviour. Fresh
  panels and newly rendered work adapt to the current width.
