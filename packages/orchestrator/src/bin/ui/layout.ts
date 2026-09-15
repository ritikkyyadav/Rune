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

export type UiLayout = "single" | "split";

/** The founder's default, 2026-09-15. */
export const DEFAULT_UI_LAYOUT: UiLayout = "single";

const LAYOUTS: readonly UiLayout[] = ["single", "split"];

/** Fold a written value onto the two we have. Anything else is the default --
 *  a typo in config.toml must not decide the shape of the window. */
export function parseUiLayout(value: string | undefined | null): UiLayout | undefined {
  if (value == null) return undefined;
  const folded = value.trim().toLowerCase();
  if (folded === "") return undefined;
  // The two names people reach for. `workspace` is what Phase 4's own document
  // calls the split, and `wide`/`panel` are what the founder called it aloud.
  if (folded === "workspace" || folded === "wide" || folded === "panel") return "split";
  if (folded === "simple" || folded === "column" || folded === "classic") return "single";
  return LAYOUTS.includes(folded as UiLayout) ? (folded as UiLayout) : undefined;
}

/** env beats config beats the default. Pure, so the precedence is a test. */
export function resolveUiLayout(input: {
  env?: string | undefined;
  configured?: string | undefined;
}): UiLayout {
  return parseUiLayout(input.env) ?? parseUiLayout(input.configured) ?? DEFAULT_UI_LAYOUT;
}

let current: UiLayout = DEFAULT_UI_LAYOUT;

/** Set once, at launch, from `RUNE_LAYOUT` and `[ui] layout`. */
export function setUiLayout(layout: UiLayout): void {
  current = layout;
}

/** The layout this process is drawing. */
export function uiLayout(): UiLayout {
  return current;
}
