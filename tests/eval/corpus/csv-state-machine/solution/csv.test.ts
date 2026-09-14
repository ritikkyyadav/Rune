import { expect, test } from "bun:test";
import { parseCsv } from "./csv";

test("empty input and trailing terminators", () => {
  expect(parseCsv("")).toEqual([]);
  expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
  expect(parseCsv("a,,c\n\n")).toEqual([["a", "", "c"], [""]]);
});

test("quoted fields", () => {
  expect(parseCsv('"a,b","x""y",z')).toEqual([["a,b", 'x"y', "z"]]);
  expect(parseCsv('"a\r\nb",c')).toEqual([["a\r\nb", "c"]]);
});

test("an unterminated quoted field throws", () => {
  expect(() => parseCsv('"unfinished')).toThrow();
});
