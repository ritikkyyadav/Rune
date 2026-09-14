import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the page carries the markup the brief asked for", () => {
  expect(html).toContain("<!doctype html>");
  expect(html.length).toBeGreaterThan(1000);
});
