import { parseMinor } from "./money";

export interface Order {
  currency: string;
  amount: string;
  refunded?: boolean;
}

export function summarizeOrders(
  rows: Order[],
): Record<string, { count: number; totalMinor: number }> {
  const out: Record<string, { count: number; totalMinor: number }> = {};
  for (const row of rows) {
    // TODO: refunds, currency validation and the safe-integer guard.
    const bucket = (out[row.currency] ??= { count: 0, totalMinor: 0 });
    bucket.count += 1;
    bucket.totalMinor += parseMinor(row.amount);
  }
  return out;
}
