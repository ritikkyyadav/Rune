import { expect, test } from "bun:test";
import { mapLimit } from "./queue";

test("every item is processed once, in order", async () => {
  const seen: number[] = [];
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 3, async (item) => {
    seen.push(item);
    await Bun.sleep(1);
    return item * 2;
  });
  expect(out).toEqual([2, 4, 6, 8, 10, 12]);
  expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
});
