import { expect, test } from "bun:test";
import { createNote } from "./notes";
import { toCsv } from "./export-csv";

test("the header gains a tags column", () => {
  expect(toCsv([createNote("a", "hello")]).split("\n")[0]).toBe("id,text,tags");
});
