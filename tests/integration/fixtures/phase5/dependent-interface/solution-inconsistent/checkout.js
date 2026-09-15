import { priceFor } from "./pricing.js";

/**
 * Step 3, written against the interface step 1 was ASSUMED to expose: a bare
 * number of cents. Step 1 exposes a Money object. Nothing here is a syntax
 * error, nothing here throws, and the page renders — it renders "Total: $NaN".
 *
 * This is the late architectural inconsistency the acceptance has to catch.
 */
export function summarise(cart) {
  let total = 0;
  for (const { sku, qty } of cart.items) {
    total += priceFor(sku, qty);
  }
  return `Total: $${(total / 100).toFixed(2)}`;
}
