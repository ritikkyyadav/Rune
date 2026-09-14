import { expect, test } from "bun:test";
import { tokenize } from "./tokens";
import { buildRecord } from "./build";

test("tokens are typed and the builder consumes them", () => {
  expect(tokenize("alpha 1")[0]).toEqual({ kind: "word", value: "alpha" });
  expect(buildRecord(tokenize("alpha 1 2"))).toEqual({ name: "alpha", values: [1, 2] });
});
