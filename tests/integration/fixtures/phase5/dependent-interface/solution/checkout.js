import { addMoney, formatMoney, priceFor } from "./pricing.js";

/**
 * Step 3: the caller, built on step 1's interface as step 1 actually exposes
 * it — a Money object, summed as Money and formatted once.
 */
export function summarise(cart) {
  const total = cart.items.reduce((acc, { sku, qty }) => addMoney(acc, priceFor(sku, qty)), {
    cents: 0,
    currency: "USD",
  });
  return `Total: ${formatMoney(total)}`;
}
