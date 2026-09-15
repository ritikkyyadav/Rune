import { CATALOG } from "./catalog.js";
import { discountCents, roundCents } from "./rules.js";

/**
 * Step 1: the interface every later step is built on.
 *
 *   priceFor(sku, qty) -> Money { cents: number, currency: string }
 *
 * A Money OBJECT, not a number of cents. That is the whole point of the
 * migration — the old `computeTotal` returned a bare number and every caller
 * had to remember which unit it was in.
 */
export function priceFor(sku, qty) {
  const line = CATALOG[sku];
  if (!line) return { cents: 0, currency: "USD" };
  const gross = roundCents(line.cents * qty);
  return { cents: gross - discountCents(gross, qty), currency: "USD" };
}

/** Money is added as Money. */
export function addMoney(a, b) {
  return { cents: a.cents + b.cents, currency: a.currency };
}

export function formatMoney(money) {
  return `$${(money.cents / 100).toFixed(2)} ${money.currency}`;
}
