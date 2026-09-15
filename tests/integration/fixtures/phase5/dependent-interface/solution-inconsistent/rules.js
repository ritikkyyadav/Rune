// Step 2: the pricing rules moved here, out of pricing.js.

// Volume discounts, keyed by the quantity at which each tier starts.
const TIERS = [
  { from: 10, off: 0.15 },
  { from: 5, off: 0.08 },
];

export function roundCents(value) {
  return Math.round(value);
}

/** What comes off a line of `qty` units costing `grossCents`, in cents. */
export function discountCents(grossCents, qty) {
  const tier = TIERS.find((t) => qty >= t.from);
  return roundCents(grossCents * (tier?.off ?? 0));
}
