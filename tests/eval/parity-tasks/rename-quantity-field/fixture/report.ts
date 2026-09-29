import { lineCents, orderCents, type Order } from "./order";

/** 1250 → "12.50". Amounts in a report are never negative. */
const dollars = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** The order as CSV: a header, one row per line item, then the total. */
export function toCsv(order: Order): string {
  const rows = order.items.map((item) =>
    [item.sku, item.qty, dollars(item.unitCents), dollars(lineCents(item))].join(","),
  );
  const lines = ["sku,qty,unit_price,line_total", ...rows, `TOTAL,,,${dollars(orderCents(order))}`];
  return `${lines.join("\n")}\n`;
}
