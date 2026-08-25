import { afterEach, describe, expect, it } from "bun:test";
import { renderBanner, wordmark } from "../../../packages/orchestrator/src/bin/ui/banner";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import * as os from "os";

// Hermetic: the header names the folder you are in, not the whole path — but
// the workspace still has to exist under THIS machine's home for the branch and
// dirty-file probes to behave the same everywhere.
const WORKSPACE = `${os.homedir()}/Projects/sample-app`;

const originalColumns = process.stdout.columns;

afterEach(() => {
  Object.defineProperty(process.stdout, "columns", {
    value: originalColumns,
    configurable: true,
  });
});

function banner(columns: number, extra: Record<string, unknown> = {}): string {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  return stripAnsi(
    renderBanner({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      version: "0.2.0",
      workspace: WORKSPACE,
      branch: "main",
      dirtyFiles: 0,
      sandbox: true,
      scope: "1st gear",
      caution: "every action asks first",
      ...extra,
    }),
  );
}

describe("ui/banner", () => {
  it("opens with a rule, where you are, and what the agent may do — and no logo", () => {
    const output = banner(100);
    const lines = output.split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^──── gear 0\.2\.0 ─+$/);
    expect(lines[1]).toBe("  sample-app · main");
    expect(lines[2]).toBe("  claude-sonnet-4-6 · 1st gear — every action asks first");
    expect(lines[3]).toMatch(/^─+$/);
    // Nothing decorative survives: no mark, no avatar, no wordmark, no tagline.
    expect(output).not.toContain("⚙");
    expect(output).not.toContain("⣴");
    expect(output).not.toContain("Ready to build.");
  });

  it("states the tree's real shape and any guardrail that has been removed", () => {
    const output = banner(100, { dirtyFiles: 3, sandbox: false, mcpServers: 2 });
    expect(output).toContain("sample-app · main · 3 files changed · sandbox off · mcp 2");
  });

  it("prefers the preset's model label and carries the effort dial", () => {
    const output = banner(100, { modelLabel: "Gemini 2.5 Flash", effort: "high" });
    expect(output).toContain("Gemini 2.5 Flash · high effort · 1st gear");
    expect(output).not.toContain("gemini-2.5-flash");
  });

  it("rules span the window; content stays in the reading column", () => {
    for (const columns of [44, 60, 100, 220]) {
      const lines = banner(columns)
        .split("\n")
        .filter((line) => line.trim());
      // The two rules divide the whole surface…
      for (const rule of [lines[0]!, lines.at(-1)!]) {
        expect(rule).toMatch(/─$/);
        expect(rule.length).toBeGreaterThanOrEqual(Math.min(120, columns) - 1);
      }
      // …while every line still stays inside the window, never touching its
      // last cell (a full-width line wraps, and a wrap desyncs the composer).
      for (const line of lines) expect(line.length).toBeLessThan(columns);
    }
  });

  it("uses a text glyph rather than an emoji-font gear in the compact wordmark", () => {
    expect(stripAnsi(wordmark())).toBe("⚙︎ Gear");
  });
});
