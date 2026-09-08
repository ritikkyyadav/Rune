// ─── Rendering the read-back ───
// The block the agent commits BEFORE it opens a file: what it understood, what
// it will leave alone, and how it will know it is done. Three rows -- reading,
// leave, done when -- and a fourth for `touch` only when the model named it.
// It used to open with a phase banner and close with a key legend, and cost
// nine rows before the first row of work; the picker that follows it already
// says what the keys do, and the product's thesis does not need a heading.
//
// Two things about this layout are load-bearing rather than decorative. The
// labels are a fixed-width column, so `touch` / `leave` / `done when` line up
// and the eye can drop straight to the one that matters. And `leave` renders
// even when the model gave nothing for it — as an explicit "nothing stated",
// because an absent exclusion list should look like an omission, not like a
// considered decision that there was nothing to exclude.

import { bold, faint, muted, text, accent, warn } from "./theme";
import { truncate, wrap } from "./render";
import { glyph } from "./glyphs";
import * as F from "./flow";
import type { Brief, BriefLedger } from "../../brief";
import { RUNG_GLYPH, type ClaimRung } from "../../brief";

const LABEL_W = 10;

/** The one separator this file is allowed, taken from the closed budget rather
 *  than typed as a literal — which is what the glyph-budget test enforces, and
 *  what keeps this readable on a serial console. */
const SEP = () => ` ${glyph("observed")} `;

function label(name: string): string {
  return faint(name.padEnd(LABEL_W));
}

function body(width: number, s: string, indent: string = F.MARK): string[] {
  return wrap(s, Math.max(20, width - indent.length)).map((line) => indent + text(line));
}

/** The read-back, as committed scrollback: three labelled rows. */
export function renderReadBack(brief: Brief, width = F.measure()): string {
  const rows: string[] = [];
  const reading = body(width, brief.reading, F.MARK + " ".repeat(LABEL_W));
  rows.push(`${F.MARK}${label("reading")}${reading[0]?.slice(F.MARK.length + LABEL_W) ?? ""}`);
  rows.push(...reading.slice(1));

  if (brief.touch.length > 0) {
    rows.push(
      `${F.MARK}${label("touch")}${text(truncate(brief.touch.join(SEP()), width - LABEL_W - 4))}`,
    );
  }
  // Always rendered. An empty exclusion list is information, not a blank.
  rows.push(
    brief.leave.length > 0
      ? `${F.MARK}${label("leave")}${text(truncate(brief.leave.join(SEP()), width - LABEL_W - 4))}`
      : `${F.MARK}${label("leave")}${warn("nothing stated")}`,
  );
  rows.push(
    `${F.MARK}${label("done when")}${text(truncate(brief.criteria.map((c) => c.text).join(SEP()), width - LABEL_W - 4))}`,
  );
  return rows.join("\n");
}

/** One row of the close: the criterion, its rung, and what moved it. */
function closeRow(
  text_: string,
  rung: ClaimRung | null,
  receipt: string,
  width: number,
  paint: (s: string) => string,
): string[] {
  const mark = rung ? RUNG_GLYPH[rung].utf8 : " ";
  const head = `${F.MARK}${paint(mark)} ${text(truncate(text_, Math.max(20, width - 34)))}`;
  return [head, `${F.RAIL_IN}${faint(truncate(receipt, width - 8))}`];
}

/**
 * The close: the SAME criteria, in the SAME order as the read-back, each with
 * the evidence that moved it. Not a summary the model wrote — a ledger the
 * runtime filled in. A criterion with no evidence renders blank-marked and says
 * so, which is the honest shape for "not met" and is why this cannot be used to
 * announce success that did not happen.
 */
export function renderClose(ledger: BriefLedger, width = F.measure()): string {
  const close = ledger.close();
  const rows: string[] = [];
  const done = close.met === close.total && close.total > 0;
  rows.push(
    F.flowRow(
      `${F.MARK}${accent(glyph("phase"))} ${bold(text(done ? "done" : "not done"))}`,
      faint(`${close.met} of ${close.total}`),
    ),
  );
  rows.push("");
  for (const row of close.rows) {
    const paint = row.rung === "verified" ? (s: string) => accent(s) : (s: string) => muted(s);
    rows.push(...closeRow(row.text, row.rung, row.receipt, width, paint));
  }
  if (!done) {
    rows.push("");
    rows.push(
      `${F.MARK}${faint("criteria without evidence are not met. nothing here was closed by assertion.")}`,
    );
  }
  return rows.join("\n");
}
