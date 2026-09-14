import { expect, test } from "bun:test";
import { tokenize } from "./tokens";
import { buildRecord } from "./build";
import { report } from "./report";

test("the pipeline carries typed tokens end to end", () => {
  expect(tokenize("alpha 1 2")).toEqual([
    { kind: "word", value: "alpha" },
    { kind: "number", value: "1" },
    { kind: "number", value: "2" },
  ]);
  expect(buildRecord(tokenize("alpha 1 2"))).toEqual({ name: "alpha", values: [1, 2] });
  expect(report("alpha 1 2 3")).toBe("alpha: 6 over 3");
});
