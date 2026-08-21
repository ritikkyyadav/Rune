import { afterEach, describe, expect, it } from "bun:test";
import {
  GEAR_AVATAR_LINES,
  GEAR_TOOTH_COUNT,
  renderBanner,
  wordmark,
} from "../../../packages/orchestrator/src/bin/ui/banner";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import * as os from "os";

// Hermetic: shortPath() collapses "~" only for paths under THIS machine's
// home directory — a hardcoded /Users/... fixture fails everywhere else.
const WORKSPACE = `${os.homedir()}/Projects/sample-app`;

const originalColumns = process.stdout.columns;

afterEach(() => {
  Object.defineProperty(process.stdout, "columns", {
    value: originalColumns,
    configurable: true,
  });
});

function banner(columns: number): string {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  return stripAnsi(
    renderBanner({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      version: "0.2.0",
      workspace: WORKSPACE,
      sandbox: true,
    }),
  );
}

describe("ui/banner", () => {
  it("renders the supplied nine-tooth Gear avatar and matching metadata lockup", () => {
    const output = banner(100);
    expect(GEAR_TOOTH_COUNT).toBe(9);
    expect(GEAR_AVATAR_LINES).toHaveLength(4);
    for (const line of GEAR_AVATAR_LINES) expect([...line]).toHaveLength(8);
    for (const line of GEAR_AVATAR_LINES) expect(output).toContain(line);
    expect(output).toContain("Gear  v0.2.0");
    expect(output).toContain("claude-sonnet-4-6 · /model to change");
    expect(output).toContain("~/Projects/sample-app");
    expect(output).toContain("sandbox on");
    expect(output).not.toContain("Ready to build.");
    expect(output).not.toContain("▄██▄▄██▄");
    expect(output).not.toContain("▄▟██▙▄");
  });

  it("falls back to a compact lockup without losing session context", () => {
    const output = banner(44);
    expect(output).toContain("⚙︎ Gear");
    expect(output).toContain("claude-sonnet-4-6");
    expect(output).toContain("~/Projects/sample-app");
    expect(output).not.toContain("Ready to build.");
    for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(44);
  });

  it("prefers the preset's model label and carries effort + environment badges", () => {
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    const output = stripAnsi(
      renderBanner({
        model: "gemini-2.5-flash",
        modelLabel: "Gemini 2.5 Flash",
        effort: "high",
        provider: "google",
        version: "0.2.0",
        workspace: WORKSPACE,
        sandbox: false,
        mcpServers: 2,
      }),
    );
    expect(output).toContain("Gemini 2.5 Flash · high effort · /model to change");
    expect(output).toContain("sandbox off");
    expect(output).toContain("MCP · 2 servers");
    for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("uses a text glyph rather than an emoji-font gear in the compact wordmark", () => {
    expect(stripAnsi(wordmark())).toBe("⚙︎ Gear");
  });
});
