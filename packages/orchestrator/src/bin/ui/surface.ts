// --- Surface choice: which terminal UI a launch gets ---
// Extracted pure so the DEFAULT is pinned by a test, not by folklore.
//
// Phase 03 collapsed two surfaces into one. Gear used to open on the ALTERNATE
// screen by default, repainting the whole viewport each frame to paint a theme
// background edge-to-edge. That bought a cohesive window on terminals which
// ignore OSC 11 (Warp) and cost, in exchange: native scrollback, native
// momentum scrolling, ⌘F, mouse selection, `| tee`, and — most visibly — an
// empty session rendered as forty rows of painted nothing, because a program
// that owns every cell has to fill every cell.
//
// None of that was worth a background colour, and the design forbids setting a
// background anyway. So: one surface. The transcript is committed into ordinary
// scrollback that the terminal owns, and Gear pins only the composer to the
// bottom rows. `--classic` still opts into the plain readline printer, and a
// pipe still gets no TUI at all.
//
// `--fullscreen` / GEAR_FULLSCREEN are accepted and ignored, so a muscle-memory
// invocation or an old alias does not error out.

export interface SurfaceFlags {
  isTTY: boolean;
  /** --tui: force the pinned-composer TUI even when --classic is also set. */
  tuiForced?: boolean;
  /** --classic: the plain readline printer path. */
  classicForced?: boolean;
  /** --inline / GEAR_INLINE: now the only TUI layout; accepted as a no-op. */
  inline?: boolean;
  /** --fullscreen / GEAR_FULLSCREEN: retired with the alt screen. Ignored. */
  fullscreenForced?: boolean;
}

export interface SurfaceChoice {
  useTui: boolean;
  /** Always true when the TUI runs — there is no other layout. */
  inline: boolean;
}

export function resolveSurface(flags: SurfaceFlags): SurfaceChoice {
  const useTui = flags.isTTY && (Boolean(flags.tuiForced) || !flags.classicForced);
  return { useTui, inline: true };
}
