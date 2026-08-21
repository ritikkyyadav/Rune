// ─── Gear identity header ───
// Terminal-native transcription of the header in docs/design/gear-customizer-v2.html. The
// browser comp uses a 48px SVG beside three metadata rows and two environment
// badges. A four-row Braille raster preserves the reference mark's detail in a
// real monospace terminal; the compact fallback keeps U+2699 for narrow
// viewports.
//
//   ⣴⣦⣽⣯⣴⣦    Gear  v0.2.0
//  ⣶⣾⡿⠋⠙⢿⣷⣶   Gemini 2.5 Flash · high effort · /model to change
//  ⢠⣿⣷⣄⣠⣾⣿⡄   ~/Projects/Alan · main                sandbox on  MCP · 2 servers
//  ⠈⠉⢿⡟⢻⡿⠉⠁

import * as os from "os";
import { execFileSync } from "child_process";
import { bold, text, muted, faint, brand, chip } from "./theme";
import { truncate, termWidth, visLen } from "./render";
import { PRODUCT_NAME } from "./brand";

/** Explicit text presentation. Never use the coloured emoji gear here. */
export const GEAR_MARK = "⚙︎";

/** The supplied Gear mark has exactly nine teeth. */
export const GEAR_TOOTH_COUNT = 9;

/**
 * Faithful 16×16 terminal raster of the supplied nine-tooth mark. Each Braille
 * cell carries a 2×4 dot matrix, so this 8×4-cell lockup stays square at a
 * conventional 2:1 terminal-cell ratio while retaining the open circular hub.
 */
export const GEAR_AVATAR_LINES = [" ⣴⣦⣽⣯⣴⣦ ", "⣶⣾⡿⠋⠙⢿⣷⣶", "⢠⣿⣷⣄⣠⣾⣿⡄", "⠈⠉⢿⡟⢻⡿⠉⠁"] as const;

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface BannerOptions {
  /** Model id (shown when no display label is known). */
  model: string;
  /** Human model label from the provider preset ("Gemini 2.5 Flash"). */
  modelLabel?: string;
  provider?: string;
  /** Reasoning effort passed to providers with an effort dial ("high"). */
  effort?: string;
  version: string;
  workspace: string;
  branch?: string;
  sessionId?: string;
  /** OS command sandbox state → the `sandbox on` / `sandbox off` badge. */
  sandbox?: boolean;
  /** Connected MCP servers → the `MCP · N servers` badge (hidden at 0). */
  mcpServers?: number;
  /** Kept for call-site back-compat; unused by the banner. */
  recentSessions?: unknown[];
}

const branchCache = new Map<string, string>();

/** Resolve once per workspace. Banner rendering happens every frame. */
function workspaceBranch(workspace: string): string {
  const cached = branchCache.get(workspace);
  if (cached != null) return cached;
  let branch = "";
  try {
    branch = execFileSync("git", ["-C", workspace, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 400,
    }).trim();
  } catch {
    branch = "";
  }
  branchCache.set(workspace, branch);
  return branch;
}

/** Compact lockup used when the full four-row mark would crowd the terminal. */
export function wordmark(): string {
  return `${brand(GEAR_MARK)} ${bold(text(PRODUCT_NAME))}`;
}

/** The v2 environment badges: sandbox posture (a removed guardrail stays loud)
 *  and the MCP server count. Returned pre-painted, widest first. */
export function bannerBadges(opts: Pick<BannerOptions, "sandbox" | "mcpServers">): string[] {
  const badges: string[] = [];
  if (opts.sandbox === true) badges.push(chip("ok", " sandbox on "));
  else if (opts.sandbox === false) badges.push(bold(chip("accent", " sandbox off ")));
  if (opts.mcpServers && opts.mcpServers > 0) {
    badges.push(
      chip("muted", ` MCP · ${opts.mcpServers} ${opts.mcpServers === 1 ? "server" : "servers"} `),
    );
  }
  return badges;
}

export function renderBanner(opts: BannerOptions): string {
  const width = termWidth();
  const available = Math.max(12, width - 4);
  const dir = shortPath(opts.workspace);
  const branch = opts.branch ?? workspaceBranch(opts.workspace);
  const location = [dir, branch].filter(Boolean).join(" · ");
  const modelName = opts.modelLabel || opts.model;
  const effort = opts.effort ? `${opts.effort} effort` : "";
  const badges = bannerBadges(opts);

  if (width < 48) {
    return [
      "",
      `  ${wordmark()}  ${faint("v" + opts.version)}`,
      `  ${muted(truncate([modelName, effort].filter(Boolean).join(" · "), available))}`,
      `  ${faint(truncate(location, available))}`,
      ...(badges.length ? [`  ${badges.join(" ")}`] : []),
      "",
    ].join("\n");
  }

  // 2-col inset + 8-col avatar + 3-col gap = 13 columns before metadata.
  const metaWidth = Math.max(18, width - 13);
  const modelLink = "/model to change";
  const runtimeWidth = Math.max(
    10,
    metaWidth - modelLink.length - 3 - (effort ? effort.length + 3 : 0),
  );
  const runtime =
    `${text(truncate(modelName, runtimeWidth))}` +
    (effort ? ` ${faint("·")} ${muted(effort)}` : "") +
    ` ${faint("·")} ${brand(modelLink)}`;
  const badgeRow = badges.join(" ");
  const badgeCells = visLen(badgeRow);
  // Badges sit at the right edge of the location row when they fit beside it.
  const locationWidth = badgeCells > 0 ? metaWidth - badgeCells - 2 : metaWidth;
  const locationShown = muted(truncate(location, Math.max(10, locationWidth)));
  const fits = badgeCells > 0 && locationWidth >= 18;
  const gap = fits
    ? " ".repeat(Math.max(2, metaWidth - visLen(locationShown) - badgeCells - 1))
    : "";
  return [
    "",
    `  ${brand(GEAR_AVATAR_LINES[0])}   ${bold(text(PRODUCT_NAME))}  ${faint("v" + opts.version)}`,
    `  ${brand(GEAR_AVATAR_LINES[1])}   ${runtime}`,
    `  ${brand(GEAR_AVATAR_LINES[2])}   ${locationShown}${fits ? gap + badgeRow : ""}`,
    `  ${brand(GEAR_AVATAR_LINES[3])}${!fits && badgeCells > 0 ? "   " + badgeRow : ""}`,
    "",
  ].join("\n");
}
