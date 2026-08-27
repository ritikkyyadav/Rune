import { describe, it, expect } from "bun:test";
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
  it("renders the Gear timeline header, two-row session cards, search, and actions", () => {
    const r = renderSessionsPanel(rows(3), 0, { view: "active", pendingDelete: false }, 80);
    const plain = r.lines.map(stripAnsi);
    expect(plain[0]).toContain("Sessions");
    expect(plain[0]).not.toContain("◉");
    expect(plain[1]).toContain("Search");
    expect(plain.some((l) => l.includes("session 1"))).toBe(true);
    expect(plain.some((l) => l.includes("session 3"))).toBe(true);
    expect(plain[plain.length - 1]).toContain("resume");
  });

  it("marks the selected row with a caret and parks the caret on it", () => {
    const r = renderSessionsPanel(rows(4), 2, { view: "active", pendingDelete: false }, 80);
    expect(stripAnsi(r.lines[r.caretRow])).toContain("›");
    expect(stripAnsi(r.lines[r.caretRow])).toContain("session 3");
  });

  it("shows an empty state with no rows", () => {
    const r = renderSessionsPanel([], 0, { view: "active", pendingDelete: false }, 80);
    const plain = r.lines.map(stripAnsi).join("\n");
    expect(plain).toContain("No sessions yet");
  });

  it("windows a long list to at most 12 two-row cards + a range note", () => {
    const r = renderSessionsPanel(rows(50), 40, { view: "active", pendingDelete: false }, 80);
    const plain = r.lines.map(stripAnsi);
    // heading + search + hairline + 12 two-row cards + range note + footer
    expect(r.lines.length).toBeLessThanOrEqual(29);
    expect(plain.some((l) => l.includes("of 50"))).toBe(true);
    // selection (index 40) stays visible within the window
    expect(plain.some((l) => l.includes("session 41"))).toBe(true);
  });

  it("keeps heading, selection, range, and actions visible in a short terminal", () => {
    const r = renderSessionsPanel(rows(50), 40, { view: "active", pendingDelete: false }, 40, 8);
    const plain = r.lines.map(stripAnsi);
    expect(r.lines.length).toBeLessThanOrEqual(8);
    expect(plain[0]).toContain("Sessions");
    expect(plain.some((line) => line.includes("session 41"))).toBe(true);
    expect(plain.at(-1)).toContain("resume");
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

  it("shows chronological groups, paths, and the live search query", () => {
    const r = renderSessionsPanel(
      [
        {
          id: "abcdef123456",
          title: "polish composer",
          meta: "18 events · model-x",
          workspace: "/tmp/gear",
          updatedAt: "2026-08-20T09:30:00Z",
          group: "Today",
          current: true,
        },
      ],
      0,
      { view: "active", pendingDelete: false, query: "composer", searching: true },
      100,
    );
    const plain = r.lines.map(stripAnsi).join("\n");
    expect(plain).toContain("composer");
    expect(plain).toContain("today");
    expect(plain).toContain("abcdef12");
    // The row shows the project, not the whole path: every row in a session
    // list tends to share a parent, so the parent is the part that carries no
    // information. Search still matches the full path.
    expect(plain).toContain("gear");
    expect(plain).not.toContain("/tmp/gear");
  });
});
