import { describe, expect, it } from "bun:test";
import { resolveSurface } from "../../../packages/orchestrator/src/bin/ui/surface";

// The default-surface contract, pinned: an interactive terminal with no flags
// gets the fullscreen alt-screen TUI. Everything else is an explicit opt-out.
describe("ui/surface resolveSurface", () => {
  it("defaults an interactive terminal to the fullscreen TUI", () => {
    expect(resolveSurface({ isTTY: true })).toEqual({
      useTui: true,
      inline: false,
      fullscreen: true,
    });
  });

  it("--classic opts into readline; --tui forces the TUI even past it", () => {
    expect(resolveSurface({ isTTY: true, classicForced: true }).useTui).toBe(false);
    expect(resolveSurface({ isTTY: true, classicForced: true, tuiForced: true }).useTui).toBe(true);
  });

  it("--inline keeps the TUI but leaves the alternate screen", () => {
    const choice = resolveSurface({ isTTY: true, inline: true });
    expect(choice).toEqual({ useTui: true, inline: true, fullscreen: false });
    // --fullscreen wins the tie when both are given.
    expect(resolveSurface({ isTTY: true, inline: true, fullscreenForced: true }).fullscreen).toBe(
      true,
    );
  });

  it("a pipe gets no TUI regardless of flags", () => {
    expect(resolveSurface({ isTTY: false, tuiForced: true }).useTui).toBe(false);
  });
});
