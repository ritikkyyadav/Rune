import { expect, test } from "bun:test";
import { report } from "./report";

test("the report still reads", () => {
  expect(report("alpha 1 2 3")).toBe("alpha: 6 over 3");
});
