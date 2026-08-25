/**
 * clampVisible — the last line of defense for the pinned-region contract:
 * a styled line must never exceed the terminal width, or it auto-wraps, breaks
 * the region's cursor math, and every repaint leaks stale rows into scrollback.
 */

import { describe, it, expect } from "bun:test";
import { clampVisible, visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { renderToolActivity } from "../../../packages/orchestrator/src/bin/ui/activity";

describe("clampVisible", () => {
  it("passes short lines through untouched", () => {
    expect(clampVisible("hello", 10)).toBe("hello");
  });

  it("cuts by VISIBLE width, not raw length, and keeps styling", () => {
    const styled = `\x1b[1m\x1b[38;2;10;20;30m${"x".repeat(50)}\x1b[0m`;
    const out = clampVisible(styled, 20);
    expect(stripAnsi(out).length).toBeLessThanOrEqual(20);
    expect(out).toContain("\x1b[1m"); // styling preserved
    expect(out.endsWith("\x1b[0m")).toBe(true); // never bleeds
    expect(stripAnsi(out).endsWith("…")).toBe(true);
  });

  it("a mid-line style change survives the cut", () => {
    const styled = `plain \x1b[31m${"r".repeat(30)}\x1b[0m tail`;
    const out = clampVisible(styled, 12);
    expect(stripAnsi(out).length).toBeLessThanOrEqual(12);
  });

  it("exact-width lines are not ellipsized", () => {
    expect(stripAnsi(clampVisible("abcde", 5))).toBe("abcde");
  });

  it("never splits CJK, combining marks, or joined emoji", () => {
    const styled = `\x1b[36m界面👩🏽‍💻e\u0301tail\x1b[0m`;
    const out = clampVisible(styled, 8);
    expect(stripAnsi(out)).toBe("界面👩🏽‍💻e\u0301…");
    expect(visLen(out)).toBe(8);
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  it("tool failure lines stay inside the terminal width", () => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    try {
      const line = renderToolActivity({
        toolName: "web_fetch",
        args: {
          url: "https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard.min.js",
        },
        result: "",
        success: false,
        error:
          "Egress blocked: https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard.min.js — network access is disabled for this tool in this workspace",
      });
      for (const ln of line.split("\n")) {
        expect(visLen(ln)).toBeLessThanOrEqual(100);
      }
      // The URL (not raw JSON) names the target.
      expect(stripAnsi(line)).toContain("https://cdnjs.cloudflare.com");
      expect(stripAnsi(line)).not.toContain('{"url"');
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: prev, configurable: true });
    }
  });

  it("todo_write and bash_output render as quiet verbs, never raw JSON", () => {
    const todo = stripAnsi(
      renderToolActivity({
        toolName: "todo_write",
        args: {
          items: [
            { content: "a", status: "pending" },
            { content: "b", status: "pending" },
          ],
        },
        result: "{}",
        success: true,
      }),
    );
    expect(todo).toContain("plan  updated");
    expect(todo).toContain("2 steps");
    expect(todo).not.toContain('{"items"');

    const shell = stripAnsi(
      renderToolActivity({
        toolName: "bash_output",
        args: { shell_id: "shell_1" },
        result: "{}",
        success: true,
      }),
    );
    expect(shell).toContain("poll  shell_1");
    expect(shell).not.toContain('{"shell_id"');
  });
});
