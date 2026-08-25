// ─── /interactive command support ───
//
// Shared by the classic CLI and the TUI:
//   - the sidecar that persists the autonomy toggle (~/.gear/interactive.json,
//     same pattern as theme.json — config.ts only ships a TOML *reader*),
//   - the directive a bare /interactive sends through the normal turn loop,
//   - the post-turn heuristic that offers "/interactive" after data-heavy
//     answers when autonomy is off.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getGearHome } from "@gear/shared";

function sidecarFile(dir: string): string {
  return join(dir, "interactive.json");
}

/** Persist the autonomy toggle. Never throws — persistence loss must not crash the UI. */
export function saveInteractiveAuto(auto: boolean, dir: string = getGearHome()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(sidecarFile(dir), JSON.stringify({ auto }, null, 2) + "\n");
  } catch {
    // in-memory toggle still applied
  }
}

/** Read the saved toggle; null when absent/corrupt (fall through to config). */
export function loadInteractiveAuto(dir: string = getGearHome()): boolean | null {
  try {
    const path = sidecarFile(dir);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { auto?: unknown };
    return typeof parsed.auto === "boolean" ? parsed.auto : null;
  } catch {
    return null;
  }
}

/**
 * The synthetic user turn a bare `/interactive [focus]` submits: it rides the
 * normal agent loop, so permissions, streaming, and rendering all behave as
 * for a typed request.
 */
export function buildInteractiveDirective(focus?: string): string {
  const scope = focus?.trim()
    ? `Focus on: ${focus.trim()}.`
    : "Visualize the most recent report, analysis, or data in this conversation. " +
      "If there isn't any yet, say so briefly and ask what to visualize instead of inventing data.";
  return (
    "Build an interactive dashboard with the interactive_dashboard tool. " +
    scope +
    ' If a dashboard for this content already exists, update it (action:"update") instead of creating another. ' +
    "Compose it per the design charter — headline KPIs, a hero chart beside its breakdown, then depth — " +
    "set an accent that fits the subject, choose the chart types that fit the data, " +
    "and keep the text reply to a couple of lines plus the URL."
  );
}

// ── Offer heuristic ──
//
// After a turn ends (autonomy off, no dashboard built), decide whether the
// final answer is "data-shaped" enough to earn a one-line /interactive tip.
// Deliberately conservative: the tip must feel earned, never nagging.

/** Minimum body lines before an answer can qualify. */
const MIN_LINES = 12;
/** Minimum numeric tokens across the answer. */
const MIN_NUMBERS = 10;
/** Alternative gate: markdown table rows alone qualify. */
const MIN_TABLE_ROWS = 4;

/**
 * True when `answer` reads like a data-heavy report that would benefit from
 * an interactive view: long enough, and either table-shaped or dense with
 * numbers spread across multiple lines. Code blocks are stripped first —
 * code is numeric but charts of it are nonsense.
 */
export function shouldOfferInteractive(answer: string): boolean {
  if (!answer) return false;
  const withoutCode = answer.replace(/```[\s\S]*?```/g, "");
  const lines = withoutCode.split("\n").filter((l) => l.trim());
  if (lines.length < MIN_LINES) return false;

  const tableRows = lines.filter((l) => /^\s*\|.*\|/.test(l)).length;
  if (tableRows >= MIN_TABLE_ROWS) return true;

  // Numeric density: count number-ish tokens (42, 3.14, 87%, 1,024, $12k)…
  const numbers = withoutCode.match(/(?<![\w./-])\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  if (numbers.length < MIN_NUMBERS) return false;
  // …but require them spread across several lines, not one big code-ish dump.
  const numericLines = lines.filter((l) => /(?<![\w./-])\$?\d[\d,]*(?:\.\d+)?%?/.test(l)).length;
  return numericLines >= 5;
}
