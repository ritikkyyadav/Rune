// Acceptance for `off-by-one-window`. Run by the runtime, never shown to the model.
import { createHash } from "node:crypto";
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
const SUPPLIED_TEST_SHA256 = "64640ce6a020413b43cab07fa265ae4312fed48b34cd71f3228f4de6fc8044b8";
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const load = async () => (await import(pathToFileURL(join(root, "window.ts")).href)).slidingMax;

const checks = {
  async windows() {
    const slidingMax = await load();
    assert.deepEqual(slidingMax([1, 3, 2, 5, 4], 3), [3, 5, 5]);
    assert.deepEqual(slidingMax([2], 1), [2]);
    assert.deepEqual(slidingMax([5, 1, 5], 3), [5]);
  },
  async edges() {
    const slidingMax = await load();
    assert.deepEqual(slidingMax([1, 2], 3), []);
    assert.throws(() => slidingMax([1, 2], 0));
    assert.throws(() => slidingMax([1, 2], 2.5));
  },
  async testUntouched() {
    const digest = createHash("sha256")
      .update(readFileSync(join(root, "window.test.ts")))
      .digest("hex");
    assert.equal(digest, SUPPLIED_TEST_SHA256, "the supplied test file was modified");
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
