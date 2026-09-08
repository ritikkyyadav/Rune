# UI render pass — 2026-09-08 (P12.5)

The five largest September 2026 sessions from the founder's `~/.rune/rune.db`,
replayed through the real `TurnRenderer` at 80, 100 and 120 columns and written
out with the ANSI stripped. `before/` is the tree at `6452981`; `after/` is the
same replay with this lane's fixes in.

Reproduce either side with:

```
bun --preload ./scripts/fake-tty.ts scripts/render-live.ts \
    --largest 5 --width 80 --width 100 --width 120 \
    --out docs/evidence/ui-render-20260908/after
```

The DB is opened read-only (`file:…?mode=ro`). Nothing in this pass writes to
it. Durations are not stored, so every call replays as `0ms`; that is the one
thing in these transcripts that is not what the founder saw.

## Sessions

| id                                     | date       | stored events | turns |
| -------------------------------------- | ---------- | ------------- | ----- |
| `01a067b8-2593-7000-bb0b-f084d1c60045` | 2026-09-03 | 1741          | 6     |
| `01a06bb0-34a4-7000-8f96-d63144d54af2` | 2026-09-04 | 682           | 4     |
| `01a0719f-39b9-7000-9fdf-ccc60ef84bef` | 2026-09-05 | 606           | 4     |
| `01a05e6e-2db5-7000-820a-89985cd341a4` | 2026-09-01 | 577           | 3     |
| `01a07071-be0e-7000-85d5-1f1fa4d930f0` | 2026-09-05 | 451           | 6     |

## Defects found

Counts are across all five sessions at all three widths unless stated.

| #   | Defect                                                                                                                                                                                                                                                                                       | Where            | Before                                             | After                        | Test                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------- | ---------------------------- | -------------------------------- |
| D1  | A parallel tool batch orphans its provisional rows. `pending` was one slot, so a model message carrying four calls opened four rows and kept the fourth; the other three were never amended into their finished form and never removed, and the finished rows were appended underneath them. | `ui/turn.ts`     | 500 orphaned `› verb` rows (per width)             | 0                            | `ui-render-defects.test.ts` (D1) |
| D2  | The handoff "state of work" block was set down verbatim — up to 346 columns on an 80-column window. The fixed frame clips rather than reflows, so the one block a run that _died_ owes the reader was guaranteed to be cut off mid-sentence.                                                 | `ui/events.ts`   | 119 overflowing rows                               | 0                            | `ui-render-defects.test.ts` (D2) |
| D3  | `verification_completed` and `step_check` built their rows on absolute character budgets (100, 48 + 60) instead of the flow measure, so they overflowed an 80-column window by up to 24 and 53 cells.                                                                                        | `ui/turn.ts`     | 2 overflowing rows                                 | 0                            | `ui-render-defects.test.ts` (D3) |
| D4  | `flowRow` truncated the joined row, so an overflow ate the **receipt** — the outcome the row exists to report — leaving `0…` where `0ms` belonged. The argument should give way, not the outcome.                                                                                            | `ui/flow.ts`     | receipts clipped on every long-path row at 80 cols | receipt kept whole           | `ui-render-defects.test.ts` (D4) |
| D5  | Fenced code in an answer was hard-cut into width-sized chunks, splitting `python3 -m http.server 8765` across two rows as `http.serv` / `er 8765`. The command is the part the reader copies.                                                                                                | `ui/markdown.ts` | 3 broken commands                                  | 0                            | `ui-render-defects.test.ts` (D5) |
| D6  | A successful `multi_edit` whose result carried no `diff` rendered as a bare `edit <path>` row — no metric, no evidence, indistinguishable from a no-op.                                                                                                                                      | `ui/activity.ts` | 22 evidence-free edit rows                         | rows state the edits applied | `ui-render-defects.test.ts` (D6) |

## Checked and found clean

- **Jitter on resize.** Rendered at 100 and 120 and compared by row _kind_:
  tool rows, answer rows, rail notes and provisional rows are identical in
  count at both widths in all five sessions. Only prose re-wraps, which is what
  a resize is for.
- **Fold balance.** Every block committed with a `detail` form has both forms;
  no unbalanced or empty folds in the five sessions.
- **Glyphs.** No mojibake, no missing marks, no ambiguous-width mis-measure
  found in the rendered rows (the `→`/`₹`/`░` runs measure correctly under the
  repo's own `visLen`).
- **The one-grammar rule.** No committed row contains a JSON object opening.
  The rows that do are verbatim command output and diff bodies, which
  `ui-grammar.test.ts` exempts as content rather than layout.

## Left alone, with reasons

- **`multi_edit` results with no `diff` at all.** The tool itself began
  emitting `diff` on 2026-09-05 (`tool-registry/src/tools/multi-edit.ts`), so
  the 22 evidence-free rows are historical data, not a live defect. D6 makes
  the fallback row say something rather than nothing; it does not invent a
  diff that was never recorded.
- **Chamber head position on an out-of-order parallel batch.** When a burst of
  gathering calls finishes in a different order than it started, the chamber
  folds onto the first call to _finish_, which may sit below rows it replaces.
  Nothing is lost or duplicated; fixing it means choosing a row order for
  concurrent calls, which is a layout decision and this lane is a freeze.
- **Replayed durations.** Every call reads `0ms` because durations were never
  persisted. That is a store gap, not a renderer defect.
