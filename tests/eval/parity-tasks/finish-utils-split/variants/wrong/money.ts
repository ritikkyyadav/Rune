/** Money helpers. */

/** Format an amount in cents as dollars with two decimals, e.g. 1250 → "12.50". */
export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
