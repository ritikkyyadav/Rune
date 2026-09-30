import { expect, test } from "bun:test";

import { totalsCsv } from "./csv";
import { parseExpenses, totalsByCategory } from "./expenses";
import { report } from "./report";
import { formatAmount } from "./utils";

const SAMPLE = [
  "date,category,amount",
  "2026-09-01,food,12.50",
  "2026-09-02,travel,40.00",
  "2026-09-03,food,7.25",
  "2026-09-04,books,19.99",
  "",
].join("\n");

test("amounts are parsed into cents", () => {
  expect(parseExpenses(SAMPLE).map((expense) => expense.cents)).toEqual([1250, 4000, 725, 1999]);
});

test("totals by category, the largest first", () => {
  expect([...totalsByCategory(parseExpenses(SAMPLE))]).toEqual([
    ["travel", 4000],
    ["books", 1999],
    ["food", 1975],
  ]);
});

test("the report is an aligned table with a total", () => {
  expect(report(totalsByCategory(parseExpenses(SAMPLE)))).toBe(
    [
      "travel         40.00",
      "books          19.99",
      "food           19.75",
      "TOTAL          79.74",
      "",
    ].join("\n"),
  );
});

test("the CSV has one row per category", () => {
  expect(totalsCsv(totalsByCategory(parseExpenses(SAMPLE)))).toBe(
    "category,total\ntravel,40.00\nbooks,19.99\nfood,19.75\n",
  );
});

test("a refund is a negative amount", () => {
  expect(formatAmount(-5)).toBe("-0.05");
  expect(formatAmount(-1250)).toBe("-12.50");
});
