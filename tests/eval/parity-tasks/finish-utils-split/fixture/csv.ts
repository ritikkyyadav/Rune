import { formatAmount } from "./utils";

/** Category totals as CSV: a `category,total` header, then one row per category. */
export function totalsCsv(totals: Map<string, number>): string {
  const rows = [...totals].map(([category, cents]) => `${category},${formatAmount(cents)}`);
  return `${["category,total", ...rows].join("\n")}\n`;
}
