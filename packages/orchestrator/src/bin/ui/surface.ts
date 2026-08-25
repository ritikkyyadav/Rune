// ─── Surface choice: which terminal UI a launch gets ───
// Extracted pure so the DEFAULT is pinned by a test, not by folklore: on a
// TTY with no flags Gear opens the fullscreen alt-screen TUI. `--classic`
// opts into the readline printer, `--inline` into the native-scrollback
// pinned-composer layout, and a pipe gets no TUI at all.

export interface SurfaceFlags {
  isTTY: boolean;
  /** --tui: force the pinned-composer TUI even when --classic is also set. */
  tuiForced?: boolean;
  /** --classic: the plain readline printer path. */
  classicForced?: boolean;
  /** --inline / GEAR_INLINE: native scrollback + pinned composer. */
  inline?: boolean;
  /** --fullscreen / GEAR_FULLSCREEN: force the alt-screen surface. */
  fullscreenForced?: boolean;
}

export interface SurfaceChoice {
  useTui: boolean;
  inline: boolean;
  fullscreen: boolean;
}

export function resolveSurface(flags: SurfaceFlags): SurfaceChoice {
  const useTui = flags.isTTY && (Boolean(flags.tuiForced) || !flags.classicForced);
  const inline = Boolean(flags.inline);
  const fullscreen = !inline || Boolean(flags.fullscreenForced);
  return { useTui, inline, fullscreen };
}
