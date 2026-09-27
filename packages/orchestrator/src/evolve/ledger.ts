// ─── The evolution ledger: what was measured, what changed, and why ───
//
// One append-only JSONL file at `~/.rune/evolve-ledger.jsonl`. Every row is a
// fact with a timestamp: a measurement that happened, a promotion that acted on
// one, a revert that undid it, a halt that stopped the loop.
//
// Append-only is the point. A ledger you can rewrite is a ledger that can be
// made to say the change was justified, and "why does it believe this" has to
// survive the belief turning out to be wrong. Reverts are recorded as new rows,
// never as deletions.
//
// The file is small by construction — one row per measurement — and readable
// with `tail`. That matters more here than any binary format would: the person
// who has to disagree with a promotion at 2am should not need a tool.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRuneHome } from "@rune/shared";

export const LEDGER_FILE = "evolve-ledger.jsonl";

/**
 * `lesson` rows record a person disabling or re-enabling a notebook lesson
 * (`rune evolve lessons --disable/--enable`): the same "why does it believe
 * this" history, for the other half of what the loop learns.
 */
export type LedgerKind = "measurement" | "promotion" | "revert" | "halt" | "lesson";

export interface LedgerEntry {
  v: 1;
  at: string;
  kind: LedgerKind;
  /** Variant id, or a lesson id for lifecycle rows. */
  subject: string;
  /** Config digest of the control arm — always the defaults. */
  controlConfigHash?: string | null;
  /** Config digest of the treatment arm. The pair is the promotion's key. */
  treatmentConfigHash?: string | null;
  /** Which doctrine the measurement ran under. */
  doctrineHash?: string | null;
  /** Digest of `tests/eval/**` at measurement time — the ruler used. */
  yardstick?: string | null;
  mode?: "mock" | "real";
  /** Measurement rows only: did every gate pass? */
  win?: boolean;
  /**
   * Measurement rows: the run could not answer its question — nothing was
   * comparable on both arms, most of the suite went unscored, or a cost was
   * unknown. Not a win, and not a loss either: it closes nothing.
   */
  inconclusive?: boolean;
  /**
   * Measurement rows: what the experiment itself cost at list rates — both
   * arms, excluded and interrupted rows included. Learning is not free, and a
   * loop that hid its own spend could not be weighed against what it found.
   */
  learningCostUsd?: number | null;
  /** The checkout's commit when measured, with `+dirty` when the tree had changes. */
  revision?: string | null;
  /** The Rune version of the process that measured. */
  runeVersion?: string | null;
  rateDelta?: number;
  costDelta?: number | null;
  compared?: number;
  fixes?: string[];
  regressions?: string[];
  /** Every gate that refused, verbatim. */
  refusals?: string[];
  /** The `~/.rune/config.toml` lines a promotion wrote. */
  configLines?: string[];
  /** Free text: the reason for a revert, the reason for a halt. */
  note?: string;
}

export function ledgerPath(home: string = getRuneHome()): string {
  return join(home, LEDGER_FILE);
}

export function appendLedger(entry: LedgerEntry, home: string = getRuneHome()): void {
  const path = ledgerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Every row, oldest first. A corrupt line is SKIPPED, not fatal: a truncated
 * write at the end of the file must not make the history unreadable, which is
 * exactly when you need it.
 */
export function readLedger(home: string = getRuneHome()): LedgerEntry[] {
  const path = ledgerPath(home);
  if (!existsSync(path)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LedgerEntry;
      if (parsed && parsed.v === 1 && typeof parsed.kind === "string") out.push(parsed);
    } catch {
      // A half-written last line is not a reason to lose the history.
    }
  }
  return out;
}

/** Promotions that have not since been reverted, newest first. */
export function activePromotions(entries: LedgerEntry[]): LedgerEntry[] {
  const reverted = new Set<string>();
  const active: LedgerEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "revert") reverted.add(e.subject);
    else if (e.kind === "promotion") {
      if (reverted.has(e.subject)) reverted.delete(e.subject);
      else active.push(e);
    }
  }
  return active;
}

/** What a promotion's evidence must match. */
export interface PromotionKey {
  control: string;
  treatment: string;
  /** The doctrine in force now. Omitted = not checked. */
  doctrineHash?: string | null;
  /** The yardstick a human blessed. Omitted = not checked. */
  yardstick?: string | null;
}

/**
 * The measurement a promotion may stand on — or why there is none.
 *
 * One predefined comparison has one answer. The rows that can answer are the
 * live (`real`) measurements of this exact arm pair taken under the doctrine
 * in force now and against the blessed yardstick:
 *
 *   · the hash pair — a measurement of `doctrine_full` taken before someone
 *     widened the variant is evidence about a different change;
 *   · the doctrine and the yardstick — evidence about a prompt or a ruler
 *     that is no longer in force is evidence about something else;
 *   · real mode — the scripted provider replays a script rather than
 *     reasoning, so mock can show harm, never lift;
 *   · no conclusive loss among them — a win recorded after a loss is a
 *     second look at an answered question, and a win the next run failed to
 *     replicate was noise. Inconclusive rows close nothing.
 */
export function promotionEvidence(
  entries: LedgerEntry[],
  variant: string,
  key: PromotionKey,
): { measurement: LedgerEntry | null; refusal: string | null } {
  const pairRows = entries.filter(
    (e) =>
      e.kind === "measurement" &&
      e.subject === variant &&
      e.controlConfigHash === key.control &&
      e.treatmentConfigHash === key.treatment,
  );
  if (pairRows.length === 0) {
    return {
      measurement: null,
      refusal: `no passing A/B in the ledger for ${variant} at this exact configuration (control ${key.control} → treatment ${key.treatment}). Run \`rune evolve ab ${variant} --real\` first; a measurement of an older shape of this variant is evidence about a different change.`,
    };
  }

  const doctrineOk = (e: LedgerEntry) =>
    key.doctrineHash === undefined || (e.doctrineHash ?? null) === key.doctrineHash;
  const yardstickOk = (e: LedgerEntry) =>
    key.yardstick === undefined || (e.yardstick ?? null) === key.yardstick;
  const current = pairRows.filter((e) => doctrineOk(e) && yardstickOk(e));
  if (current.length === 0) {
    const last = pairRows[pairRows.length - 1]!;
    const moved: string[] = [];
    if (!doctrineOk(last)) {
      moved.push(
        `doctrine (measured under ${last.doctrineHash ?? "an unrecorded doctrine"}, now ${key.doctrineHash ?? "unknown"})`,
      );
    }
    if (!yardstickOk(last)) {
      moved.push(
        `yardstick (measured against ${last.yardstick ?? "an unrecorded suite"}, blessed ${key.yardstick ?? "never"})`,
      );
    }
    return {
      measurement: null,
      refusal: `every measurement of ${variant} at this configuration ran under a different ${moved.join(" and ")}: the evidence is about a prompt or a ruler no longer in force. Re-measure.`,
    };
  }

  const live = current.filter((e) => e.mode === "real");
  if (live.length === 0) {
    return {
      measurement: null,
      refusal: `${variant} has only mock-mode measurements here. The scripted provider replays a script rather than reasoning, so mock can show harm, never lift; promotion needs \`rune evolve ab ${variant} --real\`.`,
    };
  }

  const loss = [...live].reverse().find((e) => e.win !== true && e.inconclusive !== true);
  if (loss) {
    return {
      measurement: null,
      refusal: `a live measurement of ${variant} at this exact configuration, doctrine and yardstick lost on ${loss.at.slice(0, 10)} (${loss.refusals?.[0] ?? "no gate recorded"}). One predefined comparison has one answer: a win after it is a second look at an answered question, and a win it failed to replicate was noise. Ask a new question — change the variant, or a person re-blesses the yardstick.`,
    };
  }

  const win = [...live].reverse().find((e) => e.win === true) ?? null;
  if (!win) {
    return {
      measurement: null,
      refusal: `no conclusive live measurement of ${variant} yet: ${live.length} run${live.length === 1 ? " was" : "s were"} inconclusive. Run \`rune evolve ab ${variant} --real\` again.`,
    };
  }
  return { measurement: win, refusal: null };
}

/**
 * What learning has cost so far: the list-rate spend of every measurement the
 * ledger records, wins and losses alike. Rows from before the field existed
 * count as nothing and say so by being absent, not by guessing.
 */
export function learningSpend(entries: LedgerEntry[]): number {
  let total = 0;
  for (const e of entries) {
    if (e.kind !== "measurement") continue;
    const cost = e.learningCostUsd;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total;
}

/**
 * Two consecutive reverts halt the loop.
 *
 * The reasoning is not "two is a magic number" — it is that a loop which keeps
 * promoting changes a human keeps undoing has a broken fitness function, and
 * the correct response to a broken measurement is to stop measuring, not to
 * measure harder. Clearing it is a human act (`rune evolve resume`).
 */
export function haltState(entries: LedgerEntry[]): { halted: boolean; reason?: string } {
  // Which promotions are still standing — a promotion that was later reverted
  // is accounted for by that revert and must not read as "something survived".
  const active = new Set(activePromotions(entries).map((e) => e.subject));
  const reverted: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    // A human resumed the loop: everything before this row is settled.
    if (e.kind === "halt" && e.note === "resumed") return { halted: false };
    if (e.kind === "promotion") {
      // Something the human let stand: the streak is broken.
      if (active.has(e.subject)) return { halted: false };
      continue;
    }
    if (e.kind !== "revert") continue;
    reverted.push(e.subject);
    if (reverted.length >= 2) {
      return {
        halted: true,
        reason: `two consecutive reverts (${reverted.join(", then ")}, read newest first) — the loop promoted changes a human undid twice, which is a broken fitness function, not bad luck`,
      };
    }
  }
  return { halted: false };
}

/** The last promotion, whatever became of it — for the interval check. */
export function lastPromotion(entries: LedgerEntry[]): LedgerEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === "promotion") return entries[i]!;
  }
  return null;
}
