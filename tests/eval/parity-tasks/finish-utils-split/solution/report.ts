import { formatAmount } from "./money";
import { padLeft, padRight } from "./text";

/** Category totals as an aligned table, then the grand total. */
export function report(totals: Map<string, number>): string {
  const width = Math.max(8, ...[...totals.keys()].map((category) => category.length));
  const row = (label: string, cents: number) =>
    `${padRight(label, width)}  ${padLeft(formatAmount(cents), 10)}`;
  const all = [...totals.values()].reduce((sum, cents) => sum + cents, 0);
  return `${[...[...totals].map(([category, cents]) => row(category, cents)), row("TOTAL", all)].join("\n")}\n`;
}
