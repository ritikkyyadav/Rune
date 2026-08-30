import { describe, expect, it } from "bun:test";
import { resolveSurface } from "../../../packages/orchestrator/src/bin/ui/surface";

// The default-surface contract, pinned. There are TWO TUI layouts and the
// DEFAULT is the fixed-chrome one: header pinned to the top rows, composer
// pinned to the bottom rows, and only the transcript between them scrolling.
// `--inline` is the opt-out for anyone who wants the terminal's own scrollback
// back, and it is the only way to get it.
describe("ui/surface resolveSurface", () => {
  it("defaults an interactive terminal to the fixed-chrome layout", () => {
    expect(resolveSurface({ isTTY: true })).toEqual({ useTui: true, inline: false });
  });

  it("--classic opts into readline; --tui forces the TUI even past it", () => {
    expect(resolveSurface({ isTTY: true, classicForced: true }).useTui).toBe(false);
    expect(resolveSurface({ isTTY: true, classicForced: true, tuiForced: true }).useTui).toBe(true);
  });

  it("--inline is the only way to the legacy native-scrollback layout", () => {
    expect(resolveSurface({ isTTY: true, inline: true })).toEqual({ useTui: true, inline: true });
  });

  it("--fullscreen names the default and never contradicts an explicit --inline", () => {
    // Muscle memory and old aliases must not error, and must not silently
    // override the one flag the user typed on purpose.
    expect(resolveSurface({ isTTY: true, fullscreenForced: true })).toEqual({
      useTui: true,
      inline: false,
    });
    expect(resolveSurface({ isTTY: true, inline: true, fullscreenForced: true })).toEqual({
      useTui: true,
      inline: true,
    });
  });

  it("a pipe gets no TUI regardless of flags", () => {
    expect(resolveSurface({ isTTY: false, tuiForced: true }).useTui).toBe(false);
    expect(resolveSurface({ isTTY: false, fullscreenForced: true }).useTui).toBe(false);
  });
});
