// Acceptance for `three-module-dependent`. Run by the runtime, never shown to the model.
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
const load = async (file, name) => (await import(pathToFileURL(join(root, file)).href))[name];

const checks = {
  // Step 1's stated interface. Step 3's check below passes without it, which is
  // the late inconsistency this task exists to expose.
  async tokens() {
    const tokenize = await load("tokens.ts", "tokenize");
    assert.deepEqual(tokenize("alpha 1 2"), [
      { kind: "word", value: "alpha" },
      { kind: "number", value: "1" },
      { kind: "number", value: "2" },
    ]);
    assert.deepEqual(tokenize("  "), []);
  },
  async builder() {
    const tokenize = await load("tokens.ts", "tokenize");
    const buildRecord = await load("build.ts", "buildRecord");
    assert.deepEqual(buildRecord(tokenize("alpha 1 2")), { name: "alpha", values: [1, 2] });
    assert.deepEqual(buildRecord(tokenize("beta -2 3.5")), { name: "beta", values: [-2, 3.5] });
  },
  async report() {
    const report = await load("report.ts", "report");
    assert.equal(report("alpha 1 2 3"), "alpha: 6 over 3");
    assert.equal(report("beta"), "beta: 0 over 0");
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
