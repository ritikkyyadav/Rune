// ─── Alan Welcome Screen ───
// Clean boot — model + sandbox status, nothing else.

import * as os from "os";
import { bold, paper, dim, vermillion, brass, cyanotype, green } from "./colors";

function shortPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

// ─── Welcome Screen ───

export interface WelcomeOptions {
  model: string;
  provider?: string;
  sessionId: string;
  workspace: string;
  version: string;
  sandbox?: boolean;
  recentSessions: Array<{
    id: string;
    workspaceRoot: string;
    eventCount: number;
    model: string;
  }>;
}

export function renderWelcome(opts: WelcomeOptions): string {
  const termWidth = process.stdout.columns ?? 80;

  if (termWidth < 60) {
    return renderSimple(opts);
  }

  const out: string[] = [];
  const pad = "  ";

  // ─── ASCII Logo ───
  out.push("");
  const logo = [
    "    █████╗  ██╗       █████╗  ███╗   ██╗",
    "   ██╔══██╗ ██║      ██╔══██╗ ████╗  ██║",
    "   ███████║ ██║      ███████║ ██╔██╗ ██║",
    "   ██╔══██║ ██║      ██╔══██║ ██║╚██╗██║",
    "   ██║  ██║ ███████╗ ██║  ██║ ██║ ╚████║",
    "   ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝",
  ];
  for (const line of logo) {
    out.push(`${pad}${paper(line)}`);
  }
  out.push("");

  // ─── Status Line: model + sandbox ───
  const modelStr = opts.provider
    ? `${cyanotype(opts.provider)}${dim("/")}${brass(truncate(opts.model, 30))}`
    : brass(truncate(opts.model, 30));
  const sandboxStr = opts.sandbox ? green("sandbox") : dim("no sandbox");

  out.push(`${pad}${dim("v" + opts.version)}  ${modelStr}  ${sandboxStr}`);
  out.push("");

  // ─── Ready ───
  out.push(
    `${pad}${bold(paper("Ready."))} ${dim("Type a task, or")} ${cyanotype("/help")} ${dim("for commands.")}`,
  );
  out.push("");

  return out.join("\n");
}

// ─── Simple Fallback ───

function renderSimple(opts: WelcomeOptions): string {
  const sandboxStr = opts.sandbox ? green("sandbox") : dim("no sandbox");
  return [
    "",
    `  ${vermillion("\u203A")} ${bold(paper("Alan"))} ${dim("v" + opts.version)}  ${sandboxStr}`,
    `  ${dim(opts.model)}`,
    `  ${dim("Type a task. Ctrl+C to exit.")}`,
    "",
  ].join("\n");
}
