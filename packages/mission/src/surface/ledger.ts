// ─── Gear · the ledger ───
// What replaces the always-on dashboard panel.
//
// The obvious layout for an autonomous agent is a stream on the left and a mission
// panel on the right, always visible. It fails in a specific way: when work is steady
// the panel says the same thing for four minutes and becomes furniture, and when
// something changes it changes in your peripheral vision while you are reading the
// stream. A panel that is right most of the time is worse than no panel, because you
// stop checking it.
//
// So the panel is compressed to the last row of the terminal: eighty characters of
// mission state that are always current and always true, and that name the key which
// expands them. The panel still exists. It is one line until you ask.

import { count, dur } from "../format";
import { type MissionState, blockers, closedPhases, elapsedMs, runningAgents } from "../reduce";
import { type Row, type Span, pair } from "../render/row";
import { type Caps } from "../render/caps";

export interface LedgerOptions {
  caps: Caps;
  /** what to press. always printed, because there are no hidden shortcuts. */
  hint?: string;
  now?: number;
}

/**
 * One row where it fits. Every field is a count of things that either happened or did
 * not — the reason it can be trusted after four minutes of not looking at it.
 *
 * Where it does not fit, it becomes two: the counts on one row and the keys on the
 * next, each still in a column. The one thing that never happens is squeezing, because
 * a ledger that has been elided is exactly as useless as no ledger at all.
 */
export function ledger(state: MissionState, opts: LedgerOptions): Row[] {
  const { caps } = opts;
  const total = state.phases.length;
  const done = closedPhases(state);
  const held = blockers(state);
  const hint = opts.hint ?? (held ? "⏎ decide" : "⇥ inspect   ⌃c pause");
  const elapsed = dur(opts.now ? opts.now - (state.openedAt ?? opts.now) : elapsedMs(state));

  const phases: Span[] = [
    { t: "  " },
    { t: String(done).padStart(2, "0"), c: "strong" },
    { t: ` / ${String(total).padStart(2, "0")}`, c: "dim" },
  ];
  // A blocker is the one count that changes colour, because it is the one that means
  // the mission is waiting on a human rather than on a machine.
  const counts: Span[] = [
    { t: "  ·  ", c: "dim" },
    { t: count(runningAgents(state), "agent"), c: "dim" },
    { t: "  ·  ", c: "dim" },
    { t: count(state.findings.length, "finding"), c: "dim" },
    { t: "  ·  ", c: "dim" },
    { t: count(held, "blocker"), c: held ? "warn" : "dim" },
  ];

  const one = pair(
    [...phases, ...counts, { t: "  ·  ", c: "dim" }, { t: elapsed, c: "dim" }],
    [{ t: hint + "  ", c: "dim" }],
    caps,
  );
  if (one.length === 1) return [{ ...one[0]!, live: true }];

  // Narrow: the blocker count keeps its place, the elapsed keeps its column, and the
  // keys drop to their own row rather than any of them being cut.
  const narrow = pair(
    [...phases, ...counts.slice(0, 4)],
    [{ t: elapsed, c: "dim" }, { t: "  " }],
    caps,
  );
  const keys = pair(
    [{ t: "  " }, { t: hint.split("   ")[0] ?? hint, c: "dim" }],
    [{ t: (hint.split("   ")[1] ?? "") + "  ", c: "dim" }],
    caps,
  );
  return [...narrow, ...keys].map((r) => ({ ...r, live: true }));
}
