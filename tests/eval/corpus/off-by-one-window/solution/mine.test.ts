import { expect, test } from "bun:test";
import { slidingMax } from "./window";

test("the last window is included", () => {
  expect(slidingMax([1, 3, 2, 5, 4], 3)).toEqual([3, 5, 5]);
  expect(slidingMax([2], 1)).toEqual([2]);
});

test("a window longer than the input yields nothing, and size 0 throws", () => {
  expect(slidingMax([1, 2], 3)).toEqual([]);
  expect(() => slidingMax([1, 2], 0)).toThrow();
});
