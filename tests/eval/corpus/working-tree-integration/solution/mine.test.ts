import { expect, test } from "bun:test";
import { summarizeOrders } from "./orders";

test("refunded rows are ignored and minor units add up", () => {
  expect(summarizeOrders([])).toEqual({});
  expect(
    summarizeOrders([
      { currency: "USD", amount: "0.10" },
      { currency: "USD", amount: "0.20" },
      { currency: "XXX", amount: "bad", refunded: true },
    ]),
  ).toEqual({ USD: { count: 2, totalMinor: 30 } });
});

test("an invalid currency throws", () => {
  expect(() => summarizeOrders([{ currency: "usd", amount: "1" }])).toThrow();
});
