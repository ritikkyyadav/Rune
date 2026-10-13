# Rune workspace refinement — 2026-10-10

The user requested a more professional, mature workspace and slash-command
panels, explicitly preserving the glyph, header, footer, and core theme.
This is the dated content-surface decision required by `docs/ui-freeze.md`.
It replaces the rule that routine read/command output must always be boxed
in the default transcript. It does not change the fixed frame, palette,
glyph vocabulary, permission behavior, or established keyboard shortcuts.

## Diagnosis

Inspected the actual TUI renderers and replayed two recent long sessions
(53 turns, 2,197 stored events) at 80 and 120 columns, read-only and without
provider calls. These replays reconstruct stored events; they are not a
recording of live timing or a substitute for terminal checks.

- A single read occupies a bordered excerpt even when it only gathers context.
  Short bursts repeatedly expand and collapse as calls finish.
- Successful routine commands share the weight of verification and failures.
- New files can consume fourteen rows before surrounding whitespace. Several
  changes displace the explanation of the work from an ordinary terminal.
- The initial and final plan repeat the same checklist in an amendable frame.
- Slash descriptions change columns as the visible window scrolls. Lists have
  little indication of position; long selected descriptions and current-choice
  tags can be clipped. An unmatched command silently removes the palette.

## Implementation plan

1. **Quiet routine activity.** A read, fetched page, or successful non-check
   command gets one outcome row. Its output remains available through the
   existing fold and work review. Checks and errors keep their evidence.
2. **Bound change previews.** New-file and edit excerpts use six body rows,
   including a counted expansion hint. Keep full edit counts and the existing
   evidence styling. No truncation without a usable expanded form.
3. **One current plan.** Update the existing plan block in an amendable session;
   keep historical updates in the work log. Preserve the inline fallback and
   the distinction between completed and unproven steps.
4. **Steady command panels.** Stable command/description columns, visible list
   position, current-choice tags that survive long labels, a selected-item
   description, and an explicit unmatched-command state. Preserve navigation,
   command names, actions, and the surrounding chrome.
5. **Verify the actual result.** Focused regressions for retained evidence,
   long sessions, narrow widths, selection and empty states; existing UI and
   type checks; real pseudo-terminal panel captures and before/after replays.

## Acceptance

- No changes to `glyphs.ts`, theme files, banner/header rendering, status/footer
  rendering, engine orchestration, or permission policy.
- Routine output cannot push a user-facing explanation off screen as a stack
  of decorative boxes. Changes, failed work and actual checks stay distinct.
- Every newly hidden tool excerpt has an expansion path, including short output
  and the individual calls inside a collapsed activity group.
- Selected rows, current-choice labels and contextual descriptions remain
  readable within small panel budgets. No horizontal overflow at tested widths.
- Existing uncommitted work is preserved. No live provider spending or install
  is required to review and verify the source changes.

## Validation results

Implemented all five steps. The [visual review](../evidence/rune-workspace-20261010/preview.html)
includes a deterministic before/after work sequence, actual command/settings
panels, and a real terminal run driven by a local scripted provider.

- **Final UI suite:** 958 passed, 0 failed across 53 files, using
  `TERM=xterm-256color bun test tests/unit/orchestrator/ui-*.test.ts </dev/null`.
  The initial `TERM=dumb` baseline had two existing colour assertions fail;
  a normal terminal environment resolves them without changing the theme.
- **Workspace type check/build dependencies:** all 15 tasks passed with
  `bun run typecheck` on the final source.
- **Final full unit suite:** 7,462 passed, 4 skipped, 0 failed across 482 files,
  using `TERM=xterm-256color bun test tests/unit </dev/null` (207.76 seconds).
  This run includes the final work-review evidence adjustment.
  Skips cover a case-sensitive-filesystem case, two browser corpus checks,
  and an unavailable baseline-materialisation environment.
- **Real terminal:** command navigation, unmatched search, settings and model
  selection captured at 80×24 and 120×40. A local mock-provider turn edited
  two scratch files, ran two real Node tests and printed the expected version.
  Output expansion/collapse, work review, and resize to 80 columns and back
  were exercised. This proves the scripted UI flow, not general model quality.
  No remote provider requests were made.
- **Preservation:** glyph, theme, banner, status, flow, working-indicator and
  voice files are byte-for-byte unchanged from the starting HEAD. The status
  and composer sections of `composer.ts` are also unchanged. Existing unrelated
  working-tree changes were retained. Subsequent local installation is recorded below.
- **Formatting:** changed TypeScript/Markdown files pass Prettier; the diff
  passes `git diff --check`.
- **Review artifact:** all preview sections, image assets and expansion controls
  checked in Chrome at 390px and 1440px; no script errors or horizontal overflow.

### Long-session replay comparison

Rows count the committed default transcript with folds closed. The same stored
events were replayed before and after at the same width. Session IDs and raw
private transcripts remain outside the repository; the table records aggregate
evidence only. Reconstructed durations do not measure runtime performance.

| Session | Turns / events | Width | Before rows | After rows | Reduction |
| ------- | -------------- | ----- | ----------- | ---------- | --------- |
| A       | 14 / 941       | 80    | 1,216       | 1,045      | 14.1%     |
| A       | 14 / 941       | 120   | 1,060       | 889        | 16.1%     |
| B       | 39 / 1,256     | 80    | 1,344       | 1,111      | 17.3%     |
| B       | 39 / 1,256     | 120   | 1,219       | 986        | 19.1%     |

Across both sessions, default boxes fell from 109 to 68 (37.6%). The replay
comparison measures density; the terminal captures verify interaction.

### Existing resize limit

Previously committed transcript rows retain their original wrapping when the
terminal shrinks. Long history rows are clipped to the new width and return
when it grows again; fresh rendering and panels use the current width. The
resize capture records this existing behaviour. Historical transcript reflow
would require a separate change to the stored-row architecture.

## Local installation — 2026-10-10

At the user's explicit request, `bash scripts/install.sh` rebuilt and installed
this working tree as **Rune v1.3.4-dev+2dabdb2**. Fresh minimal and login shells
both resolve `/Users/ritikyadav890/.rune/bin/rune`. The installed CLI and native
tools match the installer's SHA-256 provenance record.

The staged compiled binary passed `serve --check`. The installed pair then
passed `rune --version`, `rune doctor` in an isolated profile, and the native
`rune tools-smoke` write/read/edit/bash round trip. Real installed-TUI captures
verified the refined panels at both terminal sizes, bounded previews, output
expansion, work review, and a local scripted work run with two real Node tests.
The capture harness now exits through `/quit`; the repeated run exited cleanly.
No remote provider calls were used.

Rollback copies with suffix `.backup-1791639717` are retained in
`/Users/ritikyadav890/.rune/bin`; their CLI/tools hashes match the prior install.
No backup generations were pruned. See the [installation record](../evidence/rune-workspace-20261010/installation.json).
Existing running Rune sessions must be restarted to load the new executable.
