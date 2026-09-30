import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./cli";

const dir = mkdtempSync(join(tmpdir(), "todo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let lists = 0;
const fresh = () => join(dir, `todos-${++lists}.json`);

test("add, then list", () => {
  const file = fresh();
  expect(run(["add", "Buy", "milk"], file)).toEqual({ code: 0, stdout: "added 1\n", stderr: "" });
  run(["add", "Call the bank"], file);
  expect(run(["list"], file).stdout).toBe("[ ] 1. Buy milk\n[ ] 2. Call the bank\n");
});

test("done marks one todo and saves it", () => {
  const file = fresh();
  run(["add", "Water the plants"], file);
  expect(run(["done", "1"], file).code).toBe(0);
  expect(run(["list"], file).stdout).toBe("[x] 1. Water the plants\n");
  expect(JSON.parse(readFileSync(file, "utf8"))[0].done).toBe(true);
});

test("an unknown id is an error, and nothing is saved", () => {
  const file = fresh();
  run(["add", "Pay rent"], file);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "7"], file)).toEqual({ code: 1, stdout: "", stderr: "no todo with id 7\n" });
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("an unknown command prints the usage", () => {
  expect(run(["nope"], fresh()).code).toBe(2);
});

test("due sets a date, saves it, and list shows it", () => {
  const file = fresh();
  run(["add", "File taxes"], file);
  run(["add", "Renew passport"], file);
  expect(run(["due", "1", "2026-10-15"], file).code).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))[0].due).toBe("2026-10-15");
  expect(run(["list"], file).stdout).toBe(
    "[ ] 1. File taxes (due 2026-10-15)\n[ ] 2. Renew passport\n",
  );
});

test("a date that is not a real day, or an unknown id, is refused and nothing is saved", () => {
  const file = fresh();
  run(["add", "File taxes"], file);
  const before = readFileSync(file, "utf8");
  for (const args of [
    ["due", "1", "2026-02-30"],
    ["due", "1", "15/10/2026"],
    ["due", "4", "2026-10-15"],
  ]) {
    const result = run(args, file);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe("");
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});
