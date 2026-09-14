import { expect, test } from "bun:test";
import { parseCsv } from "./csv";

test("commas inside quotes stay together", () => {
  expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
  expect(parseCsv("x,y")).toEqual([["x", "y"]]);
});
