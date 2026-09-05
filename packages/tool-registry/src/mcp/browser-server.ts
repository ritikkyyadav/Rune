import type { McpServerConfig } from "./discovery";

// ─── Built-in browser server ───
// Rune's agent browser rides the MCP layer: when browser mode is on
// (`/browser on`, `[browser] enabled = true`, or --browser), the engine
// injects this spec as a built-in `browser` stdio server — merged BENEATH
// .rune/mcp.json, so a user entry named "browser" overrides it. It runs the
// official Playwright MCP (@playwright/mcp), which drives the browser through
// the accessibility tree: page reads come back as structured text snapshots,
// not screenshots, so they survive the text-only tool pipeline and stay
// token-bounded.
//
// Defaults are chosen for an agent, not a person: headless (no window steals
// focus), isolated (fresh profile — no cookies or logins leak in), and only
// the read-current-state tools auto-approved; anything that navigates,
// clicks, or types still goes through the permission broker. bunx fetches
// the package on first use (network) and caches it after that.

export const BROWSER_SERVER_NAME = "browser";

/** Playwright MCP tools that only READ the browser's current state. */
const READ_ONLY_BROWSER_TOOLS = [
  "browser_snapshot",
  "browser_console_messages",
  "browser_network_requests",
];

export interface BrowserServerOptions {
  /** Run headless (default true). */
  headless?: boolean;
  /** Browser: chromium (managed, default) | chrome | firefox | webkit | msedge. */
  browser?: string;
  /** Origins the browser may navigate to; everything else is blocked. */
  allowedOrigins?: string[];
  /** Origins the browser must never touch. */
  blockedOrigins?: string[];
}

export function buildBrowserServerSpec(options: BrowserServerOptions = {}): McpServerConfig {
  const args = ["@playwright/mcp@latest"];
  if (options.headless !== false) args.push("--headless");
  args.push("--isolated");
  // Default to Playwright's managed chromium rather than the `chrome` channel:
  // the channel requires Google Chrome to be installed at its well-known path,
  // which is an assumption about the user's machine. Managed chromium is
  // hermetic — `playwright install chromium` fetches it on machines without it
  // (the tool error names that exact command when it is missing).
  args.push("--browser", options.browser || "chromium");
  if (options.allowedOrigins && options.allowedOrigins.length > 0) {
    args.push("--allowed-origins", options.allowedOrigins.join(";"));
  }
  if (options.blockedOrigins && options.blockedOrigins.length > 0) {
    args.push("--blocked-origins", options.blockedOrigins.join(";"));
  }
  return { command: "bunx", args, autoApprove: [...READ_ONLY_BROWSER_TOOLS] };
}
