import { computeTotal } from "./pricing.js";

/** One line of summary for a cart, for the order confirmation screen. */
export function summarise(cart) {
  const total = computeTotal(cart.items);
  return `Total: $${(total / 100).toFixed(2)}`;
}
