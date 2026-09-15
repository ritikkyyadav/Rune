// ─── Which frame the session draws ───
//
// Two shapes, one switch, and the default is the older one.
//
//   single  ONE column. Header, the transcript at the full width of the
//           window, the agents strip, the composer at the bottom, the status
//           line. The agents panel is the `ctrl+f` overlay; `/setup` and
//           `/keys` take the footer. This is the frame the fixed-chrome
//           viewport shipped with, and it is the default again.
//
//   split   The four-region workspace frame: a fixed 40-cell right column
//           carrying the agents panel over the composer, the transcript in the
//           left column. Built 2026-09-14; kept whole, reached by asking.
//
// The founder's words on 2026-09-15: "I want the older simple TUI panel, not
// that split one — make it back." The split was not wrong, it was expensive:
// forty cells of right column at EVERY width, most of them stale most of the
// time, taken out of the measure the transcript is written at. That trade is
// now a setting rather than an assumption.
//
// Mechanically this is one word threaded into `regions()`. Below
// `PANEL_MIN_COLS` the split ALREADY collapses to exactly the single-column
// shape -- the strip, the full-width workspace, the overlay, the footer
// wizard -- so `single` is not a fifth code path. It is the collapsed path,
// asserted at every width. That is why this file is twenty lines and not two
// hundred, and it is the reason the existing collapsed tests are the
// regression suite for the new default.
//
// The value is read ONCE, at launch. `contentCols()` is the measure every
// transcript row is rendered at and rows are stored rendered, so flipping the
// layout mid-session would re-wrap the whole history at a width it was never
// written for -- the same reason `contentCols` refuses to consult the mode.

// The vocabulary itself lives in `@rune/shared` (ui-layout.ts) because the
// engine must be able to read `[ui] layout` back for `/config` without
// importing the terminal layer. Re-exported here so this module stays the one
// place the rest of the TUI asks about the layout.
export type { UiLayout } from "@rune/shared";
export { DEFAULT_UI_LAYOUT, parseUiLayout, resolveUiLayout } from "@rune/shared";

import { DEFAULT_UI_LAYOUT, type UiLayout } from "@rune/shared";

let current: UiLayout = DEFAULT_UI_LAYOUT;

/** Set once, at launch, from `RUNE_LAYOUT` and `[ui] layout`. */
export function setUiLayout(layout: UiLayout): void {
  current = layout;
}

/** The layout this process is drawing. */
export function uiLayout(): UiLayout {
  return current;
}
