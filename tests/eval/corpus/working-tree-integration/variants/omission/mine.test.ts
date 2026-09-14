import { expect, test } from "bun:test";
import { summarizeOrders } from "./orders";

test("refunded rows are ignored and minor units add up", () => {
  expect(
    summarizeOrders([
      { currency: "USD", amount: "0.10" },
      { currency: "USD", amount: "0.20" },
    ]),
  ).toEqual({
    USD: { count: 2, totalMinor: 30 },
  });
});
