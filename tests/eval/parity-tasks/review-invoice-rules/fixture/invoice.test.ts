import { expect, test } from "bun:test";

import { applyDiscount, formatCents, invoiceTotal, lineTotal, taxFor } from "./invoice";

test("a line is its quantity times its unit price", () => {
  expect(lineTotal({ description: "Pens", quantity: 3, unitCents: 150 })).toBe(450);
});

test("a negative quantity is refused", () => {
  expect(() => lineTotal({ description: "Pens", quantity: -1, unitCents: 150 })).toThrow(
    RangeError,
  );
});

test("a discount comes off the subtotal", () => {
  expect(applyDiscount(10_000, 15)).toBe(8_500);
  expect(() => applyDiscount(10_000, 101)).toThrow(RangeError);
});

test("tax is rounded half up to the cent", () => {
  expect(taxFor(1_000, 825)).toBe(83);
  expect(taxFor(1_000, 0)).toBe(0);
});

test("with no discount, the total is the lines plus tax", () => {
  const lines = [
    { description: "Notebook", quantity: 2, unitCents: 1_250 },
    { description: "Pens", quantity: 1, unitCents: 480 },
  ];
  expect(invoiceTotal(lines, 0, 1_000)).toBe(2_980 + 298);
});

test("amounts display with a thousands separator, refunds with a minus sign", () => {
  expect(formatCents(123_405)).toBe("$1,234.05");
  expect(formatCents(-105)).toBe("-$1.05");
  expect(formatCents(0)).toBe("$0.00");
});
