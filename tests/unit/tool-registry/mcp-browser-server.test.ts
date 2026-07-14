import { describe, expect, test } from "bun:test";
import {
  BROWSER_SERVER_NAME,
  buildBrowserServerSpec,
} from "../../../packages/tool-registry/src/mcp/index";

describe("built-in browser server spec", () => {
  test("defaults: bunx + @playwright/mcp, headless, isolated chromium, read-only autoApprove", () => {
    const spec = buildBrowserServerSpec();
    expect(BROWSER_SERVER_NAME).toBe("browser");
    expect(spec.command).toBe("bunx");
    expect(spec.args?.[0]).toBe("@playwright/mcp@latest");
    expect(spec.args).toContain("--headless");
    expect(spec.args).toContain("--isolated");
    // Managed chromium, not the `chrome` channel: the channel hard-requires
    // Google Chrome on the machine; chromium is hermetic.
    const args = spec.args ?? [];
    expect(args[args.indexOf("--browser") + 1]).toBe("chromium");
    expect(spec.autoApprove).toEqual([
      "browser_snapshot",
      "browser_console_messages",
      "browser_network_requests",
    ]);
  });

  test("headed mode drops --headless but keeps isolation", () => {
    const spec = buildBrowserServerSpec({ headless: false });
    expect(spec.args).not.toContain("--headless");
    expect(spec.args).toContain("--isolated");
  });

  test("channel and origin policies map to Playwright MCP flags", () => {
    const spec = buildBrowserServerSpec({
      browser: "firefox",
      allowedOrigins: ["https://a.dev", "https://b.dev"],
      blockedOrigins: ["https://evil.example"],
    });
    const args = spec.args ?? [];
    expect(args[args.indexOf("--browser") + 1]).toBe("firefox");
    expect(args[args.indexOf("--allowed-origins") + 1]).toBe("https://a.dev;https://b.dev");
    expect(args[args.indexOf("--blocked-origins") + 1]).toBe("https://evil.example");
  });

  test("empty origin lists emit no flags", () => {
    const args = buildBrowserServerSpec({ allowedOrigins: [], blockedOrigins: [] }).args ?? [];
    expect(args).not.toContain("--allowed-origins");
    expect(args).not.toContain("--blocked-origins");
  });
});
