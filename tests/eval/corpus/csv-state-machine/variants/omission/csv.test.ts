import { expect, test } from "bun:test";
import { parseCsv } from "./csv";

test("fields and quotes", () => {
  expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
  expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
});
