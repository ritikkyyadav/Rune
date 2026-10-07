import type { Pairing } from "./aggregate";
import { quality, type ParityRunResult } from "./types";

export interface ArmEconomics {
  attempts: number;
  cleanCompletions: number;
  /** Sum of priced attempts only; null when there were no priced attempts. */
  knownListUsd: number | null;
  unknownPriceAttempts: number;
  /** All attempts charged to each clean completion; requires complete pricing. */
  usdPerCleanCompletion: number | null;
  medianWallMs: number | null;
  p90WallMs: number | null;
}

export interface ModeEconomics {
  rune: ArmEconomics;
  comparator: ArmEconomics;
  jointlyCleanPairs: number;
  /** Median of Rune / comparator per pair; null unless every joint pair is priced. */
  pairedCostRatio: number | null;
  /** Median of Rune / comparator per pair. */
  pairedWallRatio: number | null;
}

const cleanCompletion = (r: ParityRunResult): boolean =>
  r.scored && quality(r.outcome) === 1 && r.clean && r.scope !== 0;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function armEconomics(rows: readonly ParityRunResult[]): ArmEconomics {
  const cleanCompletions = rows.filter(cleanCompletion).length;
  const priced = rows.filter((r) => r.listUsd !== null);
  const knownListUsd = priced.length ? priced.reduce((sum, r) => sum + r.listUsd!, 0) : null;
  const wall = rows.map((r) => r.wallMs).sort((a, b) => a - b);
  const unknownPriceAttempts = rows.length - priced.length;
  return {
    attempts: rows.length,
    cleanCompletions,
    knownListUsd,
    unknownPriceAttempts,
    usdPerCleanCompletion:
      cleanCompletions > 0 && unknownPriceAttempts === 0 && knownListUsd !== null
        ? knownListUsd / cleanCompletions
        : null,
    medianWallMs: median(wall),
    p90WallMs: wall.length ? wall[Math.ceil(0.9 * wall.length) - 1]! : null,
  };
}

/** Descriptive attempt economics; pairs use only the latest attempts. */
export function modeEconomics(pairing: Pairing): ModeEconomics {
  const joint = pairing.pairs.filter(
    (pair) => cleanCompletion(pair.rune) && cleanCompletion(pair.comparator),
  );
  const priced = joint.filter(
    (pair) => pair.rune.listUsd !== null && pair.comparator.listUsd !== null,
  );
  const costDenominatorsValid = priced.every((pair) => pair.comparator.listUsd! > 0);
  const wallDenominatorsValid = joint.every((pair) => pair.comparator.wallMs > 0);
  return {
    rune: armEconomics(pairing.rows.rune),
    comparator: armEconomics(pairing.rows.comparator),
    jointlyCleanPairs: joint.length,
    pairedCostRatio:
      joint.length && priced.length === joint.length && costDenominatorsValid
        ? median(priced.map((pair) => pair.rune.listUsd! / pair.comparator.listUsd!))
        : null,
    pairedWallRatio:
      joint.length && wallDenominatorsValid
        ? median(joint.map((pair) => pair.rune.wallMs / pair.comparator.wallMs))
        : null,
  };
}
