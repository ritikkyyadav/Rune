import { describe, expect, it } from "bun:test";
import { resolveSurface } from "../../../packages/orchestrator/src/bin/ui/surface";

// The default-surface contract, pinned. There are TWO TUI layouts and the
// DEFAULT is the FIXED frame (2026-09-05 evening, the founder's choice after a
// day on inline): header pinned to the top rows, composer pinned to the bottom
// rows, the transcript the only thing that scrolls. The inline layout (the
// transcript in the terminal's own scrollback, composer trailing it) is the
// opt-out, reached only with --inline / RUNE_INLINE.
describe("ui/surface resolveSurface", () => {
  it("defaults an interactive terminal to the fixed frame (pinned header + footer)", () => {
    expect(resolveSurface({ isTTY: true })).toEqual({ useTui: true, inline: false });
  });

  it("--classic opts into readline; --tui forces the TUI even past it", () => {
    expect(resolveSurface({ isTTY: true, classicForced: true }).useTui).toBe(false);
    expect(resolveSurface({ isTTY: true, classicForced: true, tuiForced: true }).useTui).toBe(true);
  });

  it("--inline is the only way to the native-scrollback layout", () => {
    expect(resolveSurface({ isTTY: true, inline: true })).toEqual({ useTui: true, inline: true });
  });

  it("--fullscreen names the default and wins over --inline", () => {
    expect(resolveSurface({ isTTY: true, fullscreenForced: true })).toEqual({
      useTui: true,
      inline: false,
    });
    // The user asked for the frame by name; that beats the opt-out.
    expect(resolveSurface({ isTTY: true, inline: true, fullscreenForced: true })).toEqual({
      useTui: true,
      inline: false,
    });
  });

  it("a pipe gets no TUI regardless of flags", () => {
    expect(resolveSurface({ isTTY: false, tuiForced: true }).useTui).toBe(false);
    expect(resolveSurface({ isTTY: false, fullscreenForced: true }).useTui).toBe(false);
  });
});
