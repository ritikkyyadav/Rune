// ─── /status — Codex-style session card ───

import * as os from "os";
import { bold, text, muted, faint, info, warn } from "./theme";
import { box, kv } from "./render";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./brand";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface StatusView {
  model: string;
  provider: string;
  workspace: string;
  sessionId: string;
  cost: number;
  plannerMode?: boolean;
  yoloMode?: boolean;
  trustWorkspace?: boolean;
  /** Active permission mode; falls back to the yolo/trust booleans when absent. */
  permissionMode?: "confirm" | "auto" | "turing";
  registeredProviders?: string[];
  version?: string;
}

function permissionsLabel(s: StatusView): string {
  const mode = s.permissionMode ?? (s.yoloMode ? "turing" : s.trustWorkspace ? "auto" : "confirm");
  if (mode === "turing") return bold(warn("⚡ Hands-Free · no prompts"));
  if (mode === "auto") return warn("auto · in-workspace auto-approved");
  return text("confirm · on-request");
}

export function renderStatus(s: StatusView): string {
  const header = `${faint(">_")} ${bold(text(PRODUCT_NAME))}  ${muted("(v" + (s.version ?? PRODUCT_VERSION) + ")")}`;

  const rows: [string, string][] = [
    ["Model", info(s.model)],
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
