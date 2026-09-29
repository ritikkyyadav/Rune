import type { LineItem, Order } from "./order";

/** Read an order saved by toJson. Anything malformed throws, naming the field. */
export function fromJson(text: string): Order {
  const data = JSON.parse(text) as { id?: unknown; items?: unknown };
  if (typeof data.id !== "string") throw new Error("order id must be a string");
  if (!Array.isArray(data.items)) throw new Error("order items must be a list");
  return { id: data.id, items: data.items.map(readItem) };
}

function readItem(raw: unknown, index: number): LineItem {
  const { sku, qty, unitCents } = (raw ?? {}) as Record<string, unknown>;
  if (typeof sku !== "string" || sku === "")
    throw new Error(`item ${index}: sku must be a non-empty string`);
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1)
    throw new Error(`item ${index}: qty must be a whole number of at least 1`);
  if (typeof unitCents !== "number" || !Number.isInteger(unitCents) || unitCents < 0)
    throw new Error(`item ${index}: unitCents must be a whole number of cents`);
  return { sku, qty, unitCents };
}
