import { CATALOG } from "./catalog.js";

// Volume discounts, keyed by the quantity at which each tier starts.
const TIERS = [
  { from: 10, off: 0.15 },
  { from: 5, off: 0.08 },
];

/**
 * The total for a cart, in cents, as a plain number.
 *
 * This is the interface every caller is built on today, and it is the one the
 * migration replaces.
 */
export function computeTotal(items) {
  let total = 0;
  for (const { sku, qty } of items) {
    const line = CATALOG[sku];
    if (!line) continue;
    const tier = TIERS.find((t) => qty >= t.from);
    const gross = line.cents * qty;
    total += Math.round(gross * (1 - (tier?.off ?? 0)));
  }
  return total;
}
