import { describe, it, expect } from "vitest";
import {
  visLen,
  truncate,
  wrap,
  box,
  kv,
  bar,
  bullet,
  connector,
} from "../../../packages/orchestrator/src/bin/ui/render";
import { stripAnsi, info, faint, text, muted } from "../../../packages/orchestrator/src/bin/ui/theme";

describe("ui/render primitives", () => {
  it("visLen ignores ANSI escapes", () => {
    expect(visLen("abc")).toBe(3);
    expect(visLen(info("abc"))).toBe(3);
  });

  it("truncate clamps to visible width with an ellipsis", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(stripAnsi(truncate("hello world", 5)).length).toBe(5);
  });

  it("wrap breaks on word boundaries within width", () => {
    expect(wrap("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
    expect(wrap("", 10)).toEqual([""]);
  });

  it("box frames content with matching corners and uniform width", () => {
    const lines = stripAnsi(box(["hello", "a longer line here"])).split("\n");
    expect(lines).toHaveLength(4); // top + 2 content + bottom
    expect(lines[0].trimStart().startsWith("╭")).toBe(true);
    expect(lines[0].trimEnd().endsWith("╮")).toBe(true);
    expect(lines[3].trimStart().startsWith("╰")).toBe(true);
    expect(lines[3].trimEnd().endsWith("╯")).toBe(true);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1); // every row is the same visible width
  });

  it("box stays uniform with colored, nested, and non-ASCII content (status-card shapes)", () => {
    const rows = [
      `${faint(">_")} ${text("Alan")}  ${muted("(v0.1.0)")}`,
      "",
      `${muted("Model".padEnd(12))}  ${info("gemini-2.5-flash")}`,
      `${muted("Permissions".padEnd(12))}  ${text("confirm · on-request")}`,
      `${muted("Session".padEnd(12))}  ${text("019e78aa")}`,
      `${muted("Cost".padEnd(12))}  ${text("$0.0234")}`,
    ];
    const lines = stripAnsi(box(rows)).split("\n");
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("box supports square corners", () => {
    const top = stripAnsi(box(["x"], { rounded: false })).split("\n")[0];
    expect(top.includes("┌")).toBe(true);
    expect(top.includes("┐")).toBe(true);
  });

  it("kv aligns labels to a common width", () => {
    const rows = kv([
      ["model", "gemini"],
      ["directory", "~/x"],
    ]);
    const plain = rows.map(stripAnsi);
    // label column padded to the longest label ("directory" = 9) + 2 spaces
    expect(plain[0]).toBe("model      gemini");
    expect(plain[1]).toBe("directory  ~/x");
  });

  it("bar reflects the fraction and total width", () => {
    const half = stripAnsi(bar(0.5, 10));
    expect(half).toBe("[█████░░░░░]");
    expect(stripAnsi(bar(0, 4))).toBe("[░░░░]");
    expect(stripAnsi(bar(1, 4))).toBe("[████]");
    expect(stripAnsi(bar(2, 4))).toBe("[████]"); // clamped
  });

  it("bullet and connector use the expected glyphs", () => {
    expect(stripAnsi(bullet("Ran"))).toBe("  • Ran");
    expect(stripAnsi(connector("output"))).toBe("  └ output");
    const withSub = stripAnsi(connector("head", { sub: ["a", "b"] })).split("\n");
    expect(withSub).toEqual(["  └ head", "    a", "    b"]);
  });
});
