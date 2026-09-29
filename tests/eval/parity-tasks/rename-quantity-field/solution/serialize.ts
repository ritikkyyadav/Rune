import type { Order } from "./order";

/** The saved form of an order: pretty-printed JSON, each item's fields in a fixed order. */
export function toJson(order: Order): string {
  const items = order.items.map((item) => ({
    sku: item.sku,
    quantity: item.quantity,
    unitCents: item.unitCents,
  }));
  return `${JSON.stringify({ id: order.id, items }, null, 2)}\n`;
}
