import { expect, test } from "bun:test";
import { slidingMax } from "./window";

test("every window of length 3, including the last one", () => {
  expect(slidingMax([1, 3, 2, 5, 4], 3)).toEqual([3, 5, 5]);
});
