import { expect, test } from "bun:test";

import { lineCents, orderCents, type Order } from "./order";
import { fromJson } from "./parse";
import { toCsv } from "./report";
import { toJson } from "./serialize";

const order: Order = {
  id: "A-1001",
  items: [
    { sku: "PEN-BLK", quantity: 3, unitCents: 150 },
    { sku: "NOTE-A5", quantity: 1, unitCents: 1299 },
  ],
};

test("a line costs its quantity times its unit price", () => {
  expect(lineCents(order.items[0]!)).toBe(450);
  expect(orderCents(order)).toBe(1749);
});

test("an order survives a save and a load", () => {
  expect(fromJson(toJson(order))).toEqual(order);
});

test("the saved form is stable, field by field", () => {
  expect(JSON.parse(toJson(order)).items[0]).toEqual({
    sku: "PEN-BLK",
    quantity: 3,
    unitCents: 150,
  });
});

test("an order saved before the rename still loads", () => {
  const saved = JSON.stringify({ id: "A-1", items: [{ sku: "PEN-BLK", qty: 2, unitCents: 150 }] });
  expect(fromJson(saved)).toEqual({
    id: "A-1",
    items: [{ sku: "PEN-BLK", quantity: 2, unitCents: 150 }],
  });
});

test("a malformed line is refused, naming the field", () => {
  const saved = JSON.stringify({
    id: "A-1",
    items: [{ sku: "PEN-BLK", quantity: 0, unitCents: 150 }],
  });
  expect(() => fromJson(saved)).toThrow(/quantity/);
  const legacy = JSON.stringify({ id: "A-1", items: [{ sku: "PEN-BLK", qty: 0, unitCents: 150 }] });
  expect(() => fromJson(legacy)).toThrow(/quantity/);
});

test("the CSV has a header, a row per line and the total", () => {
  expect(toCsv(order).split("\n")).toEqual([
    "sku,quantity,unit_price,line_total",
    "PEN-BLK,3,1.50,4.50",
    "NOTE-A5,1,12.99,12.99",
    "TOTAL,,,17.49",
    "",
  ]);
});

test("an empty order totals zero", () => {
  const empty: Order = { id: "A-0", items: [] };
  expect(orderCents(empty)).toBe(0);
  expect(toCsv(empty)).toBe("sku,quantity,unit_price,line_total\nTOTAL,,,0.00\n");
});
