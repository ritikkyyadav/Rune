import { describe, it, expect } from "vitest";
import { AltScreen } from "../../../packages/orchestrator/src/bin/ui/screen";

// Control sequences the renderer emits (kept in sync with screen.ts).
const HOME = "\x1b[H";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** AltScreen wired to a capturing writer so we can assert exactly what gets sent to the terminal. */
function harness() {
  const writes: string[] = [];
  const screen = new AltScreen((s) => writes.push(s));
  screen.enter();
  writes.length = 0; // drop the enter() sequence; we only care about frame() output
  return {
    screen,
    /** The most recent frame write. */
    last: () => writes[writes.length - 1] ?? "",
    writes,
  };
}

describe("ui/AltScreen differential renderer", () => {
  it("paints the first frame in full (HOME + every row)", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0);
    const out = h.last();
    expect(out).toContain(HOME);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("c");
    expect(out).toContain(SYNC_BEGIN);
    expect(out).toContain(SYNC_END);
  });

  it("rewrites only the rows that changed on the next frame", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0); // baseline
    h.screen.frame(["a", "X", "c"], 0, 0); // only row 2 (index 1) changed
    const out = h.last();
    // Row 2 is rewritten in place via absolute addressing…
    expect(out).toContain("\x1b[2;1HX");
    // …and the unchanged rows are NOT repainted, nor is the screen homed.
    expect(out).not.toContain(HOME);
    expect(out).not.toContain("a");
    expect(out).not.toContain("c");
    // Still wrapped in a synchronized update.
    expect(out).toContain(SYNC_BEGIN);
    expect(out).toContain(SYNC_END);
  });

  it("moves the cursor without repainting any row when only the caret changes", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0);
    h.screen.frame(["a", "b", "c"], 1, 2); // identical rows, caret moved
    const out = h.last();
    expect(out).toContain("\x1b[2;3H"); // caret placed at row 2, col 3 (1-based)
    expect(out).not.toContain(HOME);
    expect(out).not.toContain("\x1b[1;1Ha"); // no row rewrites
  });

  it("forces a full repaint when the row count changes", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0);
    h.screen.frame(["a", "b", "c", "d"], 0, 0); // 3 → 4 rows
    const out = h.last();
    expect(out).toContain(HOME);
    expect(out).toContain("d");
    expect(out).toContain("a"); // full repaint re-emits every row
  });

  it("forces a full repaint after invalidate(), even with identical rows", () => {
    const h = harness();
    h.screen.frame(["a", "b"], 0, 0);
    h.screen.invalidate();
    h.screen.frame(["a", "b"], 0, 0);
    const out = h.last();
    expect(out).toContain(HOME);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("emits nothing once exited", () => {
    const h = harness();
    h.screen.exit();
    h.writes.length = 0;
    h.screen.frame(["a", "b"], 0, 0);
    expect(h.writes.length).toBe(0);
  });

  it("hardware-scrolls the band (and paints only the exposed line) on a downward shift", () => {
    const h = harness();
    h.screen.frame(["HDR", "a1", "a2", "a3", "a4", "CMP"], 0, 0); // baseline (band = rows 1..4)
    // A new line entered at the top: content shifts DOWN by 1 → delta = +1.
    h.screen.frame(["HDR", "NEW", "a1", "a2", "a3", "CMP"], 0, 0, { top: 1, bottom: 4, delta: 1 });
    const out = h.last();
    expect(out).toContain("\x1b[2;5r"); // DECSTBM scroll region = band (rows 2..5, 1-based)
    expect(out).toContain("\x1b[1T"); // SD: scroll the region down by 1
    expect(out).toContain("\x1b[r"); // reset the scroll region
    expect(out).toContain("\x1b[2;1HNEW"); // only the freshly exposed top line is painted
    expect(out).not.toContain("a1"); // shifted lines are NOT repainted (the terminal moved them)
    expect(out).not.toContain("CMP"); // composer/banner untouched
  });

  it("hardware-scrolls the band on an upward shift (streaming / scroll toward newer)", () => {
    const h = harness();
    h.screen.frame(["HDR", "a1", "a2", "a3", "a4", "CMP"], 0, 0);
    // A new line entered at the bottom: content shifts UP by 1 → delta = -1.
    h.screen.frame(["HDR", "a2", "a3", "a4", "NEW", "CMP"], 0, 0, { top: 1, bottom: 4, delta: -1 });
    const out = h.last();
    expect(out).toContain("\x1b[2;5r");
    expect(out).toContain("\x1b[1S"); // SU: scroll the region up by 1
    expect(out).toContain("\x1b[5;1HNEW"); // only the exposed bottom line is painted
    expect(out).not.toContain("a2");
  });

  it("falls back to a per-row diff when the proposed shift does not actually match", () => {
    const h = harness();
    h.screen.frame(["HDR", "a1", "a2", "a3", "a4", "CMP"], 0, 0);
    // Claim a scroll, but the content is entirely different — not a clean shift.
    h.screen.frame(["HDR", "b1", "b2", "b3", "b4", "CMP"], 0, 0, { top: 1, bottom: 4, delta: 1 });
    const out = h.last();
    expect(out).not.toContain("\x1b[2;5r"); // no region scroll emitted
    expect(out).not.toContain("\x1b[1T");
    expect(out).toContain("b1"); // rows repainted directly instead
    expect(out).toContain("b4");
  });
});
