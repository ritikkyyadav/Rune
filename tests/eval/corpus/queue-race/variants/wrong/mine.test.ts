import { expect, test } from "bun:test";
import { mapLimit } from "./queue";

test("every item is processed once", async () => {
  const out = await mapLimit([1, 2, 3], 3, async (item) => item * 2);
  expect(out.sort((a, b) => a - b)).toEqual([2, 4, 6]);
});
