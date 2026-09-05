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

export type LedgerKind = "measurement" | "promotion" | "revert" | "halt";

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

/**
 * The most recent PASSING measurement for a variant under the exact arm pair a
 * promotion would apply. Returns null when the variant was never measured, when
 * the last measurement lost, or when the configuration has moved since.
 *
 * The hash pair is the whole guard: a measurement of `doctrine_full` taken
 * before someone widened the variant is evidence about a different change.
 */
export function passingMeasurement(
  entries: LedgerEntry[],
  variant: string,
  pair: { control: string; treatment: string },
): LedgerEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== "measurement" || e.subject !== variant) continue;
    if (e.controlConfigHash !== pair.control) continue;
    if (e.treatmentConfigHash !== pair.treatment) continue;
    return e.win === true ? e : null;
  }
  return null;
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
