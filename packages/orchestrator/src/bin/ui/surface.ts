// --- Surface choice: which terminal UI a launch gets ---
// Extracted pure so the DEFAULT is pinned by a test, not by folklore.
//
// TWO layouts, and the default is the FIXED frame (2026-09-05 evening, the
// founder's call after living with inline for a day: "the header and footer
// both launch together; keep the footer at one fixed place while I scroll"):
//
//   FIXED (default)   the alternate screen with a pinned header and a pinned
//                     footer. The wordmark holds the top rows, the composer and
//                     status hold the bottom rows, and the transcript in between
//                     is the ONLY thing that scrolls -- so the input box never
//                     moves, at launch or while reading back. The frame owns
//                     every cell: it cannot reflow old text on a resize (it
//                     repaints at the new width and clips), and it leaves the
//                     mouse to the terminal so click-drag copy stays native; the
//                     wheel reaches the transcript through the terminal's
//                     alternate-scroll mode (arrow keys), plus PgUp/PgDn.
//   INLINE (--inline / RUNE_INLINE)  the transcript committed to the terminal's
//                     OWN scrollback with the composer trailing the output --
//                     how Claude Code behaves. Native reflow and copy, but the
//                     header and the composer scroll away with the text, and on
//                     a fresh session both sit wherever the shell prompt was.
//
// `--fullscreen` / RUNE_FULLSCREEN name the default and win over `--inline`.
// `--classic` opts into the plain readline printer, and a pipe gets no TUI.

export interface SurfaceFlags {
  isTTY: boolean;
  /** --tui: force the pinned-composer TUI even when --classic is also set. */
  tuiForced?: boolean;
  /** --classic: the plain readline printer path. */
  classicForced?: boolean;
  /** --inline / RUNE_INLINE: opt out of the fixed frame into the native-scrollback layout. */
  inline?: boolean;
  /** --fullscreen / RUNE_FULLSCREEN: names the default fixed frame; wins over --inline. */
  fullscreenForced?: boolean;
}

export interface SurfaceChoice {
  useTui: boolean;
  /** True only when the native-scrollback layout is asked for with --inline /
   *  RUNE_INLINE (and --fullscreen is not also set); false for the default frame. */
  inline: boolean;
}

export function resolveSurface(flags: SurfaceFlags): SurfaceChoice {
  const useTui = flags.isTTY && (Boolean(flags.tuiForced) || !flags.classicForced);
  // The fixed frame is the default. Inline is reached only by asking for it,
  // and an explicit --fullscreen beats it: the user named the frame.
  return { useTui, inline: Boolean(flags.inline) && !flags.fullscreenForced };
}
