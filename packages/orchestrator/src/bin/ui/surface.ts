// --- Surface choice: which terminal UI a launch gets ---
// Extracted pure so the DEFAULT is pinned by a test, not by folklore.
//
// TWO layouts, and the default is the one with fixed chrome:
//
//   FIXED (default)  the alternate screen, split into a pinned header, a
//                    scrolling transcript, and a pinned footer. The header and
//                    the composer hold their rows; only the middle moves. This
//                    is the product surface.
//   INLINE (--inline / GEAR_INLINE)  the transcript is committed to the
//                    terminal's own scrollback with only the composer pinned,
//                    so native scrollback, momentum scrolling, mouse selection
//                    and `| tee` keep working -- at the cost of the frame: a
//                    wheel flick carries the header and the field away with it.
//
// The fixed surface used to be the default, was removed for the inline one, and
// is the default again. What killed it the first time was not the alternate
// screen: it was a compositor that asserted a theme BACKGROUND over every cell,
// so an empty session rendered as a viewport of painted nothing. This one paints
// no background at all -- unclaimed rows are erased to the terminal's own colour
// -- so it inherits the user's theme exactly the way the inline surface does.
//
// `--classic` still opts into the plain readline printer, and a pipe still gets
// no TUI at all. `--fullscreen` / GEAR_FULLSCREEN name the default and are
// accepted as a no-op, so an old alias does not error out.

export interface SurfaceFlags {
  isTTY: boolean;
  /** --tui: force the pinned-composer TUI even when --classic is also set. */
  tuiForced?: boolean;
  /** --classic: the plain readline printer path. */
  classicForced?: boolean;
  /** --inline / GEAR_INLINE: the legacy native-scrollback layout. */
  inline?: boolean;
  /** --fullscreen / GEAR_FULLSCREEN: names the default. Accepted as a no-op. */
  fullscreenForced?: boolean;
}

export interface SurfaceChoice {
  useTui: boolean;
  /** True only for the legacy layout: --inline / GEAR_INLINE. */
  inline: boolean;
}

export function resolveSurface(flags: SurfaceFlags): SurfaceChoice {
  const useTui = flags.isTTY && (Boolean(flags.tuiForced) || !flags.classicForced);
  // --fullscreen asks for what it already gets, so it cannot contradict
  // --inline; if both are given the explicit opt-out wins.
  return { useTui, inline: Boolean(flags.inline) };
}
