// ─── `rune cost`: what a session cost in COMPLETIONS, not just dollars ───
//
// `/cost` answers the same question inside a live session. This is the
// headless path — no Engine, no provider, ~/.rune/rune.db opened read-only,
// instant — because the question is usually asked AFTER a run died, and the
// process holding the live ledger is exactly the one that died.
//
// The money half was already right and is unchanged. What this adds is the
// half a free tier runs on: a free route bills $0.00 and rate-limits
// everything, so "spent $0.00" is a true sentence that predicts nothing. The
// number that predicts it is how many requests Rune made and how many of them
// were its own governance rather than the user's work.

import { join } from "node:path";
import { getRuneHome, SessionManager } from "@rune/shared";
import type { SessionEvent } from "@rune/shared";
import type { CostEntry, ProviderName } from "@rune/llm-gateway";
import { completionsByProvider, summarizeRunEconomics } from "@rune/llm-gateway";
import { formatRunEconomics, formatUsd } from "../cost-report";
import { danger, dim, faint, ok, text, warn } from "./ui/theme";

type Row = { seq: number; event: SessionEvent };

const say = (s = ""): void => {
  process.stdout.write(s + "\n");
};

/** The session to report on: an id prefix, or `last` (default) for the newest. */
function resolveSession(sm: SessionManager, arg: string | undefined): string | null {
  const all = sm
    .listSessions({ status: "all" })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (!arg || arg === "last" || arg === "latest") return all[0]?.id ?? null;
  const hit = all.find((s) => s.id === arg) ?? all.find((s) => s.id.startsWith(arg));
  return hit?.id ?? null;
}

/**
 * Cost rows out of a session log, back into the shape the summarizer takes.
 *
 * Deliberately tolerant: rows written before P12.1 carry no `role` and no
 * `composition`, and they are counted as work with no composition — which is
 * exactly what they were. A reader that refused them would make the new
 * surface useless on every session that already exists.
 */
export function costEntriesFrom(
  rows: Row[],
): Array<
  Pick<
    CostEntry,
    | "model"
    | "provider"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheCreationTokens"
    | "costUsd"
    | "listCostUsd"
  > &
    Partial<Pick<CostEntry, "role" | "composition" | "priced">>
> {
  const out = [];
  for (const r of rows) {
    if (r.event.type !== "cost") continue;
    const p = (r.event.payload ?? {}) as Record<string, unknown>;
    out.push({
      model: String(p.model ?? ""),
      provider: String(p.provider ?? "unknown") as ProviderName,
      inputTokens: Number(p.inputTokens ?? 0) || 0,
      outputTokens: Number(p.outputTokens ?? 0) || 0,
      cacheReadTokens: Number(p.cacheReadTokens ?? 0) || 0,
      cacheCreationTokens: Number(p.cacheCreationTokens ?? 0) || 0,
      costUsd: Number(p.costUsd ?? 0) || 0,
      listCostUsd: Number(p.listCostUsd ?? 0) || 0,
      ...(typeof p.role === "string" ? { role: p.role as CostEntry["role"] } : {}),
      ...(p.composition && typeof p.composition === "object"
        ? { composition: p.composition as CostEntry["composition"] }
        : {}),
      ...(typeof p.priced === "boolean" ? { priced: p.priced } : {}),
    });
  }
  return out;
}

export async function runCost(args: string[], values: Record<string, unknown>): Promise<number> {
  const dbPath =
    (typeof values.db === "string" && values.db) ||
    process.env.RUNE_DB_PATH ||
    join(getRuneHome(), "rune.db");
  let sm: SessionManager;
  try {
    sm = new SessionManager(dbPath);
  } catch (err) {
    say(`  ${danger("!")} could not open ${dbPath}: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  try {
    const id = resolveSession(sm, args[0]);
    if (!id) {
      say(dim("  No session found. Usage: rune cost [sessionId|last]"));
      return 1;
    }
    const session = sm.getSession(id)!;
    const rows = sm.getEvents(id, 1) as Row[];
    const entries = costEntriesFrom(rows);

    say();
    say(`  ${text("Cost")}  ${dim(id.slice(0, 8))} ${faint(session.workspaceRoot)}`);
    say();

    if (entries.length === 0) {
      say(dim("  No completions recorded for this session."));
      say();
      return 0;
    }

    const economics = summarizeRunEconomics(entries);

    // The money line first, in the same words `/cost` uses. Zero paid is a
    // real answer on a free route, and it is labelled as one rather than left
    // to look like a broken meter — the original bug this surface fixed.
    const paid = economics.costUsd;
    say(
      `  ${faint("Spent".padStart(18))}  ${paid > 0 ? formatUsd(paid) : ok(formatUsd(0))}` +
        `${paid > 0 ? "" : faint("  (subscription / free tier — no metered charge)")}`,
    );

    const lines = formatRunEconomics(economics);
    const width = Math.max(18, ...lines.map((l) => l.label.length));
    for (const line of lines) {
      const paint =
        line.tone === "warn"
          ? warn
          : line.tone === "good"
            ? ok
            : line.tone === "muted"
              ? dim
              : text;
      const note = line.note ? faint(`  (${line.note})`) : "";
      say(`  ${faint(line.label.padStart(width))}  ${paint(line.value)}${note}`);
    }

    // Where the calls went. On a free-tier run this is the line that explains
    // a 429: one provider carrying both the work and the governance.
    const providers = completionsByProvider(entries);
    if (providers.length > 0) {
      say();
      for (const p of providers) {
        say(
          `  ${faint(String(p.provider).padStart(width))}  ${text(String(p.completions))}` +
            faint(`  (${p.governance} governance)`),
        );
      }
    }

    say();
    say(dim(`  per-turn detail: rune audit ${id.slice(0, 8)}`));
    say();
    return 0;
  } finally {
    sm.close();
  }
}
