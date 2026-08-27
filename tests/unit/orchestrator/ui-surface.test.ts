import { describe, expect, it } from "bun:test";
import { resolveSurface } from "../../../packages/orchestrator/src/bin/ui/surface";

// The default-surface contract, pinned. Phase 03: there is exactly ONE TUI
// layout — the transcript lives in the terminal's own scrollback and only the
// composer is pinned. The alternate screen is gone, so no flag can ask for it.
describe("ui/surface resolveSurface", () => {
  it("defaults an interactive terminal to the one TUI layout", () => {
    expect(resolveSurface({ isTTY: true })).toEqual({ useTui: true, inline: true });
  });

  it("--classic opts into readline; --tui forces the TUI even past it", () => {
    expect(resolveSurface({ isTTY: true, classicForced: true }).useTui).toBe(false);
    expect(resolveSurface({ isTTY: true, classicForced: true, tuiForced: true }).useTui).toBe(true);
  });

  it("the retired alt-screen flags are accepted and ignored, never resurrecting it", () => {
    // Muscle memory and old aliases must not error, and must not get a second
    // surface back. Every combination resolves to the same single layout.
    for (const flags of [
      { isTTY: true, inline: true },
      { isTTY: true, fullscreenForced: true },
      { isTTY: true, inline: true, fullscreenForced: true },
    ]) {
      expect(resolveSurface(flags)).toEqual({ useTui: true, inline: true });
    }
  });

  it("a pipe gets no TUI regardless of flags", () => {
    expect(resolveSurface({ isTTY: false, tuiForced: true }).useTui).toBe(false);
    expect(resolveSurface({ isTTY: false, fullscreenForced: true }).useTui).toBe(false);
  });
});
