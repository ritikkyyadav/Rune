// Acceptance for `cache-plan`. Run by the runtime, never shown to the model.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const SOURCE_SHA256 = "117791f1b331e4f22d95962d866d10cef4b159b16b045135f0ebecf465460c58";
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");

const checks = {
  // Three steps, each naming a file it touches and how it will be checked.
  // Whether the plan is GOOD is a person's judgement; this is its shape.
  steps() {
    const text = readFileSync(join(root, "PLAN.md"), "utf8");
    const steps = text.split(/^#{1,6}\s*(?:step\s*)?\d+\b/im).slice(1);
    assert.ok(steps.length >= 3, `the plan has ${steps.length} numbered steps, fewer than three`);
    steps.forEach((step, index) => {
      assert.match(
        step,
        /[\w./-]+\.(?:ts|tsx|js|mjs|json|md)\b/i,
        `step ${index + 1} names no file`,
      );
      assert.match(
        step,
        /verif|test|check|measur/i,
        `step ${index + 1} says nothing about verification`,
      );
    });
  },
  sourceUntouched() {
    const digest = createHash("sha256")
      .update(readFileSync(join(root, "fetcher.ts")))
      .digest("hex");
    assert.equal(digest, SOURCE_SHA256, "fetcher.ts was modified by a task that asked for a plan");
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
