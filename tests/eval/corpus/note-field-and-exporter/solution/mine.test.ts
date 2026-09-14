import { expect, test } from "bun:test";
import { createNote } from "./notes";
import { toCsv } from "./export-csv";

test("tags default to empty and reach the export", () => {
  expect(createNote("a", "hello").tags).toEqual([]);
  expect(toCsv([createNote("a", "hello", ["x", "y"])])).toBe("id,text,tags\na,hello,x;y\n");
});
