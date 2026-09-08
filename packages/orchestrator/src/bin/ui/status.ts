// --- /status -- Rune session card ---

import type { PermissionMode } from "../../permissions";
import * as os from "os";
import { bold, danger, text, muted, info, warn } from "./theme";
import { modeInfo } from "./composer";
import { kv } from "./render";
import * as F from "./flow";
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
  /**
   * Pre-formatted one-line cost readout. Preferred over `cost` when present:
   * on a subscription or free route the raw number is always $0.0000, which
   * is true and says nothing about the work done or what it was worth.
   */
  costSummary?: string;
  yoloMode?: boolean;
  trustWorkspace?: boolean;
  /** Active permission mode; falls back to the yolo/trust booleans when absent. */
  permissionMode?: PermissionMode;
  /** OS command sandbox: true = sandboxed, false = full access. Absent hides the row. */
  sandboxEnabled?: boolean;
  /** True when the sandbox is on but this machine has no OS isolation backend. */
  sandboxDegraded?: boolean;
  /** auto-allow | regular | off — refines the boolean when present. */
  sandboxMode?: "auto-allow" | "regular" | "off";
  /** The Overrides tab: true = unsandboxed fallback allowed, false = strict. */
  sandboxFallback?: boolean;
  /** Command patterns excluded from the sandbox. */
  sandboxExcluded?: string[];
  /** Verified org policy in force (managed machines). Absent hides the row. */
  orgPolicy?: { org?: string; fingerprint: string } | null;
  registeredProviders?: string[];
  autoMode?: {
    enabled: boolean;
    failClosed: boolean;
    reviewer: { provider: string; model: string } | null;
    /** Retry posture for failed reviewer calls. */
    reviewerFallback?: { enabled: boolean; available: boolean };
    stats: { allowed: number; asked: number; denied: number; injectionsFlagged: number };
  };
  version?: string;
  /** Context-window occupancy (v2 footer meter's source of truth). */
  contextUsage?: { used: number; limit: number; percent: number };
  /** Gateway provider health: pruned models and cooling rate-limited providers. */
  providerHealth?: { pruned: string[]; cooling: { provider: string; untilMs: number }[] };
}

function permissionsLabel(s: StatusView): string {
  const mode: PermissionMode =
    s.permissionMode ?? (s.yoloMode ? "gear-4" : s.trustWorkspace ? "gear-3" : "gear-1");
  // Read the one gear table (composer.modeInfo) -- /status once carried its own
  // hand-rolled copy of these labels, and copies drift.
  const m = modeInfo(mode);
  const label = m.paint(`${m.arrows} ${m.label}${m.desc ? ` | ${m.desc}` : ""}`);
  return m.loud ? bold(label) : label;
}

export function renderStatus(s: StatusView): string {
  const rows: [string, string][] = [
    ["model", info(s.model)],
    ["provider", text(s.provider)],
    ["directory", text(shortPath(s.workspace))],
    ["permissions", permissionsLabel(s)],
    ...(s.sandboxEnabled === undefined
      ? []
      : ([
          [
            "sandbox",
            !s.sandboxEnabled
              ? bold(warn("! off | full host access"))
              : s.sandboxDegraded
                ? bold(warn("! on | NOT ISOLATED -- no OS backend, path-guard only"))
                : text(
                    `${s.sandboxMode ?? "on"} | commands OS-sandboxed, no network` +
                      (s.sandboxMode === "regular" ? ", prompts apply" : "") +
                      (s.sandboxFallback === false ? " | strict" : "") +
                      (s.sandboxExcluded?.length
                        ? ` | excluded: ${s.sandboxExcluded.join(", ")}`
                        : ""),
                  ),
          ],
        ] as [string, string][])),
    ...(s.orgPolicy
      ? ([
          [
            "org policy",
            bold(warn(`# ${s.orgPolicy.org ?? "enforced"} | ${s.orgPolicy.fingerprint}`)),
          ],
        ] as [string, string][])
      : []),
    ...(s.permissionMode === "auto" && s.autoMode
      ? ([
          [
            "auto reviewer",
            s.autoMode.reviewer
              ? text(
                  `${s.autoMode.reviewer.provider}/${s.autoMode.reviewer.model} | isolated context | ${s.autoMode.failClosed ? "fail closed" : "FAIL OPEN"}${s.autoMode.reviewerFallback?.available ? " | fallback ready" : ""}`,
                )
              : bold(warn("unavailable | risky actions ask")),
          ],
          [
            "auto escalation",
            text("conversational | blocked actions ask you in chat; prompts only as backstop"),
          ],
          [
            "auto decisions",
            muted(
              `${s.autoMode.stats.allowed} allow | ${s.autoMode.stats.denied} block | ${s.autoMode.stats.asked} ask | ${s.autoMode.stats.injectionsFlagged} injection warnings`,
            ),
          ],
        ] as [string, string][])
      : []),
    ...(s.contextUsage && s.contextUsage.percent > 0
      ? ([
          [
            "context",
            (s.contextUsage.percent >= 90
              ? bold(danger(`${s.contextUsage.percent}% | hot -- /compress recommended`))
              : s.contextUsage.percent >= 70
                ? warn(`${s.contextUsage.percent}% | compaction near`)
                : text(`${s.contextUsage.percent}%`)) +
              muted(
                ` (${Math.round(s.contextUsage.used / 1000)}k / ${Math.round(s.contextUsage.limit / 1000)}k tokens)`,
              ),
          ],
        ] as [string, string][])
      : []),
    ["session", text(s.sessionId.slice(0, 8))],
    ["cost", text(s.costSummary ?? `$${s.cost.toFixed(4)}`)],
  ];
  if (s.registeredProviders?.length) {
    rows.push(["providers", muted(s.registeredProviders.join(", "))]);
  }
  if (s.providerHealth && (s.providerHealth.pruned.length || s.providerHealth.cooling.length)) {
    const bits: string[] = [];
    if (s.providerHealth.pruned.length) bits.push(`pruned: ${s.providerHealth.pruned.join(", ")}`);
    for (const c of s.providerHealth.cooling) {
      const secs = Math.max(0, Math.ceil((c.untilMs - Date.now()) / 1000));
      bits.push(`${c.provider} cooling ${secs}s`);
    }
    rows.push(["gateway", warn(bits.join(" | "))]);
  }

  // Values are already colored -- keep kv's value pass as identity.
  const kvRows = kv(rows, { labelWidth: 12, labelColor: muted, valueColor: (x) => x });
  const surface = F.surfaceWidth();
  // /status is the header, expanded -- so its first row IS the header's first
  // row: the same wordmark, the same build at the same right edge, carried on
  // the same two-tone rule. It used to say this in a different dialect -- a
  // lowercase name inlaid into a line of repeated hyphens, the texture the rest
  // of the UI dropped when hairlines replaced dash rules -- so a card that
  // called itself "the header, expanded" disagreed with the row pinned at the
  // top of the same window.
  const mark = F.lockup(PRODUCT_NAME);
  return [
    "",
    `${F.MARK}${F.row(mark.text, F.versionTag(s.version ?? PRODUCT_VERSION), surface - F.MARK.length)}`,
    F.seamRule(surface, mark.cells),
    ...kvRows.map((row) => `${F.MARK}${row.trimStart()}`),
    F.hairline(surface),
    "",
  ].join("\n");
}
