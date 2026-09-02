// ─── The status bar ───
//
// One item, and it answers the two questions a person actually has while an
// agent is running in a panel they cannot see: what is it allowed to do, and
// what is it costing me.
//
// Rule 9 of the program applies here more than anywhere, because a status bar
// is read at a glance and believed: a number on screen comes from real data.
// `null` cost is "no data" and renders as nothing at all — never as `$0.00`,
// which is a claim that the run was free.

export interface EngineStatus {
  /** 1 · 2 · 3 · 4 · auto. */
  gear?: string | number | null;
  model?: string | null;
  /** Dollars for this session, or null when nothing has been metered yet. */
  costUsd?: number | null;
  /** Whether the socket is up. */
  connected: boolean;
}

export function statusText(status: EngineStatus | null): string {
  if (!status || !status.connected) return "$(debug-disconnect) Gear";
  const parts: string[] = [];
  if (status.gear != null && String(status.gear).length > 0) {
    parts.push(`gear ${String(status.gear)}`);
  }
  if (typeof status.costUsd === "number" && Number.isFinite(status.costUsd)) {
    parts.push(formatCost(status.costUsd));
  }
  return parts.length > 0 ? `$(gear) ${parts.join(" · ")}` : "$(gear) Gear";
}

export function statusTooltip(status: EngineStatus | null): string {
  if (!status || !status.connected) return "Gear — not connected. Click to open the panel.";
  const lines = ["Gear"];
  if (status.model) lines.push(`model    ${status.model}`);
  if (status.gear != null) lines.push(`gear     ${String(status.gear)}`);
  lines.push(
    typeof status.costUsd === "number"
      ? `session  ${formatCost(status.costUsd)}`
      : "session  no cost recorded yet",
  );
  return lines.join("\n");
}

/**
 * Money, at a precision that does not lie.
 *
 * Two decimals turns every short session into `$0.00`, which reads as free.
 * Sub-cent amounts get the precision they need to be a number instead of a
 * rounding artefact.
 */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
