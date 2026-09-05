import { Database } from "bun:sqlite";

/**
 * The Auto-mode metrics that have to survive a restart.
 *
 * `supervisorUnconfirmed` lived in a process-local counter. So did the halt
 * count. Both reset when the process died, which is to say: the risk the
 * product scorecard names — "supervisor false-positive session kills, measured,
 * under 1 per 100 runs" — was structurally unmeasurable, because the only place
 * it was ever written down was memory belonging to a process that a halt often
 * ended.
 *
 * P6A.1 made the underlying rows durable. This reads them back. It opens the
 * session database read-only and does nothing else — no engine, no provider, no
 * writes — so `rune audit` and `rune doctor` can call it at any time.
 *
 * ## What "false positive" means here, precisely
 *
 * Two independent signals, and they are not interchangeable:
 *
 *   1. **Caught in flight.** The fast screen fired and the reasoned pass refused
 *      to confirm it. The run carried on, nobody was interrupted, and the
 *      miscalibration is visible only because both rows are now recorded.
 *   2. **Overturned by the user.** A step Auto held was then approved and run
 *      unchanged (`held_step_outcome: ran`). That is the expensive kind: a
 *      person had to intervene to get work done that was fine all along.
 *
 * The headline "kills per 100 runs" counts confirmed halts, because a halt is
 * the only outcome that ends a session. The two rates above are what say
 * whether that number is trending the right way.
 */

export interface AutoSafetyMetrics {
  /** Sessions considered (the window). */
  sessions: number;
  /** Every persisted safety decision in the window. */
  decisions: number;
  /** Out-of-band supervisor screens recorded, fired or not. */
  supervisorScreens: number;
  /** Screens that fired. */
  supervisorFlags: number;
  /** Reasoned confirmations recorded. */
  supervisorConfirmations: number;
  /** Confirmations that upheld the flag — these are what latch a halt. */
  supervisorConfirmed: number;
  /**
   * Flags the reasoned pass refused to confirm, over flags raised. Null when no
   * screen has fired: a rate with no denominator is not zero, it is unknown,
   * and printing 0% would be an invented number.
   */
  screenFalsePositiveRate: number | null;
  /** Halts that actually latched (source supervisor_halt or supervisor_late). */
  supervisorHalts: number;
  /** Confirmed halts per 100 sessions — the scorecard number. */
  haltsPerHundredRuns: number | null;
  /** Held steps by what the user did with them. */
  heldSteps: { ran: number; skipped: number; refused: number; failed: number; total: number };
  /**
   * Held steps the user ran unchanged, over those they actually decided on
   * (ran + skipped). A step nobody looked at is not evidence either way, so it
   * is excluded from the denominator rather than counted as agreement.
   */
  heldStepFalsePositiveRate: number | null;
  /** True when no row in the window carries the P6A.1 fields at all. */
  legacyOnly: boolean;
}

const EMPTY: AutoSafetyMetrics = {
  sessions: 0,
  decisions: 0,
  supervisorScreens: 0,
  supervisorFlags: 0,
  supervisorConfirmations: 0,
  supervisorConfirmed: 0,
  screenFalsePositiveRate: null,
  supervisorHalts: 0,
  haltsPerHundredRuns: null,
  heldSteps: { ran: 0, skipped: 0, refused: 0, failed: 0, total: 0 },
  heldStepFalsePositiveRate: null,
  legacyOnly: true,
};

/**
 * Read the metrics from a session database. `sessionId` scopes to one session;
 * omit it for the whole store.
 *
 * Never throws: a metrics reader that can fail is a metrics reader that ends up
 * wrapped in a try/catch at every call site, and then nobody prints it.
 */
export function readAutoSafetyMetrics(
  dbPath: string,
  opts: { sessionId?: string; limitSessions?: number } = {},
): AutoSafetyMetrics {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const scope = opts.sessionId ? "AND session_id = ?" : "";
    const bind = opts.sessionId ? [opts.sessionId] : [];

    const sessions = opts.sessionId
      ? 1
      : ((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number } | null)?.n ?? 0);

    const decisionRows = db
      .prepare(
        `SELECT payload_json FROM events WHERE type = 'safety_decision' ${scope}
         ORDER BY id DESC LIMIT 200000`,
      )
      .all(...bind) as Array<{ payload_json: string }>;

    const metrics: AutoSafetyMetrics = {
      ...EMPTY,
      sessions,
      heldSteps: { ran: 0, skipped: 0, refused: 0, failed: 0, total: 0 },
    };

    for (const raw of decisionRows) {
      let payload: Record<string, unknown>;
      try {
        payload =
          (JSON.parse(raw.payload_json) as { payload?: Record<string, unknown> }).payload ?? {};
      } catch {
        continue;
      }
      metrics.decisions++;
      const source = String(payload.source ?? "");
      const verdict = String(payload.verdict ?? "");
      // Any row carrying the P6A.1 fields proves the window is not purely
      // historical, which is what keeps a legacy database from reporting a
      // confident 0% over rows that never had the data.
      if (payload.callId !== undefined || payload.timings !== undefined) metrics.legacyOnly = false;
      switch (source) {
        case "supervisor_screen":
          metrics.supervisorScreens++;
          if (verdict !== "allow") metrics.supervisorFlags++;
          metrics.legacyOnly = false;
          break;
        case "supervisor_reasoned":
          metrics.supervisorConfirmations++;
          if (verdict !== "allow") metrics.supervisorConfirmed++;
          metrics.legacyOnly = false;
          break;
        case "supervisor_halt":
        case "supervisor_late":
          metrics.supervisorHalts++;
          break;
        default:
          break;
      }
    }

    const heldRows = db
      .prepare(
        `SELECT payload_json FROM events WHERE type = 'held_step_outcome' ${scope}
         ORDER BY id DESC LIMIT 200000`,
      )
      .all(...bind) as Array<{ payload_json: string }>;

    for (const raw of heldRows) {
      let payload: Record<string, unknown>;
      try {
        payload =
          (JSON.parse(raw.payload_json) as { payload?: Record<string, unknown> }).payload ?? {};
      } catch {
        continue;
      }
      const outcome = String(payload.outcome ?? "");
      if (
        outcome === "ran" ||
        outcome === "skipped" ||
        outcome === "refused" ||
        outcome === "failed"
      ) {
        metrics.heldSteps[outcome]++;
        metrics.heldSteps.total++;
        metrics.legacyOnly = false;
      }
    }

    metrics.screenFalsePositiveRate =
      metrics.supervisorFlags === 0
        ? null
        : (metrics.supervisorFlags - metrics.supervisorConfirmed) / metrics.supervisorFlags;

    const decided = metrics.heldSteps.ran + metrics.heldSteps.skipped;
    metrics.heldStepFalsePositiveRate = decided === 0 ? null : metrics.heldSteps.ran / decided;

    metrics.haltsPerHundredRuns =
      metrics.sessions === 0 ? null : (metrics.supervisorHalts / metrics.sessions) * 100;

    return metrics;
  } catch {
    return { ...EMPTY, heldSteps: { ran: 0, skipped: 0, refused: 0, failed: 0, total: 0 } };
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing depends on a clean close.
    }
  }
}

/** One line for `rune doctor` / `rune audit`. Null values print as "no data". */
export function formatAutoSafetyMetrics(m: AutoSafetyMetrics): string[] {
  const pct = (v: number | null) => (v === null ? "no data" : `${(v * 100).toFixed(1)}%`);
  const per = (v: number | null) => (v === null ? "no data" : v.toFixed(2));
  const lines = [
    `supervisor false-positive kills per 100 runs: ${per(m.haltsPerHundredRuns)} ` +
      `(${m.supervisorHalts} confirmed halt${m.supervisorHalts === 1 ? "" : "s"} over ${m.sessions} session${m.sessions === 1 ? "" : "s"})`,
    `supervisor screen false-positive rate: ${pct(m.screenFalsePositiveRate)} ` +
      `(${m.supervisorFlags} flag${m.supervisorFlags === 1 ? "" : "s"} raised, ${m.supervisorConfirmed} confirmed, ` +
      `over ${m.supervisorScreens} screen${m.supervisorScreens === 1 ? "" : "s"})`,
    `held steps overturned by the user: ${pct(m.heldStepFalsePositiveRate)} ` +
      `(${m.heldSteps.ran} run unchanged, ${m.heldSteps.skipped} left unrun, ` +
      `${m.heldSteps.refused} refused by policy, ${m.heldSteps.failed} failed on their own terms)`,
  ];
  if (m.legacyOnly) {
    lines.push(
      "these rows predate the P6A.1 recording change: supervisor verdicts and held-step outcomes " +
        "were not persisted, so the rates above have no denominator yet",
    );
  }
  return lines;
}
