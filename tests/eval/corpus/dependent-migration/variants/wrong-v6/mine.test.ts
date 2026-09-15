import { expect, test } from "bun:test";
import { upsert } from "./store";

test("upsert replaces an id", () => {
  const next = upsert(
    { version: 2 as const, notes: [{ id: "a", text: "old", tags: [] }] },
    { id: "a", text: "new" },
  );
  expect(next.notes).toHaveLength(1);
  expect(next.notes[0]!.text).toBe("new");
});
