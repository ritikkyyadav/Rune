/** The order model. Every amount is an integer number of cents. */

export interface LineItem {
  sku: string;
  quantity: number;
  unitCents: number;
}

export interface Order {
  id: string;
  items: LineItem[];
}

/** Cents for one line: its quantity times its unit price. */
export function lineCents(item: LineItem): number {
  return item.quantity * item.unitCents;
}

/** Cents for the whole order. */
export function orderCents(order: Order): number {
  return order.items.reduce((sum, item) => sum + lineCents(item), 0);
}
