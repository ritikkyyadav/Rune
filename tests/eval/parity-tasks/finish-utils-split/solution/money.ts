/** Money. Every amount is an integer number of cents; a refund is negative. */

/** Cents as a plain decimal amount: 1250 → "12.50", -5 → "-0.05". */
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
