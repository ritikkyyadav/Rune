import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HELP, main } from "./cli";

const dir = mkdtempSync(join(tmpdir(), "logstats-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const log = join(dir, "app.log");
writeFileSync(
  log,
  [
    "2026-09-29T10:00:00Z INFO server started",
    "2026-09-29T10:00:01Z DEBUG cache warmed",
    "2026-09-29T10:00:02Z WARN slow request /orders",
    "2026-09-29T10:00:03Z ERROR payment gateway timed out",
    "2026-09-29T10:00:04Z INFO request /orders 200",
    "not a log line",
    "",
  ].join("\n"),
);

test("counts every level, then the total", () => {
  const result = main([log]);
  expect(result.code).toBe(0);
  expect(result.stdout.split("\n")).toEqual([
    "DEBUG      1",
    "INFO       2",
    "WARN       1",
    "ERROR      1",
    "TOTAL      5",
    "",
  ]);
});

test("--level counts only that level", () => {
  const result = main(["--level", "INFO", log]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("INFO       2");
  expect(result.stdout).toContain("TOTAL      2");
});

test("--json prints JSON", () => {
  const result = main(["--json", log]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).total).toBe(5);
});

test("--help prints the usage", () => {
  expect(main(["--help"])).toEqual({ code: 0, stdout: HELP, stderr: "" });
});

test("an unknown option is refused", () => {
  const result = main(["--nope", log]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("unknown option: --nope");
});
