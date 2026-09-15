// Pricing rules live here eventually. Today the tiers are still inside
// pricing.js and this module only holds the rounding policy.

export function roundCents(value) {
  return Math.round(value);
}
