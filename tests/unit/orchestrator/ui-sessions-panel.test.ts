import { describe, it, expect } from "vitest";
import {
  renderSessionsPanel,
  type SessionRowView,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

function rows(n: number): SessionRowView[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `session ${i + 1}`,
    meta: `${i + 1}h ago · model-x`,
    current: false,
  }));
}

describe("ui/composer renderSessionsPanel", () => {
  it("renders a heading, one line per session, and a footer hint", () => {
    const r = renderSessionsPanel(rows(3), 0, { view: "active", pendingDelete: false }, 80);
    const plain = r.lines.map(stripAnsi);
    expect(plain[0]).toContain("Sessions");
    expect(plain.some((l) => l.includes("session 1"))).toBe(true);
    expect(plain.some((l) => l.includes("session 3"))).toBe(true);
    expect(plain[plain.length - 1]).toContain("resume");
  });

  it("marks the selected row with a caret and parks the caret on it", () => {
    const r = renderSessionsPanel(rows(4), 2, { view: "active", pendingDelete: false }, 80);
    // header is row 0; selection index 2 → caretRow 3
    expect(r.caretRow).toBe(3);
    expect(stripAnsi(r.lines[3])).toContain("❯");
  });

  it("shows an empty state with no rows", () => {
    const r = renderSessionsPanel([], 0, { view: "active", pendingDelete: false }, 80);
    const plain = r.lines.map(stripAnsi).join("\n");
    expect(plain).toContain("No sessions yet");
  });

  it("windows a long list to at most 12 visible rows + a range note", () => {
    const r = renderSessionsPanel(rows(50), 40, { view: "active", pendingDelete: false }, 80);
    const plain = r.lines.map(stripAnsi);
    // 1 heading + 12 rows + 1 range note + 1 footer = 15 lines max
    expect(r.lines.length).toBeLessThanOrEqual(15);
    expect(plain.some((l) => l.includes("of 50"))).toBe(true);
    // selection (index 40) stays visible within the window
    expect(plain.some((l) => l.includes("session 41"))).toBe(true);
  });

  it("swaps in a confirm hint while a delete is armed", () => {
    const r = renderSessionsPanel(rows(2), 0, { view: "active", pendingDelete: true }, 80);
    expect(stripAnsi(r.lines[r.lines.length - 1])).toContain("press d again to delete");
  });

  it("offers restore (not archive) in the archived view", () => {
    const r = renderSessionsPanel(rows(2), 0, { view: "archived", pendingDelete: false }, 80);
    const footer = stripAnsi(r.lines[r.lines.length - 1]);
    expect(footer).toContain("restore");
    expect(footer).not.toContain("archive");
  });

  it("flags the active session with a filled dot", () => {
    const r = renderSessionsPanel(
      [
        { title: "old", meta: "1d ago", current: false },
        { title: "live", meta: "now", current: true },
      ],
      0,
      { view: "active", pendingDelete: false },
      80,
    );
    const liveLine = r.lines.map(stripAnsi).find((l) => l.includes("live"))!;
    expect(liveLine).toContain("●");
  });
});
