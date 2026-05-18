// ─── Alan Welcome Screen ───
// Renders a branded startup screen with mascot, tips, and recent activity

import * as os from "os";

// ─── Colors ───

const esc = (code: string) => `\x1b[${code}m`;
const reset = esc("0");
const dim = (s: string) => `${esc("2")}${s}${reset}`;
const bold = (s: string) => `${esc("1")}${s}${reset}`;
const indigo = (s: string) => `${esc("38;5;105")}${s}${reset}`;
const amber = (s: string) => `${esc("38;5;214")}${s}${reset}`;

// ─── ANSI Utilities ───

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function padRight(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

function centerStr(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  if (visible >= width) return s;
  const leftPad = Math.floor((width - visible) / 2);
  const rightPad = width - visible - leftPad;
  return " ".repeat(leftPad) + s + " ".repeat(rightPad);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function shortPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

// ─── Mascot ───
// A geometric face with diamond eyes — Alan's brand mark
// Each line is 12 visible characters wide

function getMascot(): string[] {
  return [
    indigo(" \u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2584 "),
    indigo("\u2588\u2588") + "  " + amber("\u25C6") + "  " + amber("\u25C6") + "  " + indigo("\u2588\u2588"),
    indigo("\u2588\u2588") + "   " + dim("\u2500\u2500") + "   " + indigo("\u2588\u2588"),
    indigo(" \u2580\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2580 "),
    indigo("  \u2580\u2580") + "    " + indigo("\u2580\u2580  "),
  ];
}

// ─── Display Name ───

function getDisplayName(): string {
  try {
    const result = Bun.spawnSync(["git", "config", "user.name"]);
    const name = new TextDecoder().decode(result.stdout).trim();
    if (name) return name.split(" ")[0];
  } catch {}
  const username = os.userInfo().username;
  return username.charAt(0).toUpperCase() + username.slice(1);
}

// ─── Welcome Screen ───

export interface WelcomeOptions {
  model: string;
  sessionId: string;
  workspace: string;
  version: string;
  recentSessions: Array<{
    id: string;
    workspaceRoot: string;
    eventCount: number;
    model: string;
  }>;
}

export function renderWelcome(opts: WelcomeOptions): string {
  const termWidth = process.stdout.columns ?? 80;

  // Fall back to simple header on narrow terminals
  if (termWidth < 76) {
    return renderSimple(opts);
  }

  const name = getDisplayName();
  const LEFT_W = 40;
  const RIGHT_W = 30;
  const GAP = 2;
  const TOTAL = LEFT_W + 2 + GAP + RIGHT_W + 2; // 76

  const out: string[] = [];

  // ─── Title Banner ───
  const titleText = " Alan v" + opts.version + " ";
  const dashLeft = Math.floor((TOTAL - titleText.length) / 2);
  const dashRight = TOTAL - titleText.length - dashLeft;
  out.push(
    dim("\u2500".repeat(dashLeft)) +
      bold(indigo(titleText)) +
      dim("\u2500".repeat(dashRight)),
  );

  // ─── Left Panel Content ───
  const left: string[] = [];
  left.push("");
  left.push(centerStr(bold("Welcome back " + name + "!"), LEFT_W));
  left.push("");

  for (const line of getMascot()) {
    left.push(centerStr(line, LEFT_W));
  }

  left.push("");

  const modelStr = truncate(opts.model, LEFT_W - 4);
  left.push(centerStr(dim(modelStr), LEFT_W));

  const wsShort = shortPath(opts.workspace);
  const infoLine = "session " + opts.sessionId.slice(0, 8) + " \u00b7 " + wsShort;
  left.push(centerStr(dim(truncate(infoLine, LEFT_W - 4)), LEFT_W));
  left.push("");

  // ─── Right Panel Content ───
  const right: string[] = [];
  right.push("");
  right.push(" " + amber("Tips for getting started"));
  right.push(" " + amber("\u2500".repeat(RIGHT_W - 2)));
  right.push(" Start by typing a message");
  right.push(" Use " + bold("/quit") + " to exit");
  right.push(" Use " + bold("/cost") + " to check spend");
  right.push("");
  right.push(" " + amber("\u2500".repeat(RIGHT_W - 2)));
  right.push(" " + amber("Recent activity"));
  right.push(" " + amber("\u2500".repeat(RIGHT_W - 2)));

  if (opts.recentSessions.length === 0) {
    right.push(" " + dim("No recent activity"));
  } else {
    for (const s of opts.recentSessions.slice(0, 3)) {
      const sid = s.id.slice(0, 8);
      const ws = truncate(shortPath(s.workspaceRoot), RIGHT_W - 11);
      right.push(" " + sid + " " + dim(ws));
    }
  }
  right.push("");

  // ─── Equalize Heights ───
  const height = Math.max(left.length, right.length);
  while (left.length < height) left.push("");
  while (right.length < height) right.push("");

  // ─── Box Top ───
  out.push(
    indigo("\u250C" + "\u2500".repeat(LEFT_W) + "\u2510") +
      " ".repeat(GAP) +
      indigo("\u250C" + "\u2500".repeat(RIGHT_W) + "\u2510"),
  );

  // ─── Content Rows ───
  for (let i = 0; i < height; i++) {
    const lContent = padRight(left[i], LEFT_W);
    const rContent = padRight(right[i], RIGHT_W);
    out.push(
      indigo("\u2502") +
        lContent +
        indigo("\u2502") +
        " ".repeat(GAP) +
        indigo("\u2502") +
        rContent +
        indigo("\u2502"),
    );
  }

  // ─── Box Bottom ───
  out.push(
    indigo("\u2514" + "\u2500".repeat(LEFT_W) + "\u2518") +
      " ".repeat(GAP) +
      indigo("\u2514" + "\u2500".repeat(RIGHT_W) + "\u2518"),
  );

  return out.join("\n");
}

// ─── Simple Fallback (narrow terminals) ───

function renderSimple(opts: WelcomeOptions): string {
  const name = getDisplayName();
  return [
    "",
    "  " + indigo("\u25C6") + " " + bold("Alan") + " " + dim("v" + opts.version),
    "  " + bold("Welcome back " + name + "!"),
    "  " + dim(opts.model + "  \u00b7  session " + opts.sessionId.slice(0, 8)),
    "  " + dim("Type your message. Ctrl+C to exit."),
    "",
  ].join("\n");
}
