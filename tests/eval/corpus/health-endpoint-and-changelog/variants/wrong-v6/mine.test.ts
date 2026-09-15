import { expect, test } from "bun:test";
import { handle } from "./server";

test("health responds", async () => {
  const response = handle(new Request("http://localhost/health"));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("ok");
});
