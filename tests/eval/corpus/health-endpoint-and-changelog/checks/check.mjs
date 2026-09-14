// Acceptance for `health-endpoint-and-changelog`. Run by the runtime, never shown to the model.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const load = async () => (await import(pathToFileURL(join(root, "server.ts")).href)).handle;

const checks = {
  async health() {
    const handle = await load();
    const response = await handle(new Request("http://localhost/health"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptimeMs, "number");
  },
  async unknown() {
    const handle = await load();
    assert.equal((await handle(new Request("http://localhost/nope"))).status, 404);
    assert.equal((await handle(new Request("http://localhost/"))).status, 200);
  },
  async changelog() {
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const unreleased = text.split(/^##\s+/m).find((section) => /^Unreleased/i.test(section)) ?? "";
    assert.match(unreleased, /health/i, "the Unreleased section does not mention the health route");
  },
};

const run = checks[which];
if (!run) {
  console.log(`acceptance failed: unknown criterion ${which}`);
  process.exit(1);
}
try {
  await run();
  console.log(`acceptance ok: ${which}`);
  process.exit(0);
} catch (error) {
  console.log(`acceptance failed: ${which} — ${safe(error?.message ?? error)}`);
  process.exit(1);
}
