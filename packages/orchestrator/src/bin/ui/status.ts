// ─── /status — Codex-style session card ───

import * as os from "os";
import { bold, text, muted, faint, info, warn, accent } from "./theme";
import { box, kv } from "./render";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface StatusView {
  model: string;
  provider: string;
  effort: string;
  workspace: string;
  sessionId: string;
  cost: number;
  plannerMode?: boolean;
  yoloMode?: boolean;
  trustWorkspace?: boolean;
  registeredProviders?: string[];
  version?: string;
}

function permissionsLabel(s: StatusView): string {
  if (s.yoloMode) return accent("yolo · no prompts");
  if (s.trustWorkspace) return warn("trusted · in-workspace auto");
  return text("confirm · on-request");
}

export function renderStatus(s: StatusView): string {
  const header = `${faint(">_")} ${bold(text("Alan"))}  ${muted("(v" + (s.version ?? "0.1.0") + ")")}`;

  const rows: [string, string][] = [
    ["Model", `${info(s.model)}  ${faint("(effort: " + s.effort + ")")}`],
    ["Provider", text(s.provider)],
    ["Directory", text(shortPath(s.workspace))],
    ["Mode", text(s.plannerMode ? "planner" : "react")],
    ["Permissions", permissionsLabel(s)],
    ["Session", text(s.sessionId.slice(0, 8))],
    ["Cost", text(`$${s.cost.toFixed(4)}`)],
  ];
  if (s.registeredProviders?.length) {
    rows.push(["Providers", muted(s.registeredProviders.join(", "))]);
  }

  // Values are already colored — keep kv's value pass as identity.
  const kvRows = kv(rows, { labelWidth: 12, labelColor: muted, valueColor: (x) => x });
  return box([header, "", ...kvRows]);
}
