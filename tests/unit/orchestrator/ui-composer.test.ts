import { describe, it, expect } from "vitest";
import {
  renderComposer,
  renderPicker,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

describe("ui/composer renderComposer", () => {
  it("renders a 4-line block with a uniform-width box and caret on the input row", () => {
    const r = renderComposer({ input: "hello", caret: 5, width: 80, status: "  status" });
    expect(r.lines).toHaveLength(4); // top, input, bottom, status
    const box = r.lines.slice(0, 3).map((l) => stripAnsi(l).length);
    expect(new Set(box).size).toBe(1); // top/mid/bottom equal width
    expect(r.caretRow).toBe(1);
    expect(r.caretCol).toBe(11); // 6 chrome cols + caret index 5
  });

  it("never produces a line at or beyond the terminal width (no auto-wrap)", () => {
    const r = renderComposer({ input: "x".repeat(500), caret: 500, width: 80, status: "  s" });
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(80);
  });

  it("horizontally scrolls to keep a far caret visible", () => {
    const r = renderComposer({ input: "x".repeat(200), caret: 200, width: 60, status: "  s" });
    // caret column stays inside the box, not off-screen
    expect(r.caretCol).toBeLessThan(60);
    expect(r.caretCol).toBeGreaterThan(5);
  });

  it("shows a working indicator instead of the box when set", () => {
    const r = renderComposer({
      input: "",
      caret: 0,
      width: 80,
      status: "  s",
      working: "• Working (3s · esc to interrupt)",
    });
    expect(r.lines).toHaveLength(2);
    expect(stripAnsi(r.lines[0])).toContain("Working");
    expect(r.caretRow).toBe(0);
  });
});

describe("ui/composer renderPicker", () => {
  it("marks the selected row and includes a hint footer", () => {
    const r = renderPicker(
      "Model",
      [{ label: "Gemini 2.5 Flash" }, { label: "Gemini 2.5 Pro" }],
      1,
      80,
    );
    expect(stripAnsi(r.lines[0])).toContain("Model");
    expect(stripAnsi(r.lines[2])).toContain("❯"); // selected = index 1 → line 2
    expect(stripAnsi(r.lines[1])).not.toContain("❯");
    expect(stripAnsi(r.lines.at(-1)!)).toContain("enter confirm");
    expect(r.caretRow).toBe(2);
  });
});
