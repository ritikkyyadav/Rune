import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save, upsert } from "./store";

test("a missing file is an empty v2 store, and a v1 file migrates", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "notes-"));
  try {
    const path = join(scratch, "nested", "notes.json");
    expect(await load(path)).toEqual({ version: 2, notes: [] });
    await save(path, { version: 2, notes: [{ id: "a", text: "one", tags: [] }] });
    expect((await load(path)).notes).toHaveLength(1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("upsert does not mutate and normalizes tags", () => {
  const before = { version: 2 as const, notes: [{ id: "a", text: "old", tags: [] }] };
  const frozen = JSON.stringify(before);
  const next = upsert(before, { id: "a", text: "new", tags: [" z ", "a", "a"] });
  expect(JSON.stringify(before)).toBe(frozen);
  expect(next.notes).toEqual([{ id: "a", text: "new", tags: ["a", "z"] }]);
});
