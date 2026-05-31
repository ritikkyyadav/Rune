// ─── Alan Startup Banner ───
// Codex-style `>_ Alan` header in a rounded box, with model + directory rows and a
// short tip line. Replaces the old ASCII-art logo.

import * as os from "os";
import { bold, text, muted, faint, info } from "./theme";
import { box } from "./render";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface BannerOptions {
  model: string;
  provider?: string;
  version: string;
  workspace: string;
  effort?: string;
  sessionId?: string;
  sandbox?: boolean;
  /** Kept for call-site back-compat; unused by the banner. */
  recentSessions?: unknown[];
}

export function renderBanner(opts: BannerOptions): string {
  const termWidth = process.stdout.columns ?? 80;
  if (termWidth < 60) return renderSimple(opts);

  const dir = shortPath(opts.workspace);
  const modelLabel = opts.effort ? `${opts.model}  ${faint(opts.effort)}` : opts.model;
  const labelW = "directory".length;

  const header = `${faint(">_")} ${bold(text("Alan"))}  ${muted("(v" + opts.version + ")")}`;
  const modelRow = `${muted("model".padEnd(labelW))}  ${info(modelLabel)}   ${faint("/model to change")}`;
  const dirRow = `${muted("directory".padEnd(labelW))}  ${text(dir)}`;

  const framed = box([header, "", modelRow, dirRow], { rounded: true });
  const tip = `  ${muted("Tip:")} ${faint("Type a task, or")} ${info("/help")} ${faint("for commands.")}`;

  return ["", framed, "", tip, ""].join("\n");
}

function renderSimple(opts: BannerOptions): string {
  const dir = shortPath(opts.workspace);
  return [
    "",
    `  ${faint(">_")} ${bold(text("Alan"))} ${muted("(v" + opts.version + ")")}`,
    `  ${info(opts.model)}${opts.effort ? " " + faint(opts.effort) : ""}  ${muted(dir)}`,
    `  ${faint("Type a task, or /help for commands.")}`,
    "",
  ].join("\n");
}
