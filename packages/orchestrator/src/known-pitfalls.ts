// ─── Known pitfalls: the black box read back into the run ───
//
// The fingerprint table has always known which mistakes recur — a sandbox
// denial whose message states the fix was made 19 times across a release —
// but for a month nothing in the engine read it. This is the read path: the
// recurring, MODEL-actionable failures rendered as one short harness note.
// Provider rot and rate limits are the harness's business and stay out.

export interface PitfallRow {
  class: string;
  component: string;
  messageSample: string;
  count: number;
}

/** Failure classes the model can act on. */
export const PITFALL_CLASSES: ReadonlySet<string> = new Set([
  "tool.sandbox_denial",
  "tool.exec_failure",
]);

/** Failures that are the harness's or the provider's to fix, never the model's. */
export const HARNESS_BUSINESS_RE = /rate limit|\b429\b|quota|econnrefused|timed out|stream/i;

export interface PitfallSelection {
  /** Minimum recurrence to be worth a line. */
  minCount?: number;
  /** Lines in the note. */
  limit?: number;
}

export function selectPitfalls(rows: PitfallRow[], opts: PitfallSelection = {}): PitfallRow[] {
  const minCount = opts.minCount ?? 3;
  const limit = opts.limit ?? 3;
  return rows
    .filter(
      (r) =>
        PITFALL_CLASSES.has(r.class) &&
        r.count >= minCount &&
        !HARNESS_BUSINESS_RE.test(r.messageSample),
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function renderPitfallsNote(rows: PitfallRow[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(
    (r) =>
      `- ${r.component.replace(/^tool:/, "")} (${r.count}×): ${r.messageSample.replace(/\s+/g, " ").slice(0, 160)}`,
  );
  return (
    "[Harness note] Recurring mistakes on this machine in the last 30 days — avoid them " +
    `before they cost a turn:\n${lines.join("\n")}`
  );
}
