/** Invoice arithmetic. The rules it has to follow are in README.md. */

export interface Line {
  description: string;
  quantity: number;
  unitCents: number;
}

/** A line's total: its quantity times its unit price. */
export function lineTotal(line: Line): number {
  if (line.quantity < 0) throw new RangeError(`invalid quantity: ${line.quantity}`);
  return line.quantity * line.unitCents;
}

/** The subtotal after a percentage discount. */
export function applyDiscount(subtotalCents: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError(`invalid discount: ${percent}%`);
  return subtotalCents - Math.floor((subtotalCents * percent) / 100);
}

/** Tax on an amount. The rate is in basis points, so 825 is 8.25%. */
export function taxFor(amountCents: number, rateBps: number): number {
  if (rateBps < 0) throw new RangeError(`invalid tax rate: ${rateBps}`);
  return Math.round((amountCents * rateBps) / 10_000);
}

/** What the customer pays for `lines`, after the discount and with tax. */
export function invoiceTotal(lines: Line[], discountPercent: number, taxRateBps: number): number {
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const tax = taxFor(subtotal, taxRateBps);
  return applyDiscount(subtotal, discountPercent) + tax;
}

/** An amount for display: "$1,234.05", or "-$1.05" for a negative one. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
