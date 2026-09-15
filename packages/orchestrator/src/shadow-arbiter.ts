/**
 * The shadow lane — the arbiter watching the guards it does not command.
 *
 * `arbiter.ts` decides; this file watches. It sits beside each guard, takes
 * the booleans that guard just read, asks `decide()` what it WOULD do, records
 * what the guard DID, and writes one bounded row. It moves nothing: no
 * `continue` changes, no counter changes, no prompt, no tool, no spend. The
 * only thing a run gains by having it on is rows, and the only thing the rows
 * are for is the disagreement list M3 migrates from.
 *
 * Four properties the review asked for by name
 * (`guarantees-plan-review-20260914.md`, P1 "a shadow arbiter is described as
 * having zero behavioural risk"):
 *
 *   1. **It cannot act.** The only outward call is `emit`, a row sink. A
 *      throwing sink is swallowed: observability must never break a run.
 *   2. **Its logging is bounded.** 200 decision rows per run, then one
 *      `shadow_capped` row and counting only. No row exceeds 2 KB.
 *   3. **It carries no prose.** Inputs are sanitised to booleans, finite
 *      numbers and a short allowlist of enum words. Message text, tool
 *      arguments, file contents, halt reasons and credentials cannot reach a
 *      row because there is no path for a string that is not an enum word.
 *   4. **Its overhead is measured, not asserted away.** Every observation is
 *      timed, and the summary reports p50/p95/total. No threshold is claimed.
 *
 * Simultaneity: events are buffered per STEP (the loop's turn number) and
 * resolved by `arbitrate` when the step closes — lowest class wins, earlier
 * seq breaks the tie, the losers are kept with `supersededBy`. A winner whose
 * transition is terminal makes the arbiter's own phase terminal, and every
 * later event on that run decides `unknown: run already terminal`.
 */

import {
  GUARD_CLASS,
  UNSHADOWED_GUARDS,
  arbitrate,
  decide,
  isTerminalTransition,
  makeShadowEvent,
  type Decision,
  type GuardId,
  type GuardInputs,
  type ShadowEvent,
  type Transition,
} from "./arbiter";
import { withPhase, type RunState } from "./run-state";

// ─── The rows ───

export const SHADOW_ROW_VERSION = 1 as const;

/** Decision rows per run before the cap closes the ledger. */
export const SHADOW_ROW_CAP = 200;

/** Hard size ceiling for any one row, in bytes of JSON. */
export const SHADOW_ROW_MAX_BYTES = 2048;

/** How many disagreements the summary carries before the size ceiling trims it. */
const SUMMARY_DISAGREEMENTS = 40;

export interface ShadowDecisionRow {
  readonly type: "shadow_decision";
  readonly version: 1;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly guard: string;
  readonly class: number;
  readonly inputs: Record<string, unknown>;
  readonly decision: Transition;
  readonly reason: string;
  readonly actual: Transition;
  readonly agree: boolean;
  readonly applied: false;
  readonly supersededBy?: string;
  readonly overheadUs: number;
}

export interface ShadowCappedRow {
  readonly type: "shadow_capped";
  readonly version: 1;
  readonly runId: string;
  readonly at: string;
  readonly cap: number;
}

export interface ShadowSummaryRow {
  readonly type: "shadow_summary";
  readonly version: 1;
  readonly runId: string;
  readonly at: string;
  readonly events: number;
  readonly agreements: number;
  readonly disagreements: number;
  readonly unknowns: number;
  readonly superseded: number;
  /** Events past `SHADOW_ROW_CAP`: counted, not written. */
  readonly capped: number;
  /** Guards §4.3 says need surgery that this run actually reached. */
  readonly unshadowed: string[];
  /** Each disagreement, named: guard, what the arbiter would have done, what
   *  the guard did. Bounded — the rows carry the rest. */
  readonly disagreementList: Array<{ guard: string; expected: Transition; actual: Transition }>;
  readonly overheadUs: { p50: number; p95: number; total: number };
  /**
   * What the ROW SINK cost, cumulatively (V6 finding 19, the other half).
   *
   * `overheadUs` is the arbiter's own compute — sanitise, event build, decide.
   * Writing the row is the embedder's cost: in the Engine a synchronous
   * `appendEvent` insert, up to 202 per run, and folding it into `overheadUs`
   * would report a slow database as a slow arbiter. Reporting it nowhere was
   * the other half of the same dishonesty, because the audit line then said
   * "a few microseconds" about a run that spent 50 ms writing one row.
   */
  readonly sinkUs: number;
}

export type ShadowRow = ShadowDecisionRow | ShadowCappedRow | ShadowSummaryRow;

/** What the loop is handed. Deliberately three methods wide: a loop that can
 *  only observe cannot be made to act by a later edit. */
export interface ShadowObserver {
  observe(guard: GuardId, inputs: GuardInputs, actual: Transition, state: RunState): void;
  unshadowed(guard: string): void;
  finish(): void;
}

// ─── Input sanitising ───

/**
 * Enum-valued inputs, by key, with the words each may carry.
 *
 * An allowlist rather than a length check: "it is short" is not a property
 * that keeps a credential out of a row, and a halt reason is broker prose that
 * happens to be short. A key not listed here can never carry a string.
 */
const ENUM_INPUTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["verdictKind", new Set(["met", "partial", "unmet", "none"])],
  [
    "stopReason",
    new Set([
      "end_turn",
      "max_turns",
      "max_tokens",
      "aborted",
      "halted",
      "provider_lost",
      "open_steps",
      "stalled",
      "budget",
      "barren",
      "loop_detected",
      "tool_use",
    ]),
  ],
  ["breachKind", new Set(["cost", "time"])],
]);

export const OMITTED = "<omitted>";

/**
 * Keep booleans, finite numbers and allowlisted enum words; omit everything
 * else. This is the function the "no row carries message text, tool arguments,
 * file contents or credentials" promise rests on, so it is total: there is no
 * branch that passes an arbitrary string through.
 */
export function sanitizeInputs(inputs: GuardInputs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "string" && ENUM_INPUTS.get(key)?.has(value)) {
      out[key] = value;
    } else if (value === null || value === undefined) {
      // An absent input is a FACT the arbiter decides on (S5), so it is kept
      // as null rather than dropped — `undefined` would vanish in JSON.
      out[key] = null;
    } else {
      out[key] = OMITTED;
    }
  }
  return out;
}

// ─── The clock ───

/** Microseconds, monotonic where the runtime offers it. */
function nowUs(): number {
  const ns = (globalThis as { Bun?: { nanoseconds?: () => number } }).Bun?.nanoseconds;
  if (typeof ns === "function") return ns() / 1000;
  return performance.now() * 1000;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

// ─── The observer ───

export interface ShadowArbiterOptions {
  runId: string;
  /** Row sink. Throwing is contained — a trace row may never fail a turn. */
  emit: (row: ShadowRow) => void;
  /** ISO clock, injectable so tests are deterministic. */
  now?: () => string;
  cap?: number;
}

interface Pending {
  event: ShadowEvent;
  actual: Transition;
  /** What this observation cost the arbiter, measured inside `observe`. */
  observeUs: number;
}

export class ShadowArbiter implements ShadowObserver {
  private readonly runId: string;
  private readonly emit: (row: ShadowRow) => void;
  private readonly now: () => string;
  private readonly cap: number;

  private seq = 0;
  /** The arbiter's OWN phase — its running opinion, never the run's state. */
  private phase: RunState["phase"] | null = null;
  private step: number | null = null;
  private pending: Pending[] = [];
  /** The snapshot the current step's events were observed against. */
  private lastState: RunState | null = null;

  private written = 0;
  private cappedCount = 0;
  private cappedRowWritten = false;
  private events = 0;
  private agreements = 0;
  private disagreements = 0;
  private unknowns = 0;
  private supersededCount = 0;
  private readonly overheads: number[] = [];
  private readonly unshadowedSeen = new Set<string>();
  private readonly disagreementList: ShadowSummaryRow["disagreementList"] = [];
  /** What the embedder's row sink has cost so far, in microseconds. */
  private sinkUs = 0;
  private finished = false;

  constructor(options: ShadowArbiterOptions) {
    this.runId = options.runId;
    this.emit = options.emit;
    this.now = options.now ?? (() => new Date().toISOString());
    this.cap = options.cap ?? SHADOW_ROW_CAP;
  }

  /**
   * One guard trigger: the predicate's own inputs, what the guard did, and the
   * state as the site could read it.
   *
   * Never throws. A shadow lane that can fail a run is not a shadow lane.
   */
  observe(guard: GuardId, inputs: GuardInputs, actual: Transition, state: RunState): void {
    if (this.finished) return;
    const startedUs = nowUs();
    try {
      const stepOf = state.budget.turn ?? 0;
      if (this.step !== null && stepOf !== this.step) this.flush();
      this.step = stepOf;
      this.lastState = state;
      this.seq += 1;
      const event = makeShadowEvent(
        this.runId,
        this.seq,
        guard,
        sanitizeInputs(inputs),
        this.now(),
      );
      // The arbiter's OWN cost of this observation, and nothing else (V6
      // finding 19). `startedUs` used to be read in `record()`, which runs at
      // the NEXT step's flush — so 120ms of loop work between two observations
      // was billed to the shadow lane, and `rune audit` reported it as the
      // arbiter's overhead.
      this.pending.push({ event, actual, observeUs: nowUs() - startedUs });
    } catch {
      // Observability must never break the loop.
    }
  }

  /** A guard §4.3 says needs surgery before it can be shadowed, seen once. */
  unshadowed(guard: string): void {
    if (this.finished) return;
    if (!UNSHADOWED_GUARDS.has(guard)) return;
    this.unshadowedSeen.add(guard);
  }

  /** Close the last step and write the summary. Idempotent. */
  finish(): void {
    if (this.finished) return;
    try {
      this.flush();
      this.finished = true;
      const sorted = [...this.overheads].sort((a, b) => a - b);
      const total = sorted.reduce((sum, v) => sum + v, 0);
      const summary: ShadowSummaryRow = {
        type: "shadow_summary",
        version: SHADOW_ROW_VERSION,
        runId: this.runId,
        at: this.now(),
        events: this.events,
        agreements: this.agreements,
        disagreements: this.disagreements,
        unknowns: this.unknowns,
        superseded: this.supersededCount,
        capped: this.cappedCount,
        unshadowed: [...this.unshadowedSeen].sort(),
        disagreementList: this.disagreementList.slice(0, SUMMARY_DISAGREEMENTS),
        overheadUs: {
          p50: round(percentile(sorted, 50)),
          p95: round(percentile(sorted, 95)),
          total: round(total),
        },
        sinkUs: round(this.sinkUs),
      };
      this.write(boundSummary(summary));
    } catch {
      // As above: a summary is a reading of the run.
    }
  }

  /** The step's events, resolved by the ladder and written out. */
  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    // Every event in a step is decided against the SAME snapshot phase: the
    // arbiter's own running opinion, which is terminal only once a winner said
    // so. `withPhase` copies; nothing the run holds is touched.
    const base = this.lastState;
    const snapshot = base ? (this.phase ? withPhase(base, this.phase) : base) : undefined;
    // The other half of the arbiter's own cost: the decide calls, timed here
    // and nowhere else. The sink is deliberately outside both windows — a
    // 50ms row sink is the EMBEDDER's cost, and folding it in would report a
    // slow database as a slow arbiter — but so is the loop's work, which the
    // old window folded in.
    const decideStartedUs = nowUs();
    const decisions = batch.map(({ event }) => decide(snapshot, event));
    const decideUs = (nowUs() - decideStartedUs) / Math.max(1, batch.length);
    const events = batch.map((p) => p.event);
    const { winner, superseded } = arbitrate(decisions, events);
    const bySupersede = new Map(superseded.map((d) => [d.eventId, d]));

    for (const item of batch) {
      const decision = bySupersede.get(item.event.id) ?? winner;
      this.record(item, decision, decideUs);
    }
    this.supersededCount += superseded.length;
    if (isTerminalTransition(winner.transition)) {
      this.phase = winner.transition.startsWith("complete(") ? "complete" : "abandoned";
    }
  }

  private record(item: Pending, decision: Decision, decideUs: number): void {
    this.events += 1;
    const agree = decision.transition === item.actual;
    if (decision.transition === "unknown") this.unknowns += 1;
    else if (agree) this.agreements += 1;
    else {
      this.disagreements += 1;
      if (this.disagreementList.length < 40) {
        this.disagreementList.push({
          guard: item.event.guard,
          expected: decision.transition,
          actual: item.actual,
        });
      }
    }
    const overheadUs = round(item.observeUs + decideUs);
    this.overheads.push(overheadUs);

    if (this.written >= this.cap) {
      this.cappedCount += 1;
      if (!this.cappedRowWritten) {
        this.cappedRowWritten = true;
        this.write({
          type: "shadow_capped",
          version: SHADOW_ROW_VERSION,
          runId: this.runId,
          at: this.now(),
          cap: this.cap,
        });
      }
      return;
    }
    this.written += 1;
    this.write(
      bound({
        type: "shadow_decision",
        version: SHADOW_ROW_VERSION,
        runId: this.runId,
        seq: item.event.seq,
        at: item.event.at,
        guard: item.event.guard,
        class: GUARD_CLASS[item.event.guard],
        inputs: item.event.inputs as Record<string, unknown>,
        decision: decision.transition,
        reason: decision.reason,
        actual: item.actual,
        agree,
        applied: false,
        ...(decision.supersededBy ? { supersededBy: decision.supersededBy } : {}),
        overheadUs,
      }),
    );
  }

  private write(row: ShadowRow): void {
    const startedUs = nowUs();
    try {
      this.emit(row);
    } catch {
      // A trace row is observability. Losing one must never fail a turn.
    } finally {
      this.sinkUs += nowUs() - startedUs;
    }
  }
}

function round(us: number): number {
  return Math.round(us * 10) / 10;
}

/** Keep a row under the size ceiling by dropping the one field that can grow. */
function bound(row: ShadowDecisionRow): ShadowDecisionRow {
  if (JSON.stringify(row).length <= SHADOW_ROW_MAX_BYTES) return row;
  const trimmed: ShadowDecisionRow = {
    ...row,
    inputs: { truncated: true, keys: Object.keys(row.inputs).length },
    reason: row.reason.slice(0, 200),
  };
  return trimmed;
}

/**
 * Keep the summary under the same ceiling every other row keeps (V6 finding 18).
 *
 * S6 asserted "no row > 2 KB" and drove ONE agreeing event, so its summary was
 * near-empty and the assertion held vacuously: forty recorded disagreements
 * made a 3,135-byte row, because `disagreementList` was the one growing field
 * that never went through `bound`. It is dropped from the END — the earliest
 * disagreements are the ones a reader wants — and `disagreements` still
 * carries the true count, so a list shorter than that count says plainly that
 * it was trimmed.
 */
function boundSummary(row: ShadowSummaryRow): ShadowSummaryRow {
  let list = row.disagreementList;
  let trimmed: ShadowSummaryRow = row;
  while (list.length > 0 && JSON.stringify(trimmed).length > SHADOW_ROW_MAX_BYTES) {
    list = list.slice(0, list.length - 1);
    trimmed = { ...row, disagreementList: list };
  }
  return trimmed;
}

/**
 * The summary, as one block a person reads — used by `rune audit` and by the
 * report the lane owes. Pure formatting; no colour, so the caller paints.
 */
export function shadowSummaryLines(row: ShadowSummaryRow): string[] {
  const lines = [
    `events ${row.events} · agree ${row.agreements} · disagree ${row.disagreements} · ` +
      `unknown ${row.unknowns} · superseded ${row.superseded}` +
      (row.capped > 0 ? ` · capped ${row.capped}` : ""),
    `overhead p50 ${row.overheadUs.p50}µs · p95 ${row.overheadUs.p95}µs · total ${row.overheadUs.total}µs` +
      (row.sinkUs > 0 ? ` · row sink ${round(row.sinkUs)}µs` : ""),
  ];
  for (const d of row.disagreementList.slice(0, 8)) {
    lines.push(`${d.guard}: arbiter ${d.expected} · guard ${d.actual}`);
  }
  if (row.unshadowed.length > 0) lines.push(`not shadowed here: ${row.unshadowed.join(", ")}`);
  return lines;
}
