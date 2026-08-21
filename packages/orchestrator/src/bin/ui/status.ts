// ─── /status — Gear session card ───

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
  permissionMode?: "confirm" | "autonomy-i" | "autonomy-ii" | "autonomy-iii" | "auto";
  /** OS command sandbox: true = sandboxed, false = full access. Absent hides the row. */
  sandboxEnabled?: boolean;
  /** True when the sandbox is on but this machine has no OS isolation backend. */
  sandboxDegraded?: boolean;
  /** Verified org policy in force (managed machines). Absent hides the row. */
  orgPolicy?: { org?: string; fingerprint: string } | null;
  registeredProviders?: string[];
  autoMode?: {
    enabled: boolean;
    failClosed: boolean;
    reviewer: { provider: string; model: string } | null;
    stats: { allowed: number; asked: number; denied: number; injectionsFlagged: number };
  };
  version?: string;
  /** Context-window occupancy (v2 footer meter's source of truth). */
  contextUsage?: { used: number; limit: number; percent: number };
  /** Gateway provider health: pruned models and cooling rate-limited providers. */
  providerHealth?: { pruned: string[]; cooling: { provider: string; untilMs: number }[] };
}

function permissionsLabel(s: StatusView): string {
  const mode =
    s.permissionMode ?? (s.yoloMode ? "autonomy-iii" : s.trustWorkspace ? "auto" : "confirm");
  if (mode === "autonomy-iii") return bold(warn("⚡ Autonomy III · full system access"));
  if (mode === "autonomy-ii") return warn("Autonomy II · sandboxed execution");
  if (mode === "autonomy-i") return warn("Autonomy I · workspace edits");
  if (mode === "auto") return warn("auto · classifier-reviewed");
  return text("confirm · on-request");
}

export function renderStatus(s: StatusView): string {
  const header = `${info("◉")} ${bold(text(PRODUCT_NAME))}  ${muted("v" + (s.version ?? PRODUCT_VERSION))}`;

  const rows: [string, string][] = [
    ["Model", info(s.model)],
    ["Provider", text(s.provider)],
    ["Directory", text(shortPath(s.workspace))],
    ["Mode", text(s.plannerMode ? "planner" : "react")],
    ["Permissions", permissionsLabel(s)],
    ...(s.sandboxEnabled === undefined
      ? []
      : ([
          [
            "Sandbox",
            !s.sandboxEnabled
              ? bold(warn("▲ off · full host access"))
              : s.sandboxDegraded
                ? bold(warn("▲ on · NOT ISOLATED — no OS backend, path-guard only"))
                : text("on · commands OS-sandboxed, no network"),
          ],
        ] as [string, string][])),
    ...(s.orgPolicy
      ? ([
          [
            "Org policy",
            bold(warn(`⛨ ${s.orgPolicy.org ?? "enforced"} · ${s.orgPolicy.fingerprint}`)),
          ],
        ] as [string, string][])
      : []),
    ...(s.permissionMode === "auto" && s.autoMode
      ? ([
          [
            "Auto reviewer",
            s.autoMode.reviewer
              ? text(
                  `${s.autoMode.reviewer.provider}/${s.autoMode.reviewer.model} · isolated context · ${s.autoMode.failClosed ? "fail closed" : "FAIL OPEN"}`,
                )
              : bold(warn("unavailable · risky actions ask")),
          ],
          [
            "Auto decisions",
            muted(
              `${s.autoMode.stats.allowed} allow · ${s.autoMode.stats.denied} block · ${s.autoMode.stats.asked} ask · ${s.autoMode.stats.injectionsFlagged} injection warnings`,
            ),
          ],
        ] as [string, string][])
      : []),
    ...(s.contextUsage && s.contextUsage.percent > 0
      ? ([
          [
            "Context",
            (s.contextUsage.percent >= 90
              ? bold(warn(`${s.contextUsage.percent}% · hot — /compress recommended`))
              : s.contextUsage.percent >= 70
                ? warn(`${s.contextUsage.percent}% · compaction near`)
                : text(`${s.contextUsage.percent}%`)) +
              muted(
                ` (${Math.round(s.contextUsage.used / 1000)}k / ${Math.round(s.contextUsage.limit / 1000)}k tokens)`,
              ),
          ],
        ] as [string, string][])
      : []),
    ["Session", text(s.sessionId.slice(0, 8))],
    ["Cost", text(`$${s.cost.toFixed(4)}`)],
  ];
  if (s.registeredProviders?.length) {
    rows.push(["Providers", muted(s.registeredProviders.join(", "))]);
  }
  if (s.providerHealth && (s.providerHealth.pruned.length || s.providerHealth.cooling.length)) {
    const bits: string[] = [];
    if (s.providerHealth.pruned.length)
      bits.push(`pruned: ${s.providerHealth.pruned.join(", ")}`);
    for (const c of s.providerHealth.cooling) {
      const secs = Math.max(0, Math.ceil((c.untilMs - Date.now()) / 1000));
      bits.push(`${c.provider} cooling ${secs}s`);
    }
    rows.push(["Gateway", warn(bits.join(" · "))]);
  }

  // Values are already colored — keep kv's value pass as identity.
  const kvRows = kv(rows, { labelWidth: 12, labelColor: muted, valueColor: (x) => x });
  return box([header, "", ...kvRows]);
}
