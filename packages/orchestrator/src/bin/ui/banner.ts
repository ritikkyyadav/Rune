// ─── Alan Startup Banner ───
// The Savoir lockup: the wordmark with its block cursor, the tagline, and a
// quiet readout of model + directory. No frame — the identity is the cursor,
// not a box. ("Know-how, set down.")

import * as os from "os";
import { bold, text, muted, faint, info, ok, warn } from "./theme";
import { PRODUCT_NAME } from "./brand";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface BannerOptions {
  model: string;
  provider?: string;
  version: string;
  workspace: string;
  sessionId?: string;
  /** OS command sandbox state. Only the OFF case is shown (a removed safety
   *  layer, worth a loud startup line); ON is the default and stays quiet. */
  sandbox?: boolean;
  /** Kept for call-site back-compat; unused by the banner. */
  recentSessions?: unknown[];
}

/** The loud one-liner shown at startup when the OS sandbox is disabled. Mirrors
 *  the way Hands-Free announces itself — a removed guardrail should be visible. */
function sandboxOffLine(): string {
  return `  ${bold(warn("▲ sandbox off"))} ${faint("·")} ${muted("commands run with full host & network access")}`;
}

/** The wordmark: `Berne▮` — bold name, signal-teal block cursor. */
export function wordmark(): string {
  return `${bold(text(PRODUCT_NAME))}${ok("▮")}`;
}

export function renderBanner(opts: BannerOptions): string {
  const termWidth = process.stdout.columns || 80;
  const dir = shortPath(opts.workspace);

  if (termWidth < 60) {
    return [
      "",
      `  ${wordmark()}  ${faint("v" + opts.version)}`,
      `  ${info(opts.model)}  ${muted(dir)}`,
      ...(opts.sandbox === false ? [sandboxOffLine()] : []),
      `  ${faint("/help for commands")}`,
      "",
    ].join("\n");
  }

  return [
    "",
    `  ${wordmark()}  ${faint("v" + opts.version)}`,
    `  ${faint("know-how, set down.")}`,
    "",
    `  ${info(opts.model)} ${faint("·")} ${muted(dir)}`,
    ...(opts.sandbox === false ? [sandboxOffLine()] : []),
    `  ${faint("type a task · / for commands · shift+tab for modes")}`,
    "",
  ].join("\n");
}
