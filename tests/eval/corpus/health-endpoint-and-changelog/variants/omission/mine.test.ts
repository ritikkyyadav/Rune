import { expect, test } from "bun:test";
import { handle } from "./server";

test("health responds with JSON", async () => {
  const response = handle(new Request("http://localhost/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
});

test("unknown paths still 404", () => {
  expect(handle(new Request("http://localhost/nope")).status).toBe(404);
});
