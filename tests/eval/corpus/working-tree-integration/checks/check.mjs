// Acceptance for `working-tree-integration`. Run by the runtime, never shown to the model.
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
const MONEY_SHA256 = "5149aab241daf0ddb2153790ba8ddf18fca24212c8620a8a9a2b32138b1626d1";
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const load = async () =>
  (await import(pathToFileURL(join(root, "orders.ts")).href)).summarizeOrders;

const checks = {
  async summary() {
    const s = await load();
    assert.deepEqual(s([]), {});
    assert.deepEqual(
      s([
        { currency: "USD", amount: "0.10" },
        { currency: "USD", amount: "0.20" },
        { currency: "EUR", amount: "-2.50" },
        { currency: "EUR", amount: "0" },
        { currency: "XXX", amount: "bad", refunded: true },
      ]),
      { USD: { count: 2, totalMinor: 30 }, EUR: { count: 2, totalMinor: -250 } },
    );
  },
  async rejects() {
    const s = await load();
    assert.throws(
      () => s([{ currency: "usd", amount: "1" }]),
      undefined,
      "an invalid currency must throw",
    );
    assert.throws(
      () => s([{ currency: "USD", amount: "1.234" }]),
      undefined,
      "a three-decimal amount must throw",
    );
    assert.throws(
      () =>
        s([
          { currency: "USD", amount: "90071992547409.9" },
          { currency: "USD", amount: "0.03" },
        ]),
      undefined,
      "an unsafe total must throw",
    );
  },
  // The whole point of the fixture: money.ts arrived in the working tree
  // untracked, and the task said not to change it.
  protectedApi() {
    const digest = createHash("sha256")
      .update(readFileSync(join(root, "money.ts")))
      .digest("hex");
    assert.equal(digest, MONEY_SHA256, "the protected working-tree API was modified");
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
