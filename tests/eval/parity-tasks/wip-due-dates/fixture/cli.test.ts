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
