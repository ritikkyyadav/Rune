// ─── Alan Startup Banner ───
// The Savoir lockup: the wordmark with its block cursor, the tagline, and a
// quiet readout of model + directory. No frame — the identity is the cursor,
// not a box. ("Know-how, set down.")

import * as os from "os";
import { bold, text, muted, faint, info, ok } from "./theme";
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
  sandbox?: boolean;
  /** Kept for call-site back-compat; unused by the banner. */
  recentSessions?: unknown[];
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
    `  ${faint("type a task · / for commands · shift+tab for modes")}`,
    "",
  ].join("\n");
}
