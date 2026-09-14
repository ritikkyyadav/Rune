import { expect, test } from "bun:test";
import { createNote } from "./notes";

test("tags default to empty", () => {
  expect(createNote("a", "hello").tags).toEqual([]);
  expect(createNote("a", "hello", ["x"]).tags).toEqual(["x"]);
});
