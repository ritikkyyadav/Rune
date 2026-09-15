// Acceptance for `health-endpoint-and-changelog`. Run by the runtime, never shown to the model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// The acceptance script is STAGED OUTSIDE the workspace and run with cwd set
// to the workspace (see rune-cli's --acceptance help). A path resolved from
// import.meta.url would point at the staging directory, not at the tree under
// test, so the tree is addressed through the working directory.
const root = process.cwd();
const which = process.argv[2];
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const load = async () => (await import(pathToFileURL(join(root, "server.ts")).href)).handle;

const checks = {
  async health() {
    // `startedAt` is stamped when the module is imported, so the elapsed time
    // since this line bounds any honest uptime.
    const importedAt = Date.now();
    const handle = await load();
    const response = await handle(new Request("http://localhost/health"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptimeMs, "number");
    // "<milliseconds since startedAt>" — not the wall clock. Returning
    // `Date.now()` (≈1.7e12) satisfied "is a number" and nothing else.
    assert.ok(
      body.uptimeMs >= 0 && body.uptimeMs <= Date.now() - importedAt + 5_000,
      `uptimeMs is ${body.uptimeMs}, which is not milliseconds since startedAt`,
    );
  },
  async unknown() {
    const handle = await load();
    assert.equal((await handle(new Request("http://localhost/nope"))).status, 404);
    assert.equal((await handle(new Request("http://localhost/"))).status, 200);
  },
  async changelog() {
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const unreleased = text.split(/^##\s+/m).find((section) => /^Unreleased/i.test(section)) ?? "";
    // The ROUTE, not the word. "Renamed the internal healthCheck helper. No
    // routes were added or changed." matched /health/i and recorded the
    // opposite of what happened.
    assert.match(
      unreleased,
      /\/health\b/,
      "the Unreleased section does not record the /health route",
    );
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
