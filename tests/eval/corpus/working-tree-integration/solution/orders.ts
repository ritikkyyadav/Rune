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
    if (row.refunded) continue;
    if (!/^[A-Z]{3}$/.test(row.currency)) throw new Error("invalid currency");
    const minor = parseMinor(row.amount);
    const bucket = (out[row.currency] ??= { count: 0, totalMinor: 0 });
    bucket.count += 1;
    bucket.totalMinor += minor;
    if (!Number.isSafeInteger(bucket.totalMinor)) throw new Error("unsafe total");
  }
  return out;
}
